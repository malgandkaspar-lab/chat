// Serves the chat page and answers questions from the local search index (data/),
// using the local Ollama server for both the search model and the chat model.
// Run with `node server.js` (add --open to launch the browser).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { embed, loadIndex, indexModifiedAt, search } = require('./lib/search');

const PORT = Number(process.env.PORT) || 3939;
const OLLAMA = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
const PAGE = path.join(__dirname, 'index.html');
const URL_HERE = `http://127.0.0.1:${PORT}`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// How much the chat model gets to read. It manages ~64 tokens/s here, so every passage costs seconds.
const MAX_PASSAGES = 4;
const MAX_SOURCE_CHARS = 3200; // about 1400 tokens, some 25 seconds of reading
// Below this a passage is not about the question. Measured on this index: questions the
// sources cover score 0.62-0.74, unrelated ones (recipes, football, programming) 0.42-0.51.
const MIN_SCORE = 0.55;
const SCORE_WINDOW = 0.08; // passages this much worse than the best one are left out
const SCORE_TIER = 0.04; // scores closer than this count as equally good
// The sites keep news from many years, each stating the figures of its day. Given a 2018 and
// a 2025 figure side by side, the model mixed them up, so older material is dropped when
// equally relevant newer material exists.
const STALE_YEARS = 3;
const FOLLOW_UP_CHARS = 60; // a question shorter than this is searched together with the previous one
const HISTORY_TURNS = 2; // earlier question/answer pairs passed along for follow-up questions
const HISTORY_CHARS = 500;
const CHAT_OPTIONS = { num_ctx: 4096, temperature: 0.2 };

const NO_INDEX = 'Otsinguindeks puudub. Käivita kaustas fail uuenda-andmeid.bat ja proovi siis uuesti.';
const NO_ANSWER =
  'Ei leidnud Keskkonnaagentuuri, Keskkonnaameti ega SMI materjalidest selle kohta infot. ' +
  'Proovi küsida täpsemalt või teise sõnastusega.';
// Used while the index is limited to one topic (the "focus" in sources.json).
const noAnswerOnTopic = (topic) =>
  `Ei leidnud selle kohta infot. Praegu on indeksis ainult teema „${topic}“: SMI materjalid ning ` +
  'Keskkonnaagentuuri ja Keskkonnaameti selleteemalised lehed ja uudised.';
const SYSTEM_PROMPT = `Sa vastad küsimustele ainult kasutaja sõnumis toodud allikate põhjal. Allikad pärinevad Keskkonnaagentuuri ja Keskkonnaameti veebilehtedelt ning statistilise metsainventuuri (SMI) materjalidest.

Reeglid:
- Kasuta ainult allikates kirjas olevat infot. Ära lisa midagi oma teadmistest ega oleta.
- Kui allikates ei ole küsimusele vastust, ütle täpselt nii: "Allikates selle kohta infot ei ole."
- Pane iga väite järele viide allikale nurksulgudes, näiteks [1] või [2].
- Igal allikal on kuupäev. Kui sama näitaja kohta on eri allikates eri arvud, kasuta kõige uuema kuupäevaga allikat ja ütle, mis aasta või mis allika andmed need on.
- Ära pane ühe allika arvu kokku teise allika aastaarvuga. Arv, aasta ja viide peavad tulema samast allikast.
- Vasta eesti keeles täislausega, lühidalt ja täpselt. Arvud ja ühikud kirjuta nii, nagu need allikas on.`;

let index = null;
let indexStamp = 0;

