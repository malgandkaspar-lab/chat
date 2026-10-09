// Downloads the sources listed in sources.json and builds the search index in data/.
//   node ingest.js             download what is missing, then (re)build the index
//   node ingest.js --refresh   download everything again
//   node ingest.js --limit 20  only the first 20 pages of each site (for a quick trial)
//   node ingest.js --download-only   fetch pages and files, do not build the index
//   node ingest.js --all       index every topic, ignoring the "focus" set in sources.json
//   node ingest.js --cloud     build the index the Vercel deployment uses (data/cloud/),
//                              embedding through Vercel AI Gateway instead of Ollama
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { parseHtml, parsePdf, parseXlsx, parseCsv } = require('./lib/extract');
const { chunkText } = require('./lib/chunk');
const { loadIndex, saveIndex } = require('./lib/search');
const { PROVIDER, CLOUD_INDEX, embedModel, embed } = require('./lib/models');

const EMBED_MODEL = embedModel();
const sources = require('./sources.json');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const FILES_DIR = path.join(DATA_DIR, 'files');
const USER_AGENT = 'vestlus-indekseerija/1.0 (isiklik kasutus)';
const DELAY_MS = 350; // pause after every request to one site
const EMBED_BATCH = PROVIDER === 'ollama' ? 16 : 64;
const CHECKPOINT = EMBED_BATCH * 30; // passages between progress lines and partial saves
const MIN_TEXT = 100; // shorter pages and sections carry nothing worth quoting

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const DOWNLOAD_ONLY = args.includes('--download-only');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
const skipPatterns = sources.skip.map((pattern) => new RegExp(pattern));

// With a focus, only material on that topic is indexed: whole documents that are about it
// (keyword in the title, or keywords throughout the text), and from other documents just
// the passages that mention it. Sources listed under "always" are taken in full.
const focus = sources.focus && !args.includes('--all') ? sources.focus : null;
const focusPattern = focus
  ? new RegExp(`(?<!\\p{L})(?!${focus.exclude.join('|')})(?:${focus.keywords.join('|')})\\p{L}*`, 'giu')
  : null;
const focusHits = (text) => (text.match(focusPattern) || []).length;
const FOCUS_DOC_HITS = 4; // a document is on topic with this many keyword hits ...
const FOCUS_DOC_DENSITY = 2; // ... and at least this many per 1000 characters
const FOCUS_PASSAGE_HITS = 2; // a single passage from another document needs this many

class Blocked extends Error {}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'et' },
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
      if (attempt >= 3) throw error;
      await sleep(3000 * attempt);
      continue;
    }
    // A bot check means the site does not want automated reading: stop instead of working around it.
    if (res.headers.get('cf-mitigated') || res.status === 403) {
      throw new Blocked(`${new URL(url).host} keeldus automaatsest lugemisest (HTTP ${res.status})`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) return res;
      await sleep(10000 * attempt);
      continue;
    }
    return res;
  }
}

async function fetchPage(url) {
  const file = path.join(CACHE_DIR, sha1(url) + '.json.gz');
  if (!REFRESH && fs.existsSync(file)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const res = await download(url);
  await sleep(DELAY_MS);
  // Only lasting outcomes are remembered; a server error is retried on the next run.
  if (![200, 404, 410].includes(res.status)) throw new Error(`HTTP ${res.status}`);
  const page = { url, status: res.status, html: res.status === 200 ? await res.text() : '' };
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(page)));
  return page;
}

async function fetchFile(url) {
  const file = path.join(FILES_DIR, decodeURIComponent(path.basename(new URL(url).pathname)));
  const meta = file + '.meta.json';
  if (REFRESH || !fs.existsSync(file) || !fs.existsSync(meta)) {
    const res = await download(url);
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const modified = res.headers.get('last-modified');
    fs.writeFileSync(meta, JSON.stringify({ url, date: modified ? new Date(modified).toISOString().slice(0, 10) : null }));
    await sleep(DELAY_MS);
  }
  return { file, date: JSON.parse(fs.readFileSync(meta, 'utf8')).date };
}

function pageToDoc(page, source) {
  if (page.status !== 200) return null;
  const parsed = parseHtml(page.html, page.url);
  if (parsed.text.length < MIN_TEXT || /\/lehte-ei-leitud$/.test(parsed.canonical)) return null;
  return {
    source,
    kind: parsed.isNews ? 'uudis' : 'leht',
    url: page.url,
    title: parsed.title,
    date: parsed.date,
    sections: [{ text: parsed.text }],
  };
}

