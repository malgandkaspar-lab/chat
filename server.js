// Serves the chat page and answers questions from the search index.
//
// Locally the models run in Ollama on this machine: `node server.js` (add --open to launch
// the browser). On Vercel, where this file is deployed as it is, they are reached through
// Vercel AI Gateway. lib/models.js decides which.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { loadIndex, indexModifiedAt, search } = require('./lib/search');
const { CLOUD, PROVIDER, CLOUD_INDEX, embed, streamChat, chatModels } = require('./lib/models');

const PORT = Number(process.env.PORT) || 3939;
const PAGE = path.join(__dirname, 'index.html');
const URL_HERE = `http://127.0.0.1:${PORT}`;
const ON_VERCEL = Boolean(process.env.VERCEL);
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// How much the chat model gets to read. The local model manages ~64 tokens/s, so there every
// passage costs seconds; in the cloud every passage costs money.
const MAX_PASSAGES = 4;
const MAX_SOURCE_CHARS = 3200; // about 1400 tokens
// MIN_SCORE: below this a passage is not about the question. The value depends on the search
// model. Measured for the local one (bge-m3): questions the sources cover score 0.62-0.80,
// unrelated ones (recipes, football, programming) 0.42-0.51.
const MIN_SCORE = CLOUD_INDEX ? Number(process.env.CLOUD_MIN_SCORE ?? 0.35) : 0.55;
const SCORE_WINDOW = 0.08; // passages this much worse than the best one are left out
const SCORE_TIER = 0.04; // scores closer than this count as equally good
// The sites keep news from many years, each stating the figures of its day. Given a 2018 and
// a 2025 figure side by side, the model mixed them up, so older material is dropped when
// equally relevant newer material exists.
const STALE_YEARS = 3;
const FOLLOW_UP_CHARS = 60; // a question shorter than this is searched together with the previous one
const HISTORY_TURNS = 2; // earlier question/answer pairs passed along for follow-up questions
const HISTORY_CHARS = 500;

// A public page can be used by anyone, and every answer costs money there.
const MAX_QUESTION_CHARS = 600;
const RATE_LIMIT = 12; // questions per visitor ...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ... in this time

const NO_INDEX = CLOUD_INDEX
  ? 'Veebiversiooni otsinguindeks puudub. See tuleb teha käsuga: node ingest.js --cloud'
  : 'Otsinguindeks puudub. Käivita kaustas fail uuenda-andmeid.bat ja proovi siis uuesti.';
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
  const stamp = indexModifiedAt(CLOUD_INDEX);
  if (stamp !== indexStamp) {
    const loaded = loadIndex(CLOUD_INDEX);
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

// Only this page may call the server. Locally that also keeps other sites open in the
// browser away from it; on Vercel the host is whatever domain the project has.
function allowed(req) {
  const host = (ON_VERCEL && req.headers['x-forwarded-host']) || req.headers.host;
  if (!ON_VERCEL && !LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin.replace(/^https?:\/\//, '') === host;
}

const recentQuestions = new Map(); // visitor address -> times of their recent questions

function overLimit(req) {
  if (!ON_VERCEL) return false;
  const visitor = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const now = Date.now();
  const times = (recentQuestions.get(visitor) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) return true;
  recentQuestions.set(visitor, [...times, now]);
  if (recentQuestions.size > 5000) recentQuestions.clear();
  return false;
}

function status() {
  const current = currentIndex();
  if (!current) return { ready: false, cloud: CLOUD, provider: PROVIDER };
  const perSource = {};
  for (const doc of current.docs) perSource[doc.source] = (perSource[doc.source] || 0) + 1;
  return {
    ready: true,
    cloud: CLOUD,
    provider: PROVIDER,
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
  const messages = (body.messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-(HISTORY_TURNS * 2 + 1));
  const question = messages[messages.length - 1];
  if (!question || question.role !== 'user') return sendJson(res, 400, { error: 'bad_request' });
  if (ON_VERCEL && question.content.length > MAX_QUESTION_CHARS) return sendJson(res, 413, { error: 'too_long' });
  if (overLimit(req)) return sendJson(res, 429, { error: 'rate_limited' });

  // The page chooses among the models this server offers; anything else falls back to the default.
  let model;
  try {
    const offered = await chatModels();
    model = offered.includes(body.model) ? body.model : offered[0];
  } catch {
    return sendJson(res, 502, { error: 'model_unreachable' });
  }

  const current = currentIndex();
  let passages;
  try {
    passages = current ? await retrieve(current, messages) : [];
  } catch (error) {
    console.error(error.message);
    // The free cloud allowance is counted per day; once it is used up every call is refused.
    if (error.status === 429) return sendJson(res, 429, { error: 'daily_limit' });
    return sendJson(res, 502, { error: 'model_unreachable' });
  }

  // The reply is a stream of JSON lines: first the sources, then the answer piece by piece.
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const line = (data) => res.write(JSON.stringify(data) + '\n');
  const finishWith = (content) => {
    line({ message: { role: 'assistant', content }, done: true });
    res.end();
  };
  line({ sources: passages.map(({ text, ...shown }) => shown) });
  if (!current) return finishWith(NO_INDEX);
  // Nothing relevant found: answer here, so the model gets no chance to improvise.
  if (!passages.length) return finishWith(current.focus ? noAnswerOnTopic(current.focus) : NO_ANSWER);

  // Leaving the page or pressing "Peata" stops the model as well.
  const stop = new AbortController();
  res.on('close', () => stop.abort());
  try {
    await streamChat({ model, messages: buildMessages(messages, passages), signal: stop.signal }, (part) =>
      line({ message: { role: 'assistant', ...part } }),
    );
    line({ done: true });
  } catch (error) {
    if (!stop.signal.aborted) {
      console.error(error.message);
      const code = error.status === 429 ? 'daily_limit' : error instanceof TypeError ? 'model_unreachable' : null;
      // Details of a cloud error stay in the server log; the page gets a plain reason.
      line({ error: code || (CLOUD ? 'model_error' : error.message) });
    }
  }
  res.end();
}

// Answers in the shape of Ollama's /api/tags, which is what the page reads.
async function tags(res) {
  try {
    const names = await chatModels();
    sendJson(res, 200, { models: names.map((name) => ({ name, capabilities: ['completion'] })) });
  } catch {
    sendJson(res, 502, { error: 'model_unreachable' });
  }
}

const server = http.createServer((req, res) => {
  if (!allowed(req)) return sendJson(res, 403, { error: 'forbidden' });

  const route = `${req.method} ${req.url.split('?')[0]}`;
  if (route === 'POST /api/chat') return chat(req, res);
  if (route === 'GET /api/tags') return tags(res);
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
  console.log(`Vestlus töötab aadressil ${URL_HERE} (mudelid: ${PROVIDER})`);
  console.log(current ? `Indeksis on ${current.chunks.length} lõiku ${current.docs.length} dokumendist.` : NO_INDEX);
  console.log('Sulgemiseks vajuta Ctrl+C või pane see aken kinni.');
  if (process.argv.includes('--open')) exec(`start "" "${URL_HERE}"`);
});
