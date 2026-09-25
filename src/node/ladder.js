import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENGINE_VERSION } from '../engine/constants.js';
import { Match } from '../match.js';
import { pairings, makeBoard, toMarkdown } from '../ladder-core.js';

export { pairings, estimate, buildTable, toMarkdown, makeBoard } from '../ladder-core.js';

// Fingerprint of everything that decides a ladder's outcome. If it matches the committed
// leaderboard, re-running would only spend tokens to reproduce the same kind of result.
export function ladderInputsHash({ fighters, brainId, mode, games }) {
  const canon = JSON.stringify({ engine: ENGINE_VERSION, brainId, mode, games, fighters: [...fighters].sort((a, b) => a.id.localeCompare(b.id)) });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

export function ladderIsCurrent({ fighters, brainId, mode, games, outDir }) {
  try {
    const board = JSON.parse(fs.readFileSync(path.join(outDir, 'leaderboard.json'), 'utf8'));
    return board.inputs === ladderInputsHash({ fighters, brainId, mode, games });
  } catch {
    return false;
  }
}

export async function runLadder({ fighters, makeBrain, brainId, mode = 'realtime', games = 2, concurrency = 2, outDir, onMatch = () => {} }) {
  const plan = pairings(fighters, games);
  const byId = Object.fromEntries(fighters.map((f) => [f.id, f]));
  const results = new Array(plan.length);
  let cursor = 0;
  let fatal = null;

  fs.rmSync(path.join(outDir, 'replays'), { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'replays'), { recursive: true });

  async function worker() {
    while (cursor < plan.length && !fatal) {
      const idx = cursor++;
      const m = plan[idx];
      const match = new Match({ fighters: [byId[m.a], byId[m.b]], brains: [makeBrain(), makeBrain()], seed: m.seed, mode });
      const replay = await match.run({ paced: false });
      if (match.fatal) {
        fatal = match.fatal;
        break;
      }
      const file = `replays/${m.key}.json`;
      fs.writeFileSync(path.join(outDir, file), JSON.stringify(replay));
      results[idx] = { ...m, result: replay.result, summary: replay.summary, file };
      onMatch(results[idx], idx + 1, plan.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (fatal) throw fatal;

  const board = makeBoard({ fighters, results, brainId, mode, games });
  board.inputs = ladderInputsHash({ fighters, brainId, mode, games });
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(board, null, 2));
  fs.writeFileSync(path.join(outDir, 'LEADERBOARD.md'), toMarkdown(board));
  return board;
}

