import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFighters } from './fighters.js';
import { discoverBrains, createBrain } from './brains.js';
import { validateFighter } from '../fighter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

// Public static roots. src/node is deliberately not served.
const STATIC = [
  ['/web/', 'web'],
  ['/src/', 'src'],
  ['/fighters/', 'fighters'],
  ['/ladder/', 'ladder'],
  ['/seasons/', 'seasons'],
  ['/highlights/', 'highlights'],
];

export function startServer({ port = 5173, host = '127.0.0.1', fightersDir = path.join(ROOT, 'fighters'), env = process.env } = {}) {
  const brainCache = new Map();
  const getBrain = (id) => {
    if (!brainCache.has(id)) brainCache.set(id, createBrain(id, env));
    return brainCache.get(id);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(ROOT, 'web', 'index.html'));
      if (p === '/data/config.json') {
        return sendJson(res, 200, {
          mode: 'server',
          version: readVersion(),
          brains: discoverBrains(env).concat([{ id: 'mock-slow', label: 'Mock (slow, simulates a 1.5s LLM)', kind: 'mock', ready: true }]),
        });
      }
      if (p === '/seasons/index.json' && !fs.existsSync(path.join(ROOT, 'seasons', 'index.json'))) return sendJson(res, 200, { seasons: [] });
      if (p === '/data/fighters.json') {
        const list = loadFighters(fightersDir);
        return sendJson(res, 200, {
          fighters: list.filter((r) => r.ok).map((r) => r.fighter),
          invalid: list.filter((r) => !r.ok).map((r) => ({ file: path.basename(r.file), errors: r.errors })),
        });
      }
      if (p === '/api/decide' && req.method === 'POST') {
        const id = url.searchParams.get('brain') || 'mock';
        let brain;
        try {
          brain = getBrain(id);
        } catch (err) {
          return sendJson(res, 400, { error: err.message, fatal: true });
        }
        const body = await readBody(req, 128 * 1024);
        try {
          const out = await brain.decide(JSON.parse(body));
          return sendJson(res, 200, out);
        } catch (err) {
          return sendJson(res, 502, { error: err.message, status: err.status, fatal: !!err.fatal });
        }
      }
      if (p === '/api/validate' && req.method === 'POST') {
        const body = await readBody(req, 64 * 1024);
        return sendJson(res, 200, validateFighter(JSON.parse(body)));
      }
      for (const [prefix, dir] of STATIC) {
        if (p.startsWith(prefix)) {
          const rel = p.slice(prefix.length);
          const base = path.join(ROOT, dir);
          const file = path.resolve(base, rel);
          const relToRoot = path.relative(ROOT, file);
          if (!file.startsWith(base + path.sep) || relToRoot.startsWith(path.join('src', 'node') + path.sep)) break;
          return sendFile(res, file);
        }
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export { ROOT };
