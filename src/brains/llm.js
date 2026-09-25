import { BrainError } from './systemone.js';
import { confidenceOf, normalizeProbs } from '../protocol.js';

// Adapter that lets any OpenAI-compatible chat model (OpenAI, OpenRouter, Ollama, vLLM, LM Studio...)
// pilot a fighter. It translates the System One request into a JSON-only prompt and translates the
// reply back, so the same fighter file can be driven by Jev or by a chat LLM for comparison.
// LLM "probabilities" are self-reported, not calibrated. That difference is part of the show.

export function createLlmBrain({ id = 'llm', label, baseUrl = 'https://api.openai.com/v1', apiKey, model, timeoutMs = 20000 }) {
  if (!model) throw new Error('LLM brain needs a model name (set LLM_MODEL)');
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  return {
    id,
    label: label || `LLM · ${model}`,
    kind: 'llm',
    model,
    pricePerMillion: null,
    async decide(request) {
      const started = now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You are a split-second decision function inside a real-time game. Reply with a single JSON object and nothing else.' },
              { role: 'user', content: toPrompt(request) },
            ],
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new BrainError(err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : `network error: ${err?.message || err}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new BrainError(`${model} answered HTTP ${res.status}: ${detail}`, { status: res.status, fatal: res.status === 401 || res.status === 404 });
      }
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content || '{}';
      const response = fromReply(request, text);
      response.usage = { input_tokens: body?.usage?.prompt_tokens ?? 0, output_tokens: body?.usage?.completion_tokens ?? 0 };
      return { response, latencyMs: Math.round(now() - started) };
    },
  };
}

export function toPrompt(request) {
  const lines = ['STATE:', JSON.stringify(request.state), '', 'Answer every question below.'];
  const shape = {};
  for (const [name, q] of Object.entries(request.questions)) {
    if (q.type === 'choice') {
      lines.push(`- "${name}" (pick one option): ${q.instructions}`);
      for (const [opt, desc] of Object.entries(q.criteria)) lines.push(`    * ${opt}: ${desc ?? ''}`);
      shape[name] = { probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, 0.0])) };
    } else if (q.type === 'noul') {
      lines.push(`- "${name}" (probability from 0 to 1 that this is true): ${q.instructions}`);
      shape[name] = { p: 0.0 };
    }
  }
  lines.push('', 'Reply with JSON shaped exactly like this, with your numbers filled in (choice probabilities must sum to 1):');
  lines.push(JSON.stringify(shape));
  return lines.join('\n');
}

export function fromReply(request, text) {
  let parsed = {};
  try {
    parsed = JSON.parse(String(text).replace(/^```(json)?|```$/gm, '').trim());
  } catch {
    parsed = {};
  }
  const answers = {};
  for (const [name, q] of Object.entries(request.questions)) {
    const a = parsed[name] || {};
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const probabilities = normalizeProbs(a.probabilities || {}, options);
      let choice = null;
      for (const o of options) if (choice === null || probabilities[o] > probabilities[choice]) choice = o;
      if (Object.values(probabilities).every((p) => p === 0)) choice = options.includes(a.choice) ? a.choice : null;
      answers[name] = { type: 'choice', choice, probabilities, confidence: confidenceOf(probabilities) };
    } else if (q.type === 'noul') {
      const p = Number(a.p ?? a.noul ?? a.probability);
      if (Number.isFinite(p)) answers[name] = { type: 'noul', noul: Math.max(0, Math.min(1, p)) };
    }
  }
  return { model: 'llm', answers };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