async function crawlSite({ source, sitemap }) {
  const host = new URL(sitemap).host;
  const xml = await (await download(sitemap)).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1].trim())
    .filter((url) => new URL(url).host === host && !skipPatterns.some((pattern) => pattern.test(url)))
    .slice(0, LIMIT);
  console.log(`${source}: ${urls.length} lehte`);

  const docs = [];
  let failed = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const doc = pageToDoc(await fetchPage(urls[i]), source);
      if (doc) docs.push(doc);
    } catch (error) {
      if (error instanceof Blocked) {
        console.error(`${source}: ${error.message}. Jätan ülejäänud lehed vahele.`);
        break;
      }
      failed++;
      console.error(`${source}: ${urls[i]} ebaõnnestus (${error.message})`);
    }
    if ((i + 1) % 100 === 0 || i + 1 === urls.length) console.log(`${source}: ${i + 1}/${urls.length}`);
  }
  console.log(`${source}: ${docs.length} lehte tekstiga${failed ? `, ${failed} ebaõnnestus` : ''}`);
  return docs;
}

async function fileToDoc({ source, title, url }) {
  const { file, date } = await fetchFile(url);
  const doc = { source, url, title, date, sections: [] };
  if (file.toLowerCase().endsWith('.pdf')) {
    doc.kind = 'pdf';
    for (const page of await parsePdf(file)) {
      // A page usually opens with its chapter and table title; later passages of the page repeat it.
      const blocks = page.text.split(/\n{2,}/);
      const opening = blocks.slice(0, 2).join('\n');
      const lead = blocks.length > 2 && opening.length <= 220 ? opening : null;
      doc.sections.push({ label: `lk ${page.number}`, url: `${url}#page=${page.number}`, lead, text: page.text });
    }
  } else if (file.toLowerCase().endsWith('.csv')) {
    doc.kind = 'tabel';
    doc.sections.push({ text: parseCsv(file) });
  } else {
    doc.kind = 'tabel';
    for (const sheet of await parseXlsx(file)) {
      // Sheets are named "1.", "2." ...; the table's own title is its first line.
      const firstLine = sheet.text.split('\n')[0];
      const title = firstLine.length <= 160 && !firstLine.includes(' | ') ? firstLine : null;
      doc.sections.push({ label: title ? `tabel ${sheet.name} ${title}` : `leht ${sheet.name}`, text: sheet.text });
    }
  }
  return doc;
}

