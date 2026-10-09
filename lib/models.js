// Where the two models (search and chat) run: Ollama on this machine, or Vercel AI Gateway
// in the cloud. Cloud mode is used on Vercel, and locally when MODELS=cloud is set or
// --cloud is passed, which is how the cloud index gets built and tested.
const path = require('node:path');

try {
  // Local-only settings such as AI_GATEWAY_API_KEY. The file is not in the repository.
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch {
  // no settings file: fine
}

const CLOUD = Boolean(process.env.VERCEL) || process.env.MODELS === 'cloud' || process.argv.includes('--cloud');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const GATEWAY = 'https://ai-gateway.vercel.sh/v1';

const LOCAL_EMBED_MODEL = 'bge-m3';
// The cloud index must be rebuilt (node ingest.js --cloud) whenever these two change.
const CLOUD_EMBED_MODEL = process.env.CLOUD_EMBED_MODEL || 'openai/text-embedding-3-large';
const CLOUD_EMBED_DIMENSIONS = Number(process.env.CLOUD_EMBED_DIMENSIONS ?? 1024);
// Only these may be used from the web page; the first one is the default.
const CLOUD_CHAT_MODELS = (process.env.CLOUD_CHAT_MODELS || 'anthropic/claude-haiku-4.5')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const CLOUD_MAX_TOKENS = 800;
const LOCAL_CHAT_OPTIONS = { num_ctx: 4096, temperature: 0.2 };

const embedModel = (cloud = CLOUD) => (cloud ? `${CLOUD_EMBED_MODEL}@${CLOUD_EMBED_DIMENSIONS}` : LOCAL_EMBED_MODEL);

async function gatewayToken() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  // A Vercel deployment proves who it is with a short-lived token, so no key is stored there.
  const { getVercelOidcToken } = require('@vercel/oidc');
  return getVercelOidcToken();
}

async function gateway(pathname, body, signal) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(GATEWAY + pathname, {
      method: 'POST',
      headers: { authorization: `Bearer ${await gatewayToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    // Rate limits and brief outages pass; anything else will not improve by repeating.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    const error = new Error(`AI Gateway ${pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, (value) => value / length);
}

// onCpu (Ollama only) keeps the search model out of GPU memory. One question embeds in
// ~0.2 s on the CPU, while sharing the GPU would make Ollama unload and reload the chat
// model on every question.
async function embed(texts, { cloud = CLOUD, onCpu = false } = {}) {
  if (cloud) {
    const body = { model: CLOUD_EMBED_MODEL, input: texts };
    if (CLOUD_EMBED_DIMENSIONS) body.dimensions = CLOUD_EMBED_DIMENSIONS;
    const { data } = await (await gateway('/embeddings', body)).json();
    return data.sort((a, b) => a.index - b.index).map((item) => normalize(item.embedding));
  }
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts, options: onCpu ? { num_gpu: 0 } : undefined }),
  });
  if (!res.ok) throw new Error(`Ollama /api/embed: HTTP ${res.status} ${await res.text()}`);
  const { embeddings } = await res.json();
  return embeddings.map(normalize);
}

async function readLines(body, onLine) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}

// Streams the reply, calling onPart({ content, thinking }) for each piece as it arrives.
async function streamChat({ model, messages, signal }, onPart) {
  if (CLOUD) {
    const body = { model, messages, stream: true, temperature: 0.2, max_tokens: CLOUD_MAX_TOKENS };
    const res = await gateway('/chat/completions', body, signal);
    await readLines(res.body, (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const content = JSON.parse(data).choices?.[0]?.delta?.content;
      if (content) onPart({ content });
    });
    return;
  }
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: LOCAL_CHAT_OPTIONS }),
    signal,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Ollama HTTP ${res.status}`);
  await readLines(res.body, (line) => {
    const part = JSON.parse(line);
    if (part.error) throw new Error(part.error);
    const { content, thinking } = part.message || {};
    if (content || thinking) onPart({ content, thinking });
  });
}

// The chat models the page may offer, default first.
async function chatModels() {
  if (CLOUD) return CLOUD_CHAT_MODELS;
  const { models } = await (await fetch(`${OLLAMA}/api/tags`)).json();
  return models.filter((m) => !m.capabilities || m.capabilities.includes('completion')).map((m) => m.name);
}

module.exports = { CLOUD, embedModel, embed, streamChat, chatModels };
