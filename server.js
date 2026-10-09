// Serves the chat page and answers questions from the search index.
//
// Locally the models run in Ollama on this machine: `node server.js` (add --open to launch
// the browser). On Vercel, where this file is deployed as it is, they are reached through
// a cloud provider. lib/models.js decides which.
//
// The guiding rule is "better no answer than a wrong one". An answer is only given when
// passages match the question well, only recent passages are used for questions about the
// present, and every number in the answer must stand in the source it cites.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { loadIndex, indexModifiedAt, search } = require('./lib/search');
const { CLOUD, PROVIDER, CLOUD_INDEX, embed, streamChat, chatModels } = require('./lib/models');
const { ungroundedNumbers, withoutTables, figures, sameFigures } = require('./lib/verify');

const PORT = Number(process.env.PORT) || 3939;
const PAGE = path.join(__dirname, 'index.html');
// How to show the chat box on another site's page in one's own browser (see naidis.html).
const DEMO_PAGE = path.join(__dirname, 'naidis.html');

// The practice demo for the portal's owner: Keskkonnaportaal's forest page exactly as it is,
// with the chat box at the top of its content. On the web this is the home page; locally it
// is at /portaal and the home page stays the plain chat (which is always at /vestlus).
const PORTAL = 'https://keskkonnaportaal.ee';
const PORTAL_PAGE = `${PORTAL}/et/teemad/mets`;
const PORTAL_CACHE_MS = 10 * 60 * 1000;
const PORTAL_AS_HOME = Boolean(process.env.VERCEL);
const URL_HERE = `http://127.0.0.1:${PORT}`;
const ON_VERCEL = Boolean(process.env.VERCEL);
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// How much the chat model gets to read. The local model manages ~64 tokens/s, so there every
// passage costs seconds; in the cloud every passage counts against the daily allowance.
// The cloud model reads fast, so it gets more to draw background and data series from.
const MAX_PASSAGES = CLOUD ? 6 : 4;
const MAX_SOURCE_CHARS = CLOUD ? 6000 : 3800; // about 2700 or 1700 tokens
const LEAD_CHARS = 500; // how much of a news item's opening goes along with a later passage
// MIN_SCORE: below this a passage is not about the question. The value depends on the search
// model. Measured for bge-m3: questions the sources cover score 0.62-0.80, unrelated ones
// (recipes, football, programming) 0.42-0.51. Set near the top of that gap on purpose.
const MIN_SCORE = CLOUD_INDEX ? Number(process.env.CLOUD_MIN_SCORE ?? 0.35) : 0.6;
const SCORE_WINDOW = 0.06; // passages this much worse than the best one are left out
const SCORE_TIER = 0.04; // scores closer than this count as equally good
// The sites keep news from many years, each stating the figures of its day ("117 wolves may
// be hunted this season" from 2024 next to "163" from 2026). Old material is therefore left
// out: for a question about a given year everything from before the year preceding it, and
// otherwise everything this much older than the newest good match.
const STALE_YEARS = 2;
const CURRENT_WORDS = /(see aasta|sel aastal|selle aasta|tänavu|praegu|hetkel|käesolev|sel hooajal|sel jahihooajal|tänase seisuga|nüüd)/i;
const FOLLOW_UP_CHARS = 60; // locally, a question shorter than this is searched together with the ones before it
const HISTORY_TURNS = 2; // earlier question/answer pairs passed along for follow-up questions
const HISTORY_CHARS = 500;
// In the cloud the answer is held back until it has been checked. The local model is too
// slow for that: its answer shows as it is written and is withdrawn if the check fails.
const HOLD_ANSWER = CLOUD;
// An answer that states a figure is asked for a second time, with more randomness, and only
// shown if both attempts lead with the same figure. The same question over the same sources
// has been seen to give 163 once and 33 the next time. Costs a second model call, so it
// halves how many such questions the free daily allowance covers; cloud only.
const DOUBLE_CHECK = CLOUD && process.env.DOUBLE_CHECK !== '0';
const SECOND_TEMPERATURE = 0.8;

// A public page can be used by anyone, and the free allowance is shared by all visitors.
const MAX_QUESTION_CHARS = 600;
const RATE_LIMIT = 12; // questions per visitor ...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ... in this time

const NO_INDEX = CLOUD_INDEX
  ? 'Veebiversiooni otsinguindeks puudub. See tuleb teha käsuga: node ingest.js --cloud'
  : 'Otsinguindeks puudub. Käivita kaustas fail uuenda-andmeid.bat ja proovi siis uuesti.';