async function embedMissing(index, texts) {
  // Passages whose text has not changed keep the vector they already have.
  const previous = REFRESH ? null : loadIndex(CLOUD_INDEX);
  const known = new Map();
  if (previous && previous.model === EMBED_MODEL) {
    previous.chunks.forEach((chunk, i) => known.set(chunk.hash, previous.vectors.subarray(i * previous.dim, (i + 1) * previous.dim)));
  }

  let vectors = null;
  const place = (i, vector) => {
    if (!vectors) {
      index.dim = vector.length;
      vectors = new Float32Array(index.chunks.length * index.dim);
    }
    vectors.set(vector, i * index.dim);
  };

  const todo = [];
  index.chunks.forEach((chunk, i) => {
    const vector = known.get(chunk.hash);
    if (vector) place(i, vector);
    else todo.push(i);
  });
  console.log(`Lõike kokku ${index.chunks.length}, uusi vektoreid vaja ${todo.length}`);

  // Saves the passages finished so far. The chat can already use them, and a run that
  // is interrupted only has to embed the rest next time.
  const savePartial = (remaining) => {
    const missing = new Set(remaining);
    const kept = index.chunks.map((chunk, i) => i).filter((i) => !missing.has(i));
    if (!vectors || !kept.length) return;
    const partial = new Float32Array(kept.length * index.dim);
    kept.forEach((i, n) => partial.set(vectors.subarray(i * index.dim, (i + 1) * index.dim), n * index.dim));
    saveIndex({ ...index, partial: true, chunks: kept.map((i) => index.chunks[i]), vectors: partial }, CLOUD_INDEX);
  };

  const started = Date.now();
  for (let done = 0; done < todo.length; done += EMBED_BATCH) {
    const batch = todo.slice(done, done + EMBED_BATCH);
    let result;
    try {
      result = await embed(batch.map((i) => texts[i]));
    } catch (error) {
      savePartial(todo.slice(done));
      console.error(`Katkes ${done}/${todo.length} juures; tehtud osa on salvestatud, käivita uuesti.`);
      throw error;
    }
    batch.forEach((i, n) => place(i, result[n]));
    const finished = done + batch.length;
    if (finished % CHECKPOINT === 0 || finished === todo.length) {
      const perSecond = finished / ((Date.now() - started) / 1000);
      const minutesLeft = Math.round((todo.length - finished) / perSecond / 60);
      console.log(`Vektorid: ${finished}/${todo.length} (${perSecond.toFixed(1)} lõiku/s, jäänud u ${minutesLeft} min)`);
      if (finished < todo.length) savePartial(todo.slice(finished));
    }
  }
  index.vectors = vectors;
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });

  const perSite = await Promise.all(sources.sites.map(crawlSite));
  const docs = perSite.flat();

  for (const { source, url } of sources.pages) {
    const doc = pageToDoc(await fetchPage(url), source);
    if (doc) docs.push(doc);
    else console.error(`${source}: ${url} jäi tühjaks`);
  }
  for (const entry of sources.files) {
    try {
      const doc = await fileToDoc(entry);
      console.log(`${entry.source}: ${entry.title} (${doc.sections.length} ${doc.kind === 'pdf' ? 'lk' : 'lehte'})`);
      docs.push(doc);
    } catch (error) {
      console.error(`${entry.source}: ${entry.title} ebaõnnestus (${error.message})`);
    }
  }

  if (DOWNLOAD_ONLY) {
    console.log(`Alla laaditud: ${docs.length} dokumenti. Indeksit ei tehtud.`);
    return;
  }

  // Embedding takes hours, so the order decides what the chat can use first:
  // SMI material, then the sites' own pages, then news from newest to oldest.
  const rank = (doc) => (doc.kind === 'uudis' ? 2 : doc.source === 'SMI' ? 0 : 1);
  docs.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? (b.date || '').localeCompare(a.date || '') : 0));

  const index = { model: EMBED_MODEL, dim: 0, built: new Date().toISOString(), focus: focus ? focus.label : null, docs: [], chunks: [] };
  const texts = []; // what gets embedded: the passage with its document title in front
  const seen = new Set();
  for (const { sections, ...doc } of docs) {
    const docNumber = index.docs.length;
    let added = 0;
    let wholeDoc = true;
    if (focus && !focus.always.includes(doc.source)) {
      const body = sections.map((section) => section.text).join('\n');
      const hits = focusHits(body);
      wholeDoc = focusHits(doc.title) > 0 || (hits >= FOCUS_DOC_HITS && (hits / body.length) * 1000 >= FOCUS_DOC_DENSITY);
    }
    for (const section of sections) {
      if (section.text.length < MIN_TEXT) continue;
      const pieces = chunkText(section.text);
      for (let n = 0; n < pieces.length; n++) {
        if (!wholeDoc && focusHits(pieces[n]) < FOCUS_PASSAGE_HITS) continue;
        const text = n && section.lead ? `${section.lead}\n\n${pieces[n]}` : pieces[n];
        const embedText = `${doc.title}${section.label ? ` (${section.label})` : ''}\n${text}`;
        const hash = sha1(embedText);
        if (seen.has(hash)) continue; // the same text published at two addresses
        seen.add(hash);
        index.chunks.push({ doc: docNumber, label: section.label, url: section.url, text, hash });
        texts.push(embedText);
        added++;
      }
    }
    if (added) index.docs.push(doc);
  }

  if (!index.chunks.length) throw new Error('Ühtegi teksti ei leitud, indeksit ei tehtud.');
  if (focus) console.log(`Teema: ${focus.label} (${index.docs.length} dokumenti ${docs.length}-st). Kõige jaoks käivita: node ingest.js --all`);
  await embedMissing(index, texts);
  saveIndex(index, CLOUD_INDEX);
  console.log(`Valmis: ${index.docs.length} dokumenti, ${index.chunks.length} lõiku -> data/${CLOUD_INDEX ? 'cloud/' : ''}index.json (${EMBED_MODEL})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
