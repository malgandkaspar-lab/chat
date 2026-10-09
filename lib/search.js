// The local search index: passages with their embedding vectors, searched by cosine similarity.
const fs = require('node:fs');
const path = require('node:path');

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const EMBED_MODEL = 'bge-m3';
const DATA_DIR = path.join(__dirname, '..', 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const VECTOR_FILE = path.join(DATA_DIR, 'vectors.bin');

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / length);
}

// onCpu keeps the embedding model out of GPU memory. One question embeds in ~0.2 s on the CPU,
// while sharing the GPU would make Ollama unload and reload the chat model on every question.
async function embed(texts, { onCpu = false } = {}) {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, options: onCpu ? { num_gpu: 0 } : undefined }),
  });
  if (!res.ok) throw new Error(`Ollama /api/embed: HTTP ${res.status} ${await res.text()}`);
  const { embeddings } = await res.json();
  return embeddings.map(normalize);
}

// index.json holds { model, dim, built, docs, chunks }; vectors.bin holds chunks.length * dim floats.
// Returns null when there is no index, or when it is caught half-written by a running ingest.
function loadIndex() {
  if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(VECTOR_FILE)) return null;
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const bytes = fs.readFileSync(VECTOR_FILE);
  if (bytes.byteLength !== index.chunks.length * index.dim * 4) return null;
  index.vectors = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return index;
}

function indexModifiedAt() {
  return fs.existsSync(INDEX_FILE) ? fs.statSync(INDEX_FILE).mtimeMs : 0;
}

function saveIndex({ vectors, ...index }) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VECTOR_FILE + '.tmp', Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  fs.writeFileSync(INDEX_FILE + '.tmp', JSON.stringify(index));
  fs.renameSync(VECTOR_FILE + '.tmp', VECTOR_FILE);
  fs.renameSync(INDEX_FILE + '.tmp', INDEX_FILE);
}

// Returns the `count` best passages as [{ chunk, score }], best first.
function search(index, queryVector, count) {
  const { vectors, dim, chunks } = index;
  const best = [];
  for (let i = 0; i < chunks.length; i++) {
    let score = 0;
    const offset = i * dim;
    for (let j = 0; j < dim; j++) score += vectors[offset + j] * queryVector[j];
    if (best.length < count || score > best[best.length - 1].score) {
      best.push({ chunk: i, score });
      best.sort((a, b) => b.score - a.score);
      if (best.length > count) best.pop();
    }
  }
  return best;
}

module.exports = { EMBED_MODEL, embed, loadIndex, indexModifiedAt, saveIndex, search };