const NO_ANSWER =
  'Ei leidnud Keskkonnaagentuuri, Keskkonnaameti ega SMI materjalidest selle kohta piisavalt kindlat infot. ' +
  'Proovi küsida täpsemalt või teise sõnastusega.';
// Used while the index is limited to one topic (the "focus" in sources.json).
const noAnswerOnTopic = (topic) =>
  `Ei leidnud selle kohta piisavalt kindlat infot. Praegu on indeksis ainult teema „${topic}“: SMI materjalid ` +
  'ning Keskkonnaagentuuri ja Keskkonnaameti selleteemalised lehed ja uudised.';
const UNSURE = 'Allikates selle kohta kindlat infot ei ole.';
const withdrawn = (problems) =>
  `Ma ei saa sellele allikate põhjal kindlalt vastata. Mudeli vastuses oli arv (${[...new Set(problems.map((p) => p.number))].join(', ')}), ` +
  'mida viidatud allikas kirjas ei ole, seega jätsin vastuse näitamata. Allpool on allikad, millest vastust otsiti.';
const disagreed = (first, second) =>
  'Ma ei saa sellele allikate põhjal kindlalt vastata. Küsisin mudelilt kaks korda ja sain eri tulemuse ' +
  `(${first.written} ja ${second ? second.written : 'teisel korral arvu ei tulnud'}), seega jätsin vastuse näitamata. ` +
  'Allpool on allikad, millest vastust otsiti.';

const today = () => new Date().toISOString().slice(0, 10);
const systemPrompt = () => `Sa vastad küsimustele ainult kasutaja sõnumis toodud allikate põhjal. Allikad pärinevad Keskkonnaagentuuri ja Keskkonnaameti veebilehtedelt ning statistilise metsainventuuri (SMI) ja ulukiseire materjalidest.

Tänane kuupäev on ${today()}.

Reeglid:
- Kasuta ainult allikates kirjas olevat infot. Ära lisa midagi oma teadmistest ega oleta.
- Kui allikad ei vasta küsimusele otse ja üheselt, ütle täpselt nii: "${UNSURE}" Pigem jäta vastamata, kui paku.
- Pane iga väite järele viide allikale: ainult allika number nurksulgudes, näiteks [1] või [2]. Kuupäeva viite sisse ära pane, kirjuta see lausesse.
- Iga arvu juurde kirjuta, mis aja kohta see käib, nii nagu allikas ise ütleb (aasta, hooaeg või allika kuupäev). Ära kirjuta arvu juurde aastat, mida selles allikas kirjas ei ole.
- Arv, aeg ja viide peavad tulema samast allikast. Ära pane ühe allika arvu kokku teise allika aastaga.
- Kui sama näitaja kohta on eri allikates eri arvud, kasuta kõige uuema kuupäevaga allikat.
- Kui küsitakse praeguse seisu kohta ("see aasta", "praegu"), kasuta ainult värskeimat allikat ja ütle selle kuupäev. Kui ükski allikas selle aja kohta ei käi, ütle, et allikates selle kohta kindlat infot ei ole.
- Erista, kas küsitakse lubatud või kavandatud mahtu ("tohib küttida") või tegelikku tulemust ("kütiti"), ja vasta sellele, mida küsiti.
- Ära anna hinnanguid ega tee omapoolseid järeldusi, kokkuvõtteid või üldistusi; ära kasuta järeldavaid sõnu nagu "seega", "järelikult" või "kokkuvõttes". Koguste, muutuste ja võrdluste küsimusele ära vasta sõnaga "Jah" ega "Ei", vaid esita allikas olevad arvud koos aja või perioodiga ja ütle, kelle andmed need on (näiteks "Keskkonnaagentuuri 9.04.2026 ülevaate järgi ...").
- Ära muuda allika ajamäärangut aastaarvudeks. Kui allikas ütleb "viimasel kümnendil" või "20 aasta jooksul", kirjuta samamoodi ja ära arvuta sellest aastaid.
- Ära arvuta ise vahesid, summasid, keskmisi ega protsente. Muutust kirjelda allika arvudega kõrvuti (näiteks "2023/2024 kütiti 4 061, 2024/2025 kütiti 3 551") ja ära lisa üldistavaid sõnu nagu "järjekindlalt", "oluliselt" või "järsult", kui allikas neid ei kasuta.
- Kui allikas annab eri perioodide või eri näitajate kohta erineva pildi, too need kõik välja, mitte ainult üks. Kui allikas ise ütleb, et näitajat ei saa lihtsustatult tõlgendada, ütle ka seda.
- Kasuta neutraalset ja asjalikku sõnastust. Ära kasuta hinnangulisi ega ärevust tekitavaid sõnu, mida allikas ei kasuta.
- Vasta eesti keeles täislausetega, selgelt ja täpselt. Arvud ja ühikud kirjuta täpselt nii, nagu need allikas on; ära teisenda ühikuid ega arvuta ise.

Vastuse ülesehitus (ilma vahepealkirjadeta, ära kirjuta lõikude ette "Vastus:" ega "Taust:"; ära kirjelda allikaid ega oma vastust, näiteks "Allikas [1] annab ..."):
1. Esimeses lõigus otsene vastus allika arvudega. Alusta seda allika nimetamisega, näiteks "Keskkonnaagentuuri 9.04.2026 ülevaate järgi ..." või "SMI 2024. aasta andmetel ...".
2. Teises lõigus taust kahe kuni nelja lausega, ainult allikatest: mis aja ja mille kohta arvud käivad, allikas nimetatud täpsustused ja reservatsioonid ning teised samade allikate arvud, mis aitavad vastust mõista. Ära seleta mõisteid oma sõnadega ega lisa selgitusi, mida allikas ei anna. Kui allikates tausta ei ole, jäta see lõik ära.
3. Kui allikates on küsimusega seotud arvurida (vähemalt kolm väärtust: mitu aastat, maakonda või liiki), lisa lõppu Markdown-tabel. Esimene veerg on aasta, periood või nimetus, järgmistes veergudes arvud (kõige rohkem kolm arvuveergu, näiteks kui võrreldakse kahte näitajat). Esimesse veergu kirjuta ainult aasta või hooaeg ühtmoodi kogu tabelis (näiteks "2023/2024"), ilma lisasõnadeta, ja ära korda sama aega kahel real. Ühik kirjuta veeru päisesse sulgudesse, näiteks "Raiemaht (mln m³)", lahtrisse ainult arv. Tabelisse pane ainult allikas kirjas olevad arvud, iga rea arvud samast allikast, kõige rohkem 15 rida, ajaread vanemast uuemani. Leht joonistab tabelist ise graafiku, nii et graafikut ära kirjelda.`;

