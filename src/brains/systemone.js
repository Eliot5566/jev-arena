// A brain that talks to any TypeSafe System One compatible endpoint:
//   - Jev itself:  https://api.typesafe.ai/v1/systemone  (needs TYPESAFE_API_KEY)
//   - Laya:        `laya-serve` exposes a Jev-compatible HTTP server
//   - kev:         ships a TypeSafe-compatible API
// Works in Node 20+ and in browsers (when the endpoint allows CORS).

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

export class BrainError extends Error {
  constructor(message, { status, fatal = false } = {}) {
    super(message);
    this.name = 'BrainError';
    this.status = status;
    this.fatal = fatal;
  }
}

export function createSystemOneBrain({ id, label, url = JEV_URL, apiKey, model = 'jev-latest', timeoutMs = 8000, pricePerMillion = null }) {
  return {
    id,
    label: label || id,
    kind: 'systemone',
    model,
    pricePerMillion,
    async decide(request) {
      const started = now();
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ ...request, model }),
          signal: ctrl?.signal,
        });
      } catch (err) {
        throw new BrainError(err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : `network error: ${err?.message || err}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const latencyMs = Math.round(now() - started);
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {}
        const fatal = res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422;
        throw new BrainError(`${label || id} answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status, fatal });
      }
      const response = await res.json();
      return { response, latencyMs };
    },
  };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
