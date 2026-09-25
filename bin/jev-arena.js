#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, ROOT } from '../src/node/server.js';
import { loadFighters, loadFighterFile, resolveFighter } from '../src/node/fighters.js';
import { createBrain, discoverBrains } from '../src/node/brains.js';
import { runLadder, estimate, ladderIsCurrent, chooseFormat, swissRoundsFor } from '../src/node/ladder.js';
import { runSmoke, smokeMarkdown, smokeText } from '../src/node/smoke.js';
import { archiveSeason, readSeasonIndex } from '../src/node/season.js';
import { buildSite } from '../src/node/site.js';
import { Match } from '../src/match.js';
import { verifyReplay } from '../src/replay.js';
import { TICK_HZ } from '../src/engine/constants.js';

const HELP = `
jev-arena · write a fighter in plain English, let a System One model pilot it

Usage
  jev-arena [serve]                       open the arena in your browser (default)
  jev-arena fight <red> <blue> [options]  run one fight in the terminal
  jev-arena ladder [options]              play the ladder (round robin, or Swiss for big fields), write ladder/
  jev-arena validate [files...]           check fighter files (default: fighters/*.yaml)
  jev-arena smoke <file> [--markdown]     validate one fighter and test it against the field (offline brain)
  jev-arena season archive <id>           freeze ladder/ into seasons/<id>/ and update the Hall of Fame
  jev-arena season list                   show archived seasons
  jev-arena brains                        list the brains this machine can use
  jev-arena build-site [--out dist]       build the static site for GitHub Pages
  jev-arena verify <replay.json>          re-simulate a replay and check the result

Fight / ladder options
  --brain <id>        brain for both sides: mock | jev | llm:<model> | <System One URL>  (default: jev if TYPESAFE_API_KEY is set, else mock)
  --red <id>          brain for the red side      --blue <id>   brain for the blue side
  --mode <m>          realtime (default) or lockstep
  --seed <n>          map seed
  --out <file>        save the replay (fight) / output folder (ladder, default ./ladder)
  --games <n>         games per pair in the ladder (default 2)
  --concurrency <n>   parallel ladder matches (default 2)
  --dry-run           ladder: print the cost estimate and exit
  --format <f>        ladder: auto (default: Swiss above 16 fighters) | roundrobin | swiss
  --rounds <n>        ladder: Swiss rounds (default: log2(fighters) + 2)
  --name <text>       season archive: display name (default "Season <id>")
  --if-changed        ladder: skip if fighters, brain and engine match the committed ladder
  --force             ladder: let an offline brain (mock) replace results played by a real model
  --port <n>          serve: port (default 5173)

Environment
  TYPESAFE_API_KEY      enables the "jev" brain (get one at https://console.typesafe.ai/keys)
  JEV_ARENA_ENDPOINTS   extra System One endpoints, e.g. "laya=http://localhost:8000/v1/systemone"
  LLM_MODEL, OPENAI_API_KEY, OPENAI_BASE_URL   enables the "llm" brain (OpenAI, OpenRouter, Ollama...)
`;

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'serve';
const { values: opt, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    brain: { type: 'string' },
    red: { type: 'string' },
    blue: { type: 'string' },
    mode: { type: 'string', default: 'realtime' },
    seed: { type: 'string' },
    out: { type: 'string' },
    games: { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '2' },
    port: { type: 'string', default: '5173' },
    host: { type: 'string', default: '127.0.0.1' },
    fighters: { type: 'string', default: path.join(ROOT, 'fighters') },
    'dry-run': { type: 'boolean', default: false },
    'if-changed': { type: 'boolean', default: false },
    format: { type: 'string', default: 'auto' },
    rounds: { type: 'string' },
    name: { type: 'string' },
    markdown: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const defaultBrain = () => opt.brain || (process.env.TYPESAFE_API_KEY ? 'jev' : 'mock');

main().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});