// A question about amounts, changes or comparisons is answered with the sources' figures,
// never with a verdict. "Jah, raiutakse rohkem kui juurde kasvab" was given for a source
// that says the opposite holds over twenty years and warns against that very simplification.
const QUANTITY_QUESTION = /(rohkem|vähem|suurem|väiksem|enam|kasva|vähene|suurene|kahane|liiga|palju|mitu|kui suur|osakaal|protsen|maht|arv)/i;
const VERDICT_OPENING = /^\s*(jah|ei|kindlasti|loomulikult|paraku|kahjuks)(?![\p{L}])/iu;
const OWN_CONCLUSION = /(?<![\p{L}])(seega|järelikult|niisiis|teisisõnu|kokkuvõttes|kokkuvõtvalt)(?![\p{L}])/iu;
// "Is more felled than grows?" asks for a comparison. Its answer has to open by naming whose
// figures follow ("Keskkonnaagentuuri 9.04.2026 ülevaate järgi ..."), so that it cannot
// open with a claim in the model's own voice ("Eestis raiutakse rohkem, kui juurde kasvab").
const COMPARISON_QUESTION = /(rohkem|vähem|suurem|väiksem|enam|liiga|kasva|vähene|suurene|kahane)/i;
const ATTRIBUTION = /(?<![\p{L}])(järgi|andmetel|andmeil|kohaselt|põhjal|teatel|hinnangul)(?![\p{L}])/iu;
const namesSourceFirst = (text) => ATTRIBUTION.test(text.split(/[,:;]|\s[–-]\s|(?<=\p{Ll})[.!?]\s/u)[0]);
const OPEN_WITH_SOURCE = 'Alusta vastust allika nimetamisega, näiteks "Keskkonnaagentuuri 9.04.2026 ülevaate järgi ...". ';
const RETRY_WITHOUT_VERDICT =
  'See vastus andis hinnangu, tegi omapoolse järelduse või jäi ilma arvudeta. Kirjuta vastus uuesti. Ära alusta sõnaga "Jah" ega "Ei", ära anna hinnangut ' +
  'ja ära kasuta järeldavaid sõnu ("seega", "järelikult", "kokkuvõttes"). ' + OPEN_WITH_SOURCE +
  'Esita ainult allikates olevad arvud ja perioodid. Kui allikas nimetab eri perioodide kohta erinevat tulemust, too need kõik välja. ' +
  `Kui allikates arve ei ole, ütle täpselt: "${UNSURE}"`;
