import fs from 'node:fs';
import path from 'node:path';
import { loadFighters } from './fighters.js';
import { ROOT } from './server.js';

// Build a fully static copy of the arena (for GitHub Pages or any static host).
// Visitors can watch every ladder and season replay, run live fights with the offline mock brain,
// and open the broadcast overlay. Jev itself needs the local server: the TypeSafe API doesn't
// accept requests from other websites, so a static page can't call it.

const BROWSER_SRC = ['engine', 'brains/mock.js', 'protocol.js', 'fighter.js', 'match.js', 'replay.js'];

export function buildSite({ out, fightersDir = path.join(ROOT, 'fighters'), ladderDir = path.join(ROOT, 'ladder'), seasonsDir = path.join(ROOT, 'seasons') }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'data'), { recursive: true });

  copy(path.join(ROOT, 'web'), path.join(out, 'web'));
  fs.copyFileSync(path.join(ROOT, 'web', 'index.html'), path.join(out, 'index.html'));
  for (const rel of BROWSER_SRC) copy(path.join(ROOT, 'src', rel), path.join(out, 'src', rel));
  copy(fightersDir, path.join(out, 'fighters'));
  if (fs.existsSync(ladderDir)) copy(ladderDir, path.join(out, 'ladder'));
  if (fs.existsSync(seasonsDir)) copy(seasonsDir, path.join(out, 'seasons'));
  copy(path.join(ROOT, 'highlights'), path.join(out, 'highlights'));
  if (!fs.existsSync(path.join(out, 'seasons', 'index.json'))) {
    fs.mkdirSync(path.join(out, 'seasons'), { recursive: true });
    fs.writeFileSync(path.join(out, 'seasons', 'index.json'), JSON.stringify({ seasons: [] }));
  }

  const list = loadFighters(fightersDir);
  fs.writeFileSync(path.join(out, 'data', 'fighters.json'), JSON.stringify({ fighters: list.filter((r) => r.ok).map((r) => r.fighter), invalid: [] }));
  fs.writeFileSync(
    path.join(out, 'data', 'config.json'),
    JSON.stringify({
      mode: 'static',
      version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
      brains: [
        { id: 'mock', label: 'Mock (offline heuristics)', kind: 'mock', ready: true },
        { id: 'mock-slow', label: 'Mock (slow, simulates a 1.5s LLM)', kind: 'mock', ready: true },
      ],
    }),
  );
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

function copy(src, dst) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) copy(path.join(src, n), path.join(dst, n));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
