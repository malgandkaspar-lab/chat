// Where the two models (search and chat) run.
//
//   ollama      on this machine; the default when the server is started locally
//   cloudflare  Cloudflare Workers AI, used in the cloud when its account id and token are
//               set. It has a free daily allowance and offers bge-m3, the very model the
//               local index is built with, so the same index serves both.
//   vercel      Vercel AI Gateway, the cloud fallback. Paid, and needs its own index
//               (data/cloud/) because it has no bge-m3.
//
// "Cloud" means running on Vercel, or locally with MODELS=cloud or --cloud for testing.
const path = require('node:path');

try {
  // Local-only settings and keys. The file is not in the repository.
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch {
  // no settings file: fine
}

const env = (name) => (process.env[name] || '').trim();
const CLOUD = Boolean(process.env.VERCEL) || env('MODELS') === 'cloud' || process.argv.includes('--cloud');
const PROVIDER = !CLOUD ? 'ollama' : env('CLOUDFLARE_ACCOUNT_ID') && env('CLOUDFLARE_API_TOKEN') ? 'cloudflare' : 'vercel';
const OLLAMA = env('OLLAMA_URL') || 'http://127.0.0.1:11434';
const LOCAL_EMBED_MODEL = 'bge-m3';
const LOCAL_CHAT_OPTIONS = { num_ctx: 4096, temperature: 0.2 };

// Both cloud providers speak the OpenAI wire format, so one client serves either.
const API = {
  cloudflare: {
    base: `https://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/ai/v1`,
    embedModel: '@cf/baai/bge-m3',
    dimensions: 0,
    chatModels: '@cf/openai/gpt-oss-120b',
  },
  vercel: {
    base: 'https://ai-gateway.vercel.sh/v1',
    embedModel: 'openai/text-embedding-3-large',
    dimensions: 1024,
    chatModels: 'anthropic/claude-haiku-4.5',
  },
}[PROVIDER];
const EMBED_MODEL = env('CLOUD_EMBED_MODEL') || API?.embedModel;
const EMBED_DIMENSIONS = Number(process.env.CLOUD_EMBED_DIMENSIONS ?? API?.dimensions);
// Only these may be used from the web page; the first one is the default.
const CHAT_MODELS = (env('CLOUD_CHAT_MODELS') || API?.chatModels || '').split(',').map((name) => name.trim()).filter(Boolean);
const MAX_TOKENS = 1200;

// Whether questions are searched in the separate cloud index rather than the local one.
// The cloud index must be rebuilt (node ingest.js --cloud) whenever its embedding model changes.
const CLOUD_INDEX = PROVIDER === 'vercel';
const embedModel = () => (CLOUD_INDEX ? `${EMBED_MODEL}@${EMBED_DIMENSIONS}` : LOCAL_EMBED_MODEL);

async function token() {
  if (PROVIDER === 'cloudflare') return env('CLOUDFLARE_API_TOKEN');
  if (env('AI_GATEWAY_API_KEY')) return env('AI_GATEWAY_API_KEY');
  // A Vercel deployment proves who it is with a short-lived token, so no key is stored there.
  const { getVercelOidcToken } = require('@vercel/oidc');
  return getVercelOidcToken();
}

async function api(pathname, body, signal) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API.base + pathname, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    // A brief outage passes. A 429 here is the free daily allowance running out, which does not.
    if (res.status >= 500 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      continue;
    }
    const error = new Error(`${PROVIDER} ${pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
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
async function embed(texts, { onCpu = false } = {}) {
  if (PROVIDER !== 'ollama') {
    const body = { model: EMBED_MODEL, input: texts };
    if (EMBED_DIMENSIONS) body.dimensions = EMBED_DIMENSIONS;
    const { data } = await (await api('/embeddings', body)).json();
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
  if (PROVIDER !== 'ollama') {
    const body = { model, messages, stream: true, temperature: 0.2, max_tokens: MAX_TOKENS };
    const res = await api('/chat/completions', body, signal);
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
  if (PROVIDER !== 'ollama') return CHAT_MODELS;
  const { models } = await (await fetch(`${OLLAMA}/api/tags`)).json();
  return models.filter((m) => !m.capabilities || m.capabilities.includes('completion')).map((m) => m.name);
}

module.exports = { CLOUD, PROVIDER, CLOUD_INDEX, embedModel, embed, streamChat, chatModels };