const retryUngrounded = (problems) =>
  `Sinu vastuses olid arvud (${[...new Set(problems.map((p) => p.number))].join(', ')}), mida nende juures viidatud allikas kirjas ei ole. Kirjuta vastus uuesti. ` +
  'Kasuta ainult arve ja aastaid, mis on allikas täpselt nii kirjas, ja pane iga arvu järele viide just sellele allikale, kus see arv on. ' +
  'Ära tuleta aastaarve ise: kui allikas ütleb "viimasel kümnendil", ära kirjuta selle asemele aastate vahemikku. Arv, mida allikast võtta ei saa, jäta välja. ' +
  'Tabeli igal real peavad aasta ja arv olema kirjas ühes ja samas allikas; kirjuta selle allika viide rea lõppu. ' +
  OPEN_WITH_SOURCE;
const NO_FIGURES =
  'Allikates ei ole selle kohta arve, mille põhjal üheselt vastata, ja hinnangut ma ise ei anna. Allpool on allikad, millest vastust otsiti.';

// Words that judge or alarm. They are fine when a source uses them (or the question asks
// about them) and a fault when they are the model's own colouring of the figures.
const LOADED =
  /(?<![\p{L}])(järjekindl\p{L}*|oluliselt|järs[ku]\p{L}*|drastil\p{L}*|dramaatil\p{L}*|märkimisväär\p{L}*|märgatav\p{L}*|murettekita\p{L}*|ohtlik\p{L}*|katastroof\p{L}*|kriis\p{L}*|kriitili\p{L}*|hävi\p{L}*|liiga|ülerai\p{L}*|alarmeeri\p{L}*|häiriv\p{L}*|tohutu\p{L}*|massili\p{L}*|hüppeli\p{L}*|plahvatusli\p{L}*|paraku|kahjuks|õnneks)/giu;
function loadedWords(question, answer, passages) {
  const allowed = [question, ...passages.flatMap((passage) => [passage.title, passage.text])].join('\n').toLowerCase();
  // Endings vary ("drastiline", "drastiliselt"), so a longer word is looked up by its beginning.
  const stem = (word) => (word.length <= 7 ? word : word.slice(0, -3)).toLowerCase();
  return [...new Set(withoutTables(answer).match(LOADED) || [])].filter((word) => !allowed.includes(stem(word)));
}
const retryLoaded = (words) =>
  `Sinu vastuses olid hinnangulised sõnad (${words.join(', ')}), mida allikad ei kasuta. Kirjuta vastus uuesti ilma nendeta: ` +
  'esita arvud koos aja ja allikaga ning jäta muutuse suuruse hindamine lugejale.';
const notNeutral = (words) =>
  `Ma ei saa sellele allikate põhjal neutraalselt vastata. Mudeli vastuses oli hinnanguline sõna (${words.join(', ')}), ` +
  'mida allikad ei kasuta, seega jätsin vastuse näitamata. Allpool on allikad, millest vastust otsiti.';

// The sentences of a line of text. "2025. aastal" and "19. jaanuaril" do not end one.
const sentencesOf = (text) => text.trim().split(/(?<=[.!?\]])\s+(?=[\p{Lu}\d])/u);
// An answer without the sentences that `unwanted` picks out. Table rows are left alone.
function withoutSentences(answer, unwanted) {
  let dropped = false;
  const lines = answer.split('\n').map((line) => {
    if (line.trim().startsWith('|')) return line;
    const sentences = sentencesOf(line);
    const kept = sentences.filter((sentence) => !unwanted(sentence));
    if (kept.length === sentences.length) return line;
    dropped = true;
    return kept.join(' ');
  });
  return dropped ? lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() : answer;
}

const CITED = /\[\d+(?:\s*,\s*\d+)*\]/;
const RETRY_UNCITED =
  'Sinu vastuses ei olnud arvude juures viiteid. Kirjuta vastus uuesti ja pane iga arvu järele nurksulgudes selle allika number, kus see arv kirjas on, näiteks [2].';
