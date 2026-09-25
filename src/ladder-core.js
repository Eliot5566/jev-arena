import { hashSeed } from './engine/rng.js';
import { MATCH_SECONDS, JEV_USD_PER_MILLION_INPUT } from './engine/constants.js';

// Round robin: every pair plays `games` fights, alternating sides. Results feed an Elo table.
// Seeds derive from the pairing, so re-running the ladder on the same fighters replays the
// same maps and power-up spawns; only the brains' answers can change the outcome.

export function pairings(fighters, games = 2) {
  const ids = fighters.map((f) => f.id).sort();
  const out = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      for (let g = 0; g < games; g++) {
        const [a, b] = g % 2 === 0 ? [ids[i], ids[j]] : [ids[j], ids[i]];
        out.push({ key: `${ids[i]}__${ids[j]}__g${g + 1}`, a, b, seed: hashSeed(`${ids[i]}|${ids[j]}|${g}`) });
      }
  return out;
}

// Defaults come from the first real Jev ladder: ~3.7 decisions/s per fighter, ~1,400 input
// tokens per decision, and fights that last ~36 s on average (most end in a KO).
export function estimate(fighters, games, { format = 'roundrobin', rounds = null, decisionsPerSecond = 3.7, tokensPerDecision = 1400, avgSeconds = 40 } = {}) {
  const n = fighters.length;
  const matches = format === 'swiss' ? (rounds ?? swissRoundsFor(n)) * Math.floor(n / 2) * games : pairings(fighters, games).length;
  const calls = Math.round(matches * 2 * decisionsPerSecond * Math.min(avgSeconds, MATCH_SECONDS));
  const tokens = calls * tokensPerDecision;
  return { matches, calls, tokens, usd: (tokens / 1e6) * JEV_USD_PER_MILLION_INPUT };
}

// ---------------------------------------------------------------------------------------------
// Swiss system, for fields too big to play everyone against everyone. Each round pairs fighters
// with similar scores who haven't met yet; every pairing still plays `games` fights, sides swapped.

export const AUTO_SWISS_ABOVE = 16;

export function chooseFormat(format, n) {
  if (format === 'swiss' || format === 'roundrobin') return format;
  return n > AUTO_SWISS_ABOVE ? 'swiss' : 'roundrobin';
}

export function swissRoundsFor(n) {
  return Math.max(1, Math.min(n - 1, Math.ceil(Math.log2(Math.max(2, n))) + 2));
}

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// points: Map id -> score so far. played: Set of pairKey. byes: Set of ids that already sat out.
export function swissPairRound(ids, points, played, byes) {
  const order = [...ids].sort((x, y) => (points.get(y) || 0) - (points.get(x) || 0) || x.localeCompare(y));
  let bye = null;
  if (order.length % 2) {
    bye = [...order].reverse().find((id) => !byes.has(id)) ?? order[order.length - 1];
    order.splice(order.indexOf(bye), 1);
  }
  let budget = 20000;
  const search = (list) => {
    if (!list.length) return [];
    if (--budget < 0) return null;
    const [first, ...rest] = list;
    for (let k = 0; k < rest.length; k++) {
      if (played.has(pairKey(first, rest[k]))) continue;
      const sub = search(rest.filter((_, i) => i !== k));
      if (sub) return [[first, rest[k]], ...sub];
    }
    return null;
  };
  let pairs = search(order);
  if (!pairs) {
    // Everyone left has met: allow rematches, still pairing neighbours in the standings.
    pairs = [];
    for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
  }
  return { pairs, bye };
}

// The fights for one Swiss round. Seeds depend only on the pair (as in the round robin), plus
// the round number for a rematch so it gets fresh maps.
export function swissMatches(pairs, games, round, played) {
  const out = [];
  for (const [x, y] of pairs) {
    const [lo, hi] = x < y ? [x, y] : [y, x];
    const rematch = played.has(pairKey(lo, hi));
    for (let g = 0; g < games; g++) {
      const [a, b] = g % 2 === 0 ? [lo, hi] : [hi, lo];
      const suffix = rematch ? `__r${round}` : '';
      out.push({ key: `${lo}__${hi}__g${g + 1}${suffix}`, a, b, round, seed: hashSeed(`${lo}|${hi}|${g}${rematch ? `|r${round}` : ''}`) });
    }
  }
  return out;
}

export function scoreOf(result) {
  return result.winner === null ? [0.5, 0.5] : result.winner === 0 ? [1, 0] : [0, 1];
}

export function sumCost(summary) {
  if (!summary) return null;
  const costs = summary.map((s) => s.costUsd).filter((c) => c != null);
  return costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null;
}