async function main() {
  if (opt.help || cmd === 'help') return console.log(HELP);
  switch (cmd) {
    case 'serve':
      return serve();
    case 'fight':
      return fight();
    case 'ladder':
      return ladder();
    case 'validate':
      return validate();
    case 'brains':
      return brains();
    case 'build-site':
      return site();
    case 'verify':
      return verify();
    case 'smoke':
      return smoke();
    case 'season':
      return season();
    default:
      console.log(HELP);
      process.exit(1);
  }
}

async function serve() {
  const port = Number(opt.port);
  await startServer({ port, host: opt.host, fightersDir: path.resolve(opt.fighters) });
  const ready = discoverBrains().filter((b) => b.ready).map((b) => b.id);
  console.log(`\n  ⚔  Jev Arena is live at  http://${opt.host === '0.0.0.0' ? 'localhost' : opt.host}:${port}\n`);
  console.log(`  brains ready: ${ready.join(', ')}`);
  if (!process.env.TYPESAFE_API_KEY) console.log('  tip: set TYPESAFE_API_KEY to let Jev pilot the fighters (mock brain works without it)');
  console.log('');
}

function colorize(hex, s) {
  if (!process.stdout.isTTY) return s;
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m`;
}

function bar(value, width = 20) {
  const full = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return '█'.repeat(full) + '░'.repeat(width - full);
}

async function fight() {
  if (positionals.length < 2) throw new Error('usage: jev-arena fight <red> <blue>   (fighter ids or .yaml paths)');
  const dir = path.resolve(opt.fighters);
  const picks = positionals.slice(0, 2).map((ref) => resolveFighter(ref, dir));
  for (const p of picks) if (!p.ok) throw new Error(p.errors.join('\n  '));
  const fighters = picks.map((p) => p.fighter);
  const brains = [createBrain(opt.red || defaultBrain()), createBrain(opt.blue || defaultBrain())];
  const seed = opt.seed ? Number(opt.seed) : Math.floor(Math.random() * 1e9);
  const mode = opt.mode === 'lockstep' ? 'lockstep' : 'realtime';

  console.log(`\n  ${colorize(fighters[0].color, fighters[0].name)} (${brains[0].label})  vs  ${colorize(fighters[1].color, fighters[1].name)} (${brains[1].label})`);
  console.log(`  mode: ${mode} · seed: ${seed}\n`);

  const match = new Match({ fighters, brains, seed, mode });
  const last = [null, null];
  match.on('decision', (d) => (last[d.s] = d));
  match.on('brainError', ({ side, error }) => {
    if (!opt.quiet) console.log(`  ! ${fighters[side].name}'s brain: ${error.message}`);
  });
  match.on('tick', (w) => {
    if (opt.quiet || w.tick % TICK_HZ !== 0) return;
    const t = String(w.tick / TICK_HZ).padStart(2, ' ');
    const cols = w.fighters.map((f, i) => {
      const d = last[i];
      const zap = d && (d.src.startsWith('reflex') || d.xsrc.startsWith('reflex')) ? '⚡' : '';
      const move = d ? `${d.m}${d.x !== 'wait' ? '+' + d.x : ''}${zap}` : '…';
      return `${colorize(fighters[i].color, bar(f.hp, 14))} ${String(Math.round(f.hp)).padStart(3)} ${move.padEnd(20)}`;
    });
    console.log(`  ${t}s  ${cols[0]}  │  ${cols[1]}`);
  });
  const replay = await match.run({ paced: true });
  if (match.fatal) throw match.fatal;
  if (!replay.result) throw new Error('fight stopped before it finished');

  const r = replay.result;
  const winner = r.winner === null ? 'Draw' : `${fighters[r.winner].name} wins`;
  console.log(`\n  🏆 ${winner} (${r.reason === 'ko' ? 'KO' : 'time'} at ${(r.tick / TICK_HZ).toFixed(1)}s) · health ${r.hp.join(' / ')}\n`);
  replay.summary.forEach((s, i) => {
    const cost = s.costUsd != null ? ` · $${s.costUsd.toFixed(5)}` : '';
    console.log(
      `  ${colorize(fighters[i].color, fighters[i].name.padEnd(14))} ${String(s.decisions).padStart(4)} decisions · ${Number(s.decisionsPerSecond).toFixed(1)}/s · p50 ${s.p50LatencyMs ?? '–'}ms · ${s.reflexFires} reflexes · dmg ${Math.round(s.stats.damageDealt)}${cost}`,
    );
  });
  if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify(replay));
    console.log(`\n  replay saved to ${opt.out}  (open it in the web viewer → Replays)`);
  }
  console.log('');
}

