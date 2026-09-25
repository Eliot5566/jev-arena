import path from 'node:path';
import { hashSeed } from '../engine/rng.js';
import { TICK_HZ } from '../engine/constants.js';
import { Match } from '../match.js';
import { loadFighterFile, loadFighters } from './fighters.js';
import { createBrain } from './brains.js';

// Quick sanity check for a fighter file before it joins the ladder: validate it, then fight
// every fighter already in the field twice (sides swapped) with an offline brain. It proves the
// file runs end to end; it says nothing about how strong the fighter is with Jev.

export async function runSmoke({ file, fightersDir, brainId = 'instant', games = 2, mode = 'lockstep' }) {
  const me = loadFighterFile(path.resolve(file));
  const report = { file, ok: me.ok, errors: me.errors, fighter: me.fighter, brainId, games, mode, opponents: [], record: { w: 0, d: 0, l: 0 } };
  if (!me.ok) return report;
  const field = loadFighters(fightersDir)
    .filter((r) => r.ok && r.fighter.id !== me.fighter.id)
    .map((r) => r.fighter);
  for (const opp of field) {
    const row = { id: opp.id, name: opp.name, games: [] };
    for (let g = 0; g < games; g++) {
      const meFirst = g % 2 === 0;
      const fighters = meFirst ? [me.fighter, opp] : [opp, me.fighter];
      const match = new Match({ fighters, brains: [createBrain(brainId), createBrain(brainId)], seed: hashSeed(`smoke|${me.fighter.id}|${opp.id}|${g}`), mode });
      const replay = await match.run({ paced: false });
      if (match.fatal) throw match.fatal;
      const r = replay.result;
      const mine = meFirst ? 0 : 1;
      const outcome = r.winner === null ? 'draw' : r.winner === mine ? 'win' : 'loss';
      report.record[outcome === 'win' ? 'w' : outcome === 'loss' ? 'l' : 'd'] += 1;
      row.games.push({ outcome, reason: r.reason, seconds: Math.round((r.tick / TICK_HZ) * 10) / 10, hpMe: Math.round(r.hp[mine]), hpOpp: Math.round(r.hp[1 - mine]) });
    }
    report.opponents.push(row);
  }
  return report;
}

const cellText = (g) => {
  const how = g.reason === 'ko' ? `KO ${g.seconds}s` : 'on health';
  if (g.outcome === 'draw') return `Draw (${g.hpMe}–${g.hpOpp})`;
  return `${g.outcome === 'win' ? 'Won' : 'Lost'} · ${how} (${g.hpMe}–${g.hpOpp} HP)`;
};

export function smokeMarkdown(report) {
  if (!report.ok) {
    return [`### ❌ ${report.file} is not a valid fighter`, '', ...report.errors.map((e) => `- ${e}`), ''].join('\n');
  }
  const f = report.fighter;
  const lines = [
    `### ✅ ${f.name} by @${f.author}`,
    '',
    `\`${report.file}\` is valid: ${f.strategy.length}-character strategy, ${f.reflexes.length} reflex${f.reflexes.length === 1 ? '' : 'es'}.`,
    '',
    `Smoke test against the current field with the offline \`${report.brainId}\` brain (${report.mode}, ${report.games} games per opponent, sides swapped). This only proves the fighter runs; the ladder itself is played by Jev after the PR is merged.`,
    '',
    `| Opponent | ${Array.from({ length: report.games }, (_, i) => `Game ${i + 1}`).join(' | ')} |`,
    `|---|${'---|'.repeat(report.games)}`,
    ...report.opponents.map((o) => `| ${o.name} | ${o.games.map(cellText).join(' | ')} |`),
    '',
    `**Record vs the field (offline brain): ${report.record.w}-${report.record.d}-${report.record.l}**`,
    '',
  ];
  return lines.join('\n');
}

export function smokeText(report) {
  if (!report.ok) return `  ✖ ${report.file}\n${report.errors.map((e) => `    - ${e}`).join('\n')}\n`;
  const f = report.fighter;
  const out = [`  ${f.name} by @${f.author}: smoke test vs ${report.opponents.length} fighters (${report.brainId}, ${report.mode})`];
  for (const o of report.opponents) out.push(`    vs ${o.name.padEnd(16)} ${o.games.map(cellText).join('   ')}`);
  out.push(`  record ${report.record.w}-${report.record.d}-${report.record.l}`);
  return out.join('\n') + '\n';
}