export function buildTable(fighters, results) {
  const rows = Object.fromEntries(
    fighters.map((f) => [
      f.id,
      { id: f.id, name: f.name, author: f.author, color: f.color, tagline: f.tagline, elo: 1000, w: 0, d: 0, l: 0, games: 0, damageDealt: 0, damageTaken: 0, kos: 0, decisionsPerSecond: 0, p50LatencyMs: [] },
    ]),
  );
  const K = 24;
  for (const r of results) {
    const A = rows[r.a];
    const B = rows[r.b];
    const expected = 1 / (1 + 10 ** ((B.elo - A.elo) / 400));
    const scoreA = r.result.winner === null ? 0.5 : r.result.winner === 0 ? 1 : 0;
    A.elo += K * (scoreA - expected);
    B.elo += K * (1 - scoreA - (1 - expected));
    for (const [row, side, score] of [
      [A, 0, scoreA],
      [B, 1, 1 - scoreA],
    ]) {
      row.games += 1;
      if (score === 1) row.w += 1;
      else if (score === 0) row.l += 1;
      else row.d += 1;
      if (score === 1 && r.result.reason === 'ko') row.kos += 1;
      const s = r.summary?.[side];
      if (s) {
        row.damageDealt += s.stats.damageDealt;
        row.damageTaken += s.stats.damageTaken;
        row.decisionsPerSecond += s.decisionsPerSecond;
        if (s.p50LatencyMs != null) row.p50LatencyMs.push(s.p50LatencyMs);
      }
    }
  }
  return Object.values(rows)
    .map((r) => ({
      ...r,
      elo: Math.round(r.elo),
      damageDealt: Math.round(r.damageDealt),
      damageTaken: Math.round(r.damageTaken),
      decisionsPerSecond: r.games ? Math.round((r.decisionsPerSecond / r.games) * 10) / 10 : 0,
      p50LatencyMs: r.p50LatencyMs.length ? r.p50LatencyMs.sort((a, b) => a - b)[Math.floor(r.p50LatencyMs.length / 2)] : null,
    }))
    .sort((x, y) => y.elo - x.elo || y.w - x.w || x.id.localeCompare(y.id));
}

export function toMarkdown(board) {
  const format = board.format === 'swiss' ? ` · Swiss, ${board.rounds} rounds` : '';
  const lines = [
    '# Jev Arena ladder',
    '',
    `Brain: \`${board.brain}\` · mode: ${board.mode}${format} · ${board.gamesPerPair} games per pair · updated ${board.generatedAt.slice(0, 16).replace('T', ' ')} UTC` +
      (board.totalCostUsd ? ` · whole ladder cost $${board.totalCostUsd}` : ''),
    '',
    ...(String(board.brain).startsWith('mock') || board.brain === 'instant'
      ? ['> Run with the offline **mock** brain (keyword heuristics, not AI). Add a `TYPESAFE_API_KEY` repository secret and the ladder workflow re-runs it with Jev.', '']
      : []),
    '| # | Fighter | Author | Elo | W-D-L | KOs | Dmg dealt / taken | Decisions/s | p50 latency |',
    '|---|---------|--------|-----|-------|-----|-------------------|-------------|-------------|',
  ];
  board.fighters.forEach((f, i) => {
    lines.push(
      `| ${i + 1} | **${f.name}** | @${f.author} | ${f.elo} | ${f.w}-${f.d}-${f.l} | ${f.kos} | ${f.damageDealt} / ${f.damageTaken} | ${f.decisionsPerSecond} | ${f.p50LatencyMs ?? '–'} ms |`,
    );
  });
  lines.push('', 'Watch any match in the web viewer: `npx jev-arena` → Replays, or on the project site.', '');
  return lines.join('\n');
}

export function makeBoard({ fighters, results, brainId, mode, games, format = 'roundrobin', rounds = null, byes = null }) {
  const table = buildTable(fighters, results);
  if (format === 'swiss') {
    const pts = Object.fromEntries(fighters.map((f) => [f.id, (byes?.[f.id] || 0) * games]));
    for (const r of results) {
      const [sa, sb] = scoreOf(r.result);
      pts[r.a] += sa;
      pts[r.b] += sb;
    }
    for (const row of table) {
      row.points = pts[row.id];
      row.byes = byes?.[row.id] || 0;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    brain: brainId,
    mode,
    gamesPerPair: games,
    ...(format === 'swiss' ? { format, rounds } : {}),
    fighters: table,
    matches: results.map((r) => ({
      ...(r.round ? { round: r.round } : {}),
      key: r.key,
      a: r.a,
      b: r.b,
      winner: r.result.winner === null ? null : r.result.winner === 0 ? r.a : r.b,
      reason: r.result.reason,
      seconds: Math.round((r.result.tick / 20) * 10) / 10,
      hp: r.result.hp,
      file: r.file,
      costUsd: sumCost(r.summary),
    })),
    totalCostUsd: Math.round(results.reduce((s, r) => s + (sumCost(r.summary) || 0), 0) * 1e5) / 1e5,
  };
}