// Offline brains are keyword heuristics, not models. Declared as a function so it's hoisted above main().
function isOfflineBrain(id) {
  return id === 'mock' || id === 'mock-slow' || id === 'instant';
}

function readCommittedBrain(outDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, 'leaderboard.json'), 'utf8')).brain || null;
  } catch {
    return null;
  }
}

async function ladder() {
  const dir = path.resolve(opt.fighters);
  const list = loadFighters(dir);
  const bad = list.filter((r) => !r.ok);
  for (const b of bad) console.log(`  skipping ${path.basename(b.file)}: ${b.errors.join('; ')}`);
  const fighters = list.filter((r) => r.ok).map((r) => r.fighter);
  if (fighters.length < 2) throw new Error('need at least two valid fighters');
  const games = Number(opt.games);
  const brainId = defaultBrain();
  if (!['auto', 'roundrobin', 'swiss'].includes(opt.format)) throw new Error('--format must be auto, roundrobin or swiss');
  const format = chooseFormat(opt.format, fighters.length);
  const rounds = format === 'swiss' ? (opt.rounds ? Number(opt.rounds) : swissRoundsFor(fighters.length)) : null;
  const est = estimate(fighters, games, { format, rounds });
  const how = format === 'swiss' ? `Swiss, ${rounds} rounds` : 'round robin';
  console.log(`\n  ${fighters.length} fighters · ${how} · ${est.matches} matches · brain ${brainId}`);
  if (brainId === 'jev') console.log(`  estimated Jev cost: ~$${est.usd.toFixed(2)} (${(est.tokens / 1e6).toFixed(1)}M input tokens, ~${Math.ceil((est.matches * 40) / Number(opt.concurrency) / 60)} min at concurrency ${opt.concurrency})`);
  if (opt['dry-run']) return;
  const outDir = path.resolve(opt.out || path.join(ROOT, 'ladder'));
  const mode = opt.mode === 'lockstep' ? 'lockstep' : 'realtime';
  if (opt['if-changed'] && ladderIsCurrent({ fighters, brainId, mode, games, outDir, format, rounds })) {
    console.log('  ladder is already up to date for these fighters, brain and engine; nothing to run.\n');
    return;
  }
  const committedBrain = readCommittedBrain(outDir);
  if (isOfflineBrain(brainId) && committedBrain && !isOfflineBrain(committedBrain) && !opt.force) {
    console.log(`  the committed ladder was played by "${committedBrain}"; not replacing it with offline "${brainId}" results (use --force to do it anyway).\n`);
    return;
  }
  const board = await runLadder({
    fighters,
    makeBrain: () => createBrain(brainId),
    brainId,
    mode,
    games,
    concurrency: Number(opt.concurrency),
    outDir,
    format,
    rounds,
    onRound: (r, n, pairs, bye) => console.log(`\n  round ${r}/${n}: ${pairs.length} pairings${bye ? ` · bye: ${bye}` : ''}`),
    onMatch: (m, i, n) => {
      const w = m.result.winner === null ? 'draw' : m.result.winner === 0 ? m.a : m.b;
      console.log(`  [${String(i).padStart(3)}/${n}] ${m.a} vs ${m.b} → ${w} (${m.result.reason})`);
    },
  });
  console.log('\n' + board.fighters.map((f, i) => `  ${i + 1}. ${f.name.padEnd(16)} ${f.elo}  ${f.w}-${f.d}-${f.l}`).join('\n'));
  console.log(`\n  wrote ${path.relative(process.cwd(), outDir) || '.'}/leaderboard.json, LEADERBOARD.md and replays/\n`);
}

