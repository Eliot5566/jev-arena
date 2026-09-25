import { createMockBrain } from '../brains/mock.js';
import { createSystemOneBrain, JEV_URL } from '../brains/systemone.js';
import { createLlmBrain } from '../brains/llm.js';
import { JEV_USD_PER_MILLION_INPUT } from '../engine/constants.js';

// Brains available to this process, discovered from the environment:
//   mock                 always
//   jev                  TYPESAFE_API_KEY (optional TYPESAFE_BASE_URL, JEV_MODEL)
//   <name>               JEV_ARENA_ENDPOINTS="laya=http://localhost:8000/v1/systemone;kev=http://localhost:8080/v1/systemone"
//   llm                  LLM_MODEL (+ OPENAI_API_KEY, OPENAI_BASE_URL for OpenRouter/Ollama/etc.)
// Ad-hoc specs are also accepted anywhere a brain id is: "http://host/v1/systemone" or "llm:<model>".

export function discoverBrains(env = process.env) {
  const list = [{ id: 'mock', label: 'Mock (offline heuristics)', kind: 'mock', ready: true }];
  list.push({
    id: 'jev',
    label: `Jev · ${env.JEV_MODEL || 'jev-latest'}`,
    kind: 'systemone',
    ready: !!env.TYPESAFE_API_KEY,
    hint: env.TYPESAFE_API_KEY ? undefined : 'Set TYPESAFE_API_KEY to enable',
  });
  for (const [name, url] of parseEndpoints(env.JEV_ARENA_ENDPOINTS)) {
    list.push({ id: name, label: `${name} · System One endpoint`, kind: 'systemone', ready: true, url });
  }
  if (env.LLM_MODEL) list.push({ id: 'llm', label: `LLM · ${env.LLM_MODEL}`, kind: 'llm', ready: true });
  return list;
}

export function createBrain(spec, env = process.env) {
  const id = String(spec || 'mock').trim();
  if (id === 'mock') return createMockBrain();
  if (id === 'mock-slow') return createMockBrain({ id: 'mock-slow', label: 'Mock (slow, simulates a 1.5s LLM)', latencyMs: [1200, 1800] });
  if (id === 'instant') return createMockBrain({ id: 'instant', label: 'Mock (instant)', latencyMs: [0, 0] });
  if (id === 'jev') {
    if (!env.TYPESAFE_API_KEY) throw new Error('The jev brain needs TYPESAFE_API_KEY. Get a key at https://console.typesafe.ai/keys');
    return createSystemOneBrain({
      id: 'jev',
      label: `Jev · ${env.JEV_MODEL || 'jev-latest'}`,
      url: env.TYPESAFE_BASE_URL || JEV_URL,
      apiKey: env.TYPESAFE_API_KEY,
      model: env.JEV_MODEL || 'jev-latest',
      pricePerMillion: JEV_USD_PER_MILLION_INPUT,
    });
  }
  const endpoint = parseEndpoints(env.JEV_ARENA_ENDPOINTS).find(([name]) => name === id);
  if (endpoint) return createSystemOneBrain({ id, label: `${id} · System One endpoint`, url: endpoint[1], apiKey: env[`${id.toUpperCase()}_API_KEY`], model: env[`${id.toUpperCase()}_MODEL`] || 'jev-latest' });
  if (/^https?:\/\//.test(id)) return createSystemOneBrain({ id: new URL(id).host, label: `${new URL(id).host} · System One endpoint`, url: id });
  if (id === 'llm' || id.startsWith('llm:')) {
    const model = id.startsWith('llm:') ? id.slice(4) : env.LLM_MODEL;
    return createLlmBrain({ id, model, baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: env.OPENAI_API_KEY });
  }
  throw new Error(`Unknown brain "${id}". Try: mock, jev, llm:<model>, or a System One URL.`);
}

function parseEndpoints(s) {
  if (!s) return [];
  return s
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : null;
    })
    .filter(Boolean);
}