// Picks up a rebuilt index (or the partial saves of a running ingest) without a restart.
function currentIndex() {
  const stamp = indexModifiedAt();
  if (stamp !== indexStamp) {
    const loaded = loadIndex();
    if (loaded) {
      index = loaded;
      indexStamp = stamp;
    }
  }
  return index;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (part) => {
      body += part;
      if (body.length > 2e6) reject(new Error('too_large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function status() {
  const current = currentIndex();
  if (!current) return { ready: false };
  const perSource = {};
  for (const doc of current.docs) perSource[doc.source] = (perSource[doc.source] || 0) + 1;
  return {
    ready: true,
    partial: Boolean(current.partial),
    focus: current.focus || null,
    built: current.built,
    passages: current.chunks.length,
    perSource,
  };
}

// Finds the passages worth showing to the model, best first.
async function retrieve(current, messages) {
  const questions = messages.filter((m) => m.role === 'user').map((m) => m.content);
  // A short follow-up like "aga 2023. aastal?" only makes sense next to the question before it.
  const latest = questions[questions.length - 1];
  const query = latest.length < FOLLOW_UP_CHARS ? questions.slice(-2).join('\n') : latest;
  const [vector] = await embed([query], { onCpu: true });
  const hits = search(current, vector, MAX_PASSAGES * 3);
  const best = hits.length ? hits[0].score : 0;
  const tier = (hit) => Math.floor((best - hit.score) / SCORE_TIER);
  const dateOf = (hit) => current.docs[current.chunks[hit.chunk].doc].date || '';
  let candidates = hits.filter((hit) => hit.score >= MIN_SCORE && hit.score >= best - SCORE_WINDOW);

  // Unless the question itself names a year, drop what is much older than the newest of the
  // best matches. The single best match always stays.
  const newest = candidates.filter((hit) => tier(hit) === 0).map(dateOf).sort().pop();
  if (newest && !/\b(19|20)\d{2}\b/.test(query)) {
    const cutoff = `${Number(newest.slice(0, 4)) - STALE_YEARS}${newest.slice(4)}`;
    candidates = candidates.filter((hit, n) => n === 0 || !dateOf(hit) || dateOf(hit) >= cutoff);
  }

  // Passages that match about equally well (the same SMI table from three different years,
  // a rule repeated in several news items) are ordered newest first.
  let budget = MAX_SOURCE_CHARS;
  return candidates
    .sort((a, b) => tier(a) - tier(b) || dateOf(b).localeCompare(dateOf(a)) || b.score - a.score)
    .slice(0, MAX_PASSAGES)
    .filter((hit, n) => {
      budget -= current.chunks[hit.chunk].text.length;
      return n === 0 || budget >= 0;
    })
    .map((hit, n) => {
      const chunk = current.chunks[hit.chunk];
      const doc = current.docs[chunk.doc];
      return {
        n: n + 1,
        title: doc.title,
        label: chunk.label,
        source: doc.source,
        kind: doc.kind,
        date: doc.date,
        url: chunk.url || doc.url,
        score: Number(hit.score.toFixed(3)),
        text: chunk.text,
      };
    });
}

function buildMessages(messages, passages) {
  const question = messages[messages.length - 1].content;
  const earlier = messages
    .slice(0, -1)
    .slice(-HISTORY_TURNS * 2)
    .map(({ role, content }) => ({ role, content: content.slice(0, HISTORY_CHARS) }));
  const sources = passages
    .map((p) => {
      const dated = p.date && `${p.kind === 'leht' ? 'uuendatud' : 'avaldatud'} ${p.date}`;
      const where = [p.source, p.label, dated].filter(Boolean).join(', ');
      return `[${p.n}] ${p.title} (${where})\n${p.text}`;
    })
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...earlier,
    { role: 'user', content: `Allikad:\n\n${sources}\n\nKüsimus: ${question}` },
  ];
}

async function chat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'bad_request' });
  }
  const messages = (body.messages || []).filter((m) => m && typeof m.content === 'string' && m.content.trim());
  if (!messages.length || messages[messages.length - 1].role !== 'user') return sendJson(res, 400, { error: 'bad_request' });

  // The reply is a stream of JSON lines: first the sources, then Ollama's own chat stream.
  const line = (data) => res.write(JSON.stringify(data) + '\n');
  const finishWith = (content) => {
    line({ message: { role: 'assistant', content }, done: true });
    res.end();
  };

  const current = currentIndex();
  let passages;
  try {
    passages = current ? await retrieve(current, messages) : [];
  } catch {
    return sendJson(res, 502, { error: 'ollama_unreachable' });
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  line({ sources: passages.map(({ text, ...shown }) => shown) });
  if (!current) return finishWith(NO_INDEX);
  // Nothing relevant found: answer here, so the model gets no chance to improvise.
  if (!passages.length) return finishWith(current.focus ? noAnswerOnTopic(current.focus) : NO_ANSWER);

  const upstream = http.request(
    { hostname: OLLAMA.hostname, port: OLLAMA.port, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json' } },
    (up) => up.pipe(res),
  );
  upstream.on('error', () => {
    line({ error: 'ollama_unreachable' });
    res.end();
  });
  // Closing the connection is how Ollama learns it should stop generating.
  res.on('close', () => upstream.destroy());
  upstream.end(JSON.stringify({ model: body.model, messages: buildMessages(messages, passages), stream: true, options: CHAT_OPTIONS }));
}

function proxyTags(req, res) {
  const upstream = http.request(
    { hostname: OLLAMA.hostname, port: OLLAMA.port, path: '/api/tags', method: 'GET' },
    (up) => {
      res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] || 'application/json', 'cache-control': 'no-store' });
      up.pipe(res);
    },
  );
  upstream.on('error', () => sendJson(res, 502, { error: 'ollama_unreachable' }));
  upstream.end();
}

const server = http.createServer((req, res) => {
  // Only this page may talk to the server, not other sites open in the browser.
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(req.headers.host) || (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, '')))) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  const route = `${req.method} ${req.url.split('?')[0]}`;
  if (route === 'POST /api/chat') return chat(req, res);
  if (route === 'GET /api/tags') return proxyTags(req, res);
  if (route === 'GET /api/status') return sendJson(res, 200, status());
  if (route === 'GET /') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(PAGE).pipe(res);
  }
  sendJson(res, 404, { error: 'not_found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} on juba kasutusel. Ava ${URL_HERE} või sulge teine aken.`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const current = currentIndex();
  console.log(`Vestlus töötab aadressil ${URL_HERE}`);
  console.log(current ? `Indeksis on ${current.chunks.length} lõiku ${current.docs.length} dokumendist.` : NO_INDEX);
  console.log('Sulgemiseks vajuta Ctrl+C või pane see aken kinni.');
  if (process.argv.includes('--open')) exec(`start "" "${URL_HERE}"`);
});