async function validate() {
  const files = positionals.length ? positionals : fs.readdirSync(path.resolve(opt.fighters)).filter((n) => /\.ya?ml$/i.test(n)).map((n) => path.join(path.resolve(opt.fighters), n));
  let failed = 0;
  const names = new Map();
  for (const file of files) {
    const r = loadFighterFile(path.resolve(file));
    if (r.ok) {
      const key = r.fighter.name.toLowerCase();
      if (names.has(key)) {
        failed += 1;
        console.log(`  ✖ ${file}\n      name "${r.fighter.name}" is already used by ${names.get(key)}`);
        continue;
      }
      names.set(key, file);
      console.log(`  ✔ ${file}  (${r.fighter.name} by @${r.fighter.author}, ${r.fighter.strategy.length} chars, ${r.fighter.reflexes.length} reflexes)`);
    } else {
      failed += 1;
      console.log(`  ✖ ${file}\n      ${r.errors.join('\n      ')}`);
    }
  }
  if (failed) {
    console.log(`\n  ${failed} fighter file(s) need fixing.`);
    process.exit(1);
  }
}

function brains() {
  for (const b of discoverBrains()) console.log(`  ${b.ready ? '✔' : '·'} ${b.id.padEnd(10)} ${b.label}${b.hint ? `  (${b.hint})` : ''}`);
  console.log('  ✔ mock-slow  Mock with 1.5s latency, to feel what a slow LLM is like\n  also: llm:<model> and any System One URL');
}

function site() {
  const out = path.resolve(opt.out || 'dist');
  buildSite({ out, fightersDir: path.resolve(opt.fighters) });
  console.log(`  static site written to ${out}`);
}

function verify() {
  const file = positionals[0];
  if (!file) throw new Error('usage: jev-arena verify <replay.json>');
  const replay = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = verifyReplay(replay);
  console.log(v.ok ? '  ✔ replay re-simulates to the recorded result' : `  ✖ mismatch\n    recorded: ${JSON.stringify(v.want)}\n    re-sim:   ${JSON.stringify(v.got)}`);
  if (!v.ok) process.exit(1);
}

async function smoke() {
  if (!positionals[0]) throw new Error('usage: jev-arena smoke fighters/<you>.yaml [--markdown]');
  let failed = false;
  for (const file of positionals) {
    const report = await runSmoke({ file, fightersDir: path.resolve(opt.fighters), brainId: opt.brain || 'instant', games: Number(opt.games), mode: 'lockstep' });
    process.stdout.write(opt.markdown ? smokeMarkdown(report) + '\n' : smokeText(report));
    if (!report.ok) failed = true;
  }
  if (failed) process.exit(1);
}

async function season() {
  const sub = positionals[0];
  const seasonsDir = path.join(ROOT, 'seasons');
  if (sub === 'list') {
    const idx = readSeasonIndex(seasonsDir);
    if (!idx.seasons.length) return console.log('\n  no archived seasons yet\n');
    for (const s of idx.seasons) console.log(`  ${s.id.padEnd(8)} ${s.name.padEnd(18)} champion ${s.champion.name} (@${s.champion.author}) · ${s.fighters} fighters · closed ${s.closedAt.slice(0, 10)}`);
    return;
  }
  if (sub !== 'archive' || !positionals[1]) throw new Error('usage: jev-arena season archive <id> [--name "Season 1"] [--force]   |   jev-arena season list');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { entry, updated } = archiveSeason({
    id: positionals[1],
    name: opt.name,
    ladderDir: path.resolve(opt.out || path.join(ROOT, 'ladder')),
    seasonsDir,
    readmes: [path.join(ROOT, 'README.md'), path.join(ROOT, 'README.zh-TW.md')],
    siteUrl: pkg.homepage || '',
    force: opt.force,
  });
  console.log(`\n  archived ${entry.name} → ${entry.dir}/`);
  console.log(`  champion: ${entry.champion.name} by @${entry.champion.author} (${entry.champion.record}, Elo ${entry.champion.elo})`);
  console.log(updated.length ? `  Hall of Fame updated in ${updated.map((f) => path.basename(f)).join(', ')}\n` : '  (no Hall of Fame markers found in the READMEs)\n');
}
