import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENGINE_VERSION } from '../engine/constants.js';
import { Match } from '../match.js';
import { pairings, makeBoard, toMarkdown, chooseFormat, swissRoundsFor, swissPairRound, swissMatches, pairKey, scoreOf } from '../ladder-core.js';

export { pairings, estimate, buildTable, toMarkdown, makeBoard, chooseFormat, swissRoundsFor } from '../ladder-core.js';

// Fingerprint of everything that decides a ladder's outcome. If it matches the committed
// leaderboard, re-running would only spend tokens to reproduce the same kind of result.
// A round robin keeps the original fingerprint shape, so existing ladders stay "current".
export function ladderInputsHash({ fighters, brainId, mode, games, format = 'roundrobin', rounds = null }) {
  const base = { engine: ENGINE_VERSION, brainId, mode, games, fighters: [...fighters].sort((a, b) => a.id.localeCompare(b.id)) };
  const canon = JSON.stringify(format === 'swiss' ? { ...base, format, rounds } : base);
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

export function ladderIsCurrent({ fighters, brainId, mode, games, outDir, format = 'roundrobin', rounds = null }) {
  try {
    const board = JSON.parse(fs.readFileSync(path.join(outDir, 'leaderboard.json'), 'utf8'));
    return board.inputs === ladderInputsHash({ fighters, brainId, mode, games, format, rounds });
  } catch {
    return false;
  }
}

// format: 'roundrobin' | 'swiss' | 'auto' (Swiss above AUTO_SWISS_ABOVE fighters).
export async function runLadder({ fighters, makeBrain, brainId, mode = 'realtime', games = 2, concurrency = 2, outDir, format = 'auto', rounds = null, onMatch = () => {}, onRound = () => {} }) {
  const fmt = chooseFormat(format, fighters.length);
  const byId = Object.fromEntries(fighters.map((f) => [f.id, f]));
  const results = [];
  let done = 0;
  let fatal = null;

  fs.rmSync(path.join(outDir, 'replays'), { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'replays'), { recursive: true });

  async function play(plan, total) {
    const slots = new Array(plan.length);
    let cursor = 0;
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
        slots[idx] = { ...m, result: replay.result, summary: replay.summary, file };
        done += 1;
        onMatch(slots[idx], done, total);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (fatal) throw fatal;
    return slots;
  }

  let totalRounds = null;
  const byes = {};
  if (fmt === 'roundrobin') {
    const plan = pairings(fighters, games);
    results.push(...(await play(plan, plan.length)));
  } else {
    totalRounds = rounds ?? swissRoundsFor(fighters.length);
    const ids = fighters.map((f) => f.id);
    const points = new Map(ids.map((id) => [id, 0]));
    const played = new Set();
    const byeSet = new Set();
    const total = totalRounds * Math.floor(ids.length / 2) * games;
    for (let round = 1; round <= totalRounds; round++) {
      const { pairs, bye } = swissPairRound(ids, points, played, byeSet);
      if (bye) {
        byeSet.add(bye);
        byes[bye] = (byes[bye] || 0) + 1;
        points.set(bye, points.get(bye) + games);
      }
      onRound(round, totalRounds, pairs, bye);
      const plan = swissMatches(pairs, games, round, played);
      const got = await play(plan, total);
      for (const r of got) {
        const [sa, sb] = scoreOf(r.result);
        points.set(r.a, points.get(r.a) + sa);
        points.set(r.b, points.get(r.b) + sb);
      }
      for (const [x, y] of pairs) played.add(pairKey(x, y));
      results.push(...got);
    }
  }

  const board = makeBoard({ fighters, results, brainId, mode, games, format: fmt, rounds: totalRounds, byes });
  board.inputs = ladderInputsHash({ fighters, brainId, mode, games, format: fmt, rounds: totalRounds });
  fs.writeFileSync(path.join(outDir, 'leaderboard.json'), JSON.stringify(board, null, 2));
  fs.writeFileSync(path.join(outDir, 'LEADERBOARD.md'), toMarkdown(board));
  return board;
}
