// The search index: passages with their embedding vectors, searched by cosine similarity.
// There are two of them, because a question must be embedded with the same model as the
// passages: data/ for the local Ollama model and data/cloud/ for the cloud model.
const fs = require('node:fs');
const path = require('node:path');

// Written out in full so that Vercel's file tracing finds the cloud index and bundles it.
const FILES = {
  local: {
    index: path.join(__dirname, '..', 'data', 'index.json'),
    vectors: path.join(__dirname, '..', 'data', 'vectors.bin'),
  },
  cloud: {
    index: path.join(__dirname, '..', 'data', 'cloud', 'index.json'),
    vectors: path.join(__dirname, '..', 'data', 'cloud', 'vectors.bin'),
  },
};
const filesFor = (cloud) => (cloud ? FILES.cloud : FILES.local);

// index.json holds { model, dim, built, docs, chunks }; vectors.bin holds chunks.length * dim floats.
// Returns null when there is no index, or when it is caught half-written by a running ingest.
function loadIndex(cloud = false) {
  const files = filesFor(cloud);
  if (!fs.existsSync(files.index) || !fs.existsSync(files.vectors)) return null;
  const index = JSON.parse(fs.readFileSync(files.index, 'utf8'));
  const bytes = fs.readFileSync(files.vectors);
  if (bytes.byteLength !== index.chunks.length * index.dim * 4) return null;
  index.vectors = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return index;
}

function indexModifiedAt(cloud = false) {
  const { index } = filesFor(cloud);
  return fs.existsSync(index) ? fs.statSync(index).mtimeMs : 0;
}

function saveIndex({ vectors, ...index }, cloud = false) {
  const files = filesFor(cloud);
  fs.mkdirSync(path.dirname(files.index), { recursive: true });
  fs.writeFileSync(files.vectors + '.tmp', Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  fs.writeFileSync(files.index + '.tmp', JSON.stringify(index));
  fs.renameSync(files.vectors + '.tmp', files.vectors);
  fs.renameSync(files.index + '.tmp', files.index);
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

module.exports = { loadIndex, indexModifiedAt, saveIndex, search };