const UNCITED =
  'Ma ei saa sellele allikate põhjal kindlalt vastata. Mudeli vastuses ei olnud arvude juures viiteid allikatele, ' +
  'seega jätsin vastuse näitamata. Allpool on allikad, millest vastust otsiti.';

function givesVerdict(question, answer) {
  if (!QUANTITY_QUESTION.test(question) || answer.includes(UNSURE.slice(0, -1))) return false;
  const text = withoutTables(answer);
  if (COMPARISON_QUESTION.test(question) && !namesSourceFirst(text)) return true;
  // Figures may stand in the text or in a table.
  return VERDICT_OPENING.test(text) || OWN_CONCLUSION.test(text) || (!figures(answer).length && text === answer);
}

let index = null;
let indexStamp = 0;

// Picks up a rebuilt index (or the partial saves of a running ingest) without a restart.
function currentIndex() {
  const stamp = indexModifiedAt(CLOUD_INDEX);
  if (stamp !== indexStamp) {
    const loaded = loadIndex(CLOUD_INDEX);
    if (loaded) {
      // The opening passage of every document, for retrieve().
      loaded.firstChunk = new Map();
      for (const chunk of loaded.chunks) if (!loaded.firstChunk.has(chunk.doc)) loaded.firstChunk.set(chunk.doc, chunk);
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

// Rewrites a follow-up ("mitu hunti?", "aga see aasta?") into a question that stands on its
// own, so that the search looks for the right thing. Returns null if that did not work out.
async function standalone(model, messages, signal) {
  const earlier = messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'Kasutaja' : 'Abiline'}: ${m.content.slice(0, 300)}`)
    .join('\n');
  const prompt = [
    {
      role: 'system',
      content:
        'Sinu ainus ülesanne on sõnastada vestluse viimane küsimus ümber nii, et see oleks arusaadav ilma eelneva vestluseta. ' +
        'Säilita küsimuse mõte ja sõnastus; lisa ainult see, mis eelnevast vestlusest puudu on (kellest või millest jutt käib, mida täpselt küsitakse). ' +
        `Tänane kuupäev on ${today()}; asenda "see aasta" ja "tänavu" aastaarvuga. ` +
        'Kui küsimus on juba iseseisev või alustab uut teemat, korda see muutmata. Ära vasta küsimusele. ' +
        'Kirjuta ainult üks küsimus eesti keeles, ilma selgituseta.\n\n' +
        'Näide. Vestlus: "Kasutaja: mitu põtra tohib see aasta küttida? Abiline: 2026. aastal tohib küttida 3200–3580 põtra." ' +
        'Viimane küsimus: "mitu hunti?" Sinu vastus: Mitu hunti tohib 2026. aastal küttida?',
    },
    { role: 'user', content: `Vestlus:\n${earlier}\n\nViimane küsimus: ${messages[messages.length - 1].content}` },
  ];
  let text = '';
  await streamChat({ model, messages: prompt, signal }, (part) => {
    if (part.content) text += part.content;
  });
  text = text.trim().split('\n')[0].replace(/^["„“]+|["“”]+$/g, '').trim();
  // The model has been seen to answer in English with invented content; then it is not used.
  if (/\b(what|which|how|the|are|is|for|and|of)\b/i.test(text)) return null;
  return text.length > 5 && text.length <= MAX_QUESTION_CHARS ? text : null;
}

// Evens out how models write citations: 【2】 and "[2, 2026-01-19]" both become plain [2].
// Labels a model puts before its paragraphs ("**Vastus:**", "**Taust:**") are dropped, and
// so is a table of a single row, which says nothing its sentence has not said.
function tidyAnswer(answer) {
  const tidy = answer
    .replace(/[\[【](\d{1,2})\s*,\s*(\d{4}[-‑]\d{2}[-‑]\d{2}|\d{1,2}\.\d{1,2}\.\d{4})[\]】]/g, '($2) [$1]')
    .replace(/【(\d+(?:\s*,\s*\d+)*)】/g, '[$1]')
    .replace(PARAGRAPH_LABEL, '');
  return withoutTables(tidy, 2);
}
const LABELS = '(?:Otsene vastus|Vastus|Taust|Tabel|Andmed)';
// "### Taust", "**Taust:**" or "Taust:" at the start of a line; never the word in a sentence.
const PARAGRAPH_LABEL = new RegExp(
  `^[ \\t]*(?:#{1,4}[ \\t]+${LABELS}[ \\t]*:?[ \\t]*$|\\*\\*${LABELS}[ \\t]*:?\\*\\*:?|${LABELS}:)[ \\t]*\\n?`,
  'gimu',
);

// Finds the passages worth showing to the model, best first.
async function retrieve(current, query) {
  const [vector] = await embed([query], { onCpu: true });
  const hits = search(current, vector, MAX_PASSAGES * 3);
  const best = hits.length ? hits[0].score : 0;
  const tier = (hit) => Math.floor((best - hit.score) / SCORE_TIER);
  const dateOf = (hit) => current.docs[current.chunks[hit.chunk].doc].date || '';
  let candidates = hits.filter((hit) => hit.score >= MIN_SCORE && hit.score >= best - SCORE_WINDOW);

  // Which time is the question about? A named year, the present, or nothing in particular.
  const years = (query.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  if (!years.length && CURRENT_WORDS.test(query)) years.push(new Date().getFullYear());
  let cutoff = '';
  if (years.length) {
    // Seasons and reports span two calendar years, so the year before still counts.
    cutoff = `${Math.min(...years) - 1}-01-01`;
  } else {
    const newest = candidates.filter((hit) => tier(hit) === 0).map(dateOf).sort().pop();
    if (newest) cutoff = `${Number(newest.slice(0, 4)) - STALE_YEARS}${newest.slice(4)}`;
  }
  if (cutoff) candidates = candidates.filter((hit) => !dateOf(hit) || dateOf(hit) >= cutoff);

  // What is left all matches well, so recency decides: the best match plus the newest of the
  // rest, newest first. A figure that changes from one news item to the next (112, then 130,
  // then 163 wolves within six weeks) must reach the model in its latest version.
  const byDate = (a, b) => dateOf(b).localeCompare(dateOf(a)) || b.score - a.score;
  const [top, ...rest] = candidates;
  const chosen = top ? [top, ...rest.sort(byDate).slice(0, MAX_PASSAGES - 1)].sort(byDate) : [];

  // A news item states its point in the opening paragraph ("163 wolves may be hunted"), while
  // a passage from further down may only mention a detail ("33 extra permits"). Such a
  // passage is therefore read together with the opening of its article.
  const withLead = new Set(chosen.map((hit) => current.chunks[hit.chunk]).filter((chunk) => current.firstChunk.get(chunk.doc) === chunk));
  let budget = MAX_SOURCE_CHARS;
  return chosen
    .map((hit) => {
      const chunk = current.chunks[hit.chunk];
      const doc = current.docs[chunk.doc];
      const first = current.firstChunk.get(chunk.doc);
      let text = chunk.text;
      if (doc.kind === 'uudis' && !withLead.has(first)) {
        withLead.add(first);
        text = `${first.text.slice(0, LEAD_CHARS)}\n[…]\n${chunk.text}`;
      }
      return {
        title: doc.title,
        label: chunk.label,
        source: doc.source,
        kind: doc.kind,
        date: doc.date,
        url: chunk.url || doc.url,
        score: Number(hit.score.toFixed(3)),
        text,
      };
    })
    .filter((passage, n) => {
      budget -= passage.text.length;
      return n === 0 || budget >= 0;
    })
    .map((passage, n) => ({ n: n + 1, ...passage }));
}

function buildMessages(history, question, passages) {
  const earlier = history
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
    { role: 'system', content: systemPrompt() },
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
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== 'user') return sendJson(res, 400, { error: 'bad_request' });
  if (ON_VERCEL && latest.content.length > MAX_QUESTION_CHARS) return sendJson(res, 413, { error: 'too_long' });
  if (overLimit(req)) return sendJson(res, 429, { error: 'rate_limited' });

  // Leaving the page or pressing "Peata" stops the model as well.
  const stop = new AbortController();
  res.on('close', () => stop.abort());
  // The free cloud allowance is counted per day; once it is used up every call is refused.
  const refuse = (error) => {
    console.error(error.message);
    return error.status === 429 ? sendJson(res, 429, { error: 'daily_limit' }) : sendJson(res, 502, { error: 'model_unreachable' });
  };

  // The page chooses among the models this server offers; anything else falls back to the default.
  let model;
  try {
    const offered = await chatModels();
    model = offered.includes(body.model) ? body.model : offered[0];
  } catch (error) {
    return refuse(error);
  }

  // What exactly is being asked, and what should be searched for?
  let question = latest.content.trim();
  let history = messages.slice(0, -1);
  if (CLOUD && history.length) {
    try {
      const rewritten = await standalone(model, messages, stop.signal);
      if (rewritten) {
        question = rewritten;
        history = []; // the question now carries what it needs from the conversation
      }
    } catch (error) {
      if (error.status === 429) return refuse(error);
      console.error(error.message); // carry on with the question as typed
    }
  }
  const asked = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const query = history.length && question.length < FOLLOW_UP_CHARS ? asked.slice(-3).join('\n') : question;

  const current = currentIndex();
  let passages;
  try {
    passages = current ? await retrieve(current, query) : [];
  } catch (error) {
    return refuse(error);
  }

  // The reply is a stream of JSON lines: first the sources, then the answer.
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const line = (data) => res.write(JSON.stringify(data) + '\n');
  const say = (content) => line({ message: { role: 'assistant', content } });
  line({
    sources: passages.map(({ text, ...shown }) => shown),
    question: question !== latest.content.trim() ? question : undefined,
  });
  if (!current) say(NO_INDEX);
  // Nothing matches well enough: answer here, so the model gets no chance to improvise.
  else if (!passages.length) say(current.focus ? noAnswerOnTopic(current.focus) : NO_ANSWER);
  if (!current || !passages.length) {
    line({ done: true });
    return res.end();
  }

  let answer = '';
  try {
    const prompt = buildMessages(history, question, passages);
    const sample = async (messages, temperature) => {
      let text = '';
      await streamChat({ model, messages, signal: stop.signal, temperature }, (part) => {
        if (part.content) text += part.content;
      });
      return tidyAnswer(text);
    };
    // A question about amounts will need the second attempt of check 3. It is asked for
    // right away, alongside the answer, so that checking does not double the wait.
    const early = DOUBLE_CHECK && QUANTITY_QUESTION.test(question)
      ? sample(prompt, SECOND_TEMPERATURE).then((text) => ({ text }), (error) => ({ error }))
      : null;
    await streamChat({ model, messages: prompt, signal: stop.signal }, (part) => {
      if (part.content) answer += part.content;
      if (!HOLD_ANSWER) line({ message: { role: 'assistant', ...part } });
    });
    answer = tidyAnswer(answer);

    // Checks before the answer counts. An answer that fails any is sent back once with the
    // reasons; failing again means no answer is given.
    const faults = (lastChance) => {
      const found = [];
      // 1. No verdicts, no conclusions of the model's own, no loaded words the sources do not use.
      // On the last chance a later sentence that still has one is left out; the answer
      // stands if its opening sentence is untouched and the rest passes.
      if (lastChance) {
        const trimmed = withoutSentences(answer, (sentence) =>
          (QUANTITY_QUESTION.test(question) && OWN_CONCLUSION.test(sentence)) || loadedWords(question, sentence, passages).length > 0);
        if (trimmed !== answer && sentencesOf(trimmed)[0] === sentencesOf(answer)[0]) {
          console.error(`Lause jäi näitamata: ${answer.replace(/\s+/g, ' ').slice(0, 600)}`);
          answer = trimmed;
        }
      }
      if (givesVerdict(question, answer)) found.push({ again: RETRY_WITHOUT_VERDICT, refusal: NO_FIGURES });
      const loaded = loadedWords(question, answer, passages);
      if (loaded.length) found.push({ again: retryLoaded(loaded), refusal: notNeutral(loaded) });
      // 2. Every number must stand in the source it cites, and figures need a citation at all.
      let problems = ungroundedNumbers(answer, passages);
      // On the last chance a table that fails is left out; the text stands if it passes on its own.
      if (problems.length && lastChance && withoutTables(answer) !== answer && !ungroundedNumbers(withoutTables(answer), passages).length) {
        console.error(`Tabel jäi näitamata (${problems.map((p) => p.number).join(', ')}): ${answer.replace(/\s+/g, ' ').slice(-400)}`);
        answer = withoutTables(answer);
        problems = [];
      }
      if (problems.length) found.push({ again: retryUngrounded(problems), refusal: withdrawn(problems) });
      else if (figures(answer).length && !CITED.test(withoutTables(answer))) found.push({ again: RETRY_UNCITED, refusal: UNCITED });
      return found;
    };
    let found = faults(!HOLD_ANSWER);
    if (found.length && HOLD_ANSWER) {
      console.error(`Vastus ei läbinud kontrolli, küsin uuesti: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`);
      line({ stage: 'revising' });
      const reasons = found.map((fault) => fault.again).join('\n\n');
      answer = await sample([...prompt, { role: 'assistant', content: answer }, { role: 'user', content: reasons }]);
      found = faults(true);
    }
    let refusal = found.length ? found[0].refusal : null;
    // 3. A second attempt must lead with the same figure.
    if (!refusal && DOUBLE_CHECK && figures(answer).length) {
      line({ stage: 'checking' });
      const opinion = early ? await early : { text: await sample(prompt, SECOND_TEMPERATURE) };
      if (opinion.error) throw opinion.error;
      const second = opinion.text;
      if (!sameFigures(answer, second)) {
        refusal = disagreed(figures(answer)[0], figures(second)[0]);
        console.error(`Teine katse: ${second.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    }

    if (refusal) {
      console.error(`Vastus jäi näitamata: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (HOLD_ANSWER) say(refusal);
      else line({ replace: refusal });
    } else if (HOLD_ANSWER) {
      say(answer || UNSURE);
    }
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

let portalCopy = { html: '', at: 0 };

// Fetches the portal page as it is right now and adds the chat box. Nothing of the portal
// is kept in this project: its styles, scripts and images load from the portal itself
// (<base>), and links lead to the real portal. Three things are changed on purpose:
// the page tells search engines to stay away, the portal's visitor statistics and reCAPTCHA
// scripts are left out so the demo does not count as traffic there, and its feedback form
// does not submit.
async function portalPage(origin) {
  if (Date.now() - portalCopy.at > PORTAL_CACHE_MS) {
    const res = await fetch(PORTAL_PAGE, {
      headers: { 'user-agent': 'metsachat-praktikanaidis/1.0', 'accept-language': 'et' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Keskkonnaportaal: HTTP ${res.status}`);
    portalCopy = { html: await res.text(), at: Date.now() };
  }
  const box =
    '<div id="metsachat" style="max-width:1140px;margin:0 auto;padding:24px;box-sizing:border-box">' +
    `<iframe src="${origin}/vestlus?embed=1" title="Küsi metsa ja ulukite kohta" ` +
    'style="display:block;width:100%;height:190px;border:0;border-radius:12px;background:#E8F6FE;transition:height .25s ease"></iframe></div>' +
    // The box reports how tall it wants to be; it grows when a conversation starts.
    `<script>addEventListener('message',function(e){if(e.origin==='${origin}'&&e.data&&e.data.metsachat)` +
    "document.querySelector('#metsachat iframe').style.height=e.data.height+'px'});" +
    "addEventListener('submit',function(e){if(e.target.matches('.webform-submission-form'))e.preventDefault()},true);</script>";
  return portalCopy.html
    .replace(/<script\b[^>]*\bsrc="[^"]*(?:google_tag|googletagmanager|google-analytics|recaptcha)[^"]*"[^>]*>\s*<\/script>/gi, '')
    .replace(/<head([^>]*)>/i, `<head$1><base href="${PORTAL}/"><meta name="robots" content="noindex, nofollow">`)
    .replace(/<title>([^<]*)<\/title>/i, '<title>$1 – praktika näidis</title>')
    .replace(/<main\b[^>]*>/i, (tag) => tag + box);
}

async function sendPortalPage(req, res) {
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${(ON_VERCEL && req.headers['x-forwarded-host']) || req.headers.host}`;
  try {
    const html = await portalPage(origin);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
    res.end(html);
  } catch (error) {
    // The portal cannot be reached: show the plain chat rather than an error.
    console.error(error.message);
    res.writeHead(302, { location: '/vestlus' });
    res.end();
  }
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
  // "/?embed" is the address older copies of the bookmark button use for the chat box.
  const wantsChat = route === 'GET /vestlus' || (route === 'GET /' && (!PORTAL_AS_HOME || /[?&]embed\b/.test(req.url)));
  if (wantsChat || route === 'GET /naidis') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
    return fs.createReadStream(wantsChat ? PAGE : DEMO_PAGE).pipe(res);
  }
  if (route === 'GET /' || route === 'GET /portaal') return sendPortalPage(req, res);
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
  // --portaal opens the practice demo (the portal page with the chat box) instead of the plain chat.
  if (process.argv.includes('--open')) exec(`start "" "${URL_HERE}${process.argv.includes('--portaal') ? '/portaal' : ''}"`);
});
