import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseFormat, swissRoundsFor, swissPairRound, swissMatches, pairKey, estimate, makeBoard } from '../src/ladder-core.js';
import crypto from 'node:crypto';
import { ENGINE_VERSION } from '../src/engine/constants.js';
import { runLadder, ladderIsCurrent, ladderInputsHash } from '../src/node/ladder.js';
import { loadFighters } from '../src/node/fighters.js';
import { createBrain } from '../src/node/brains.js';
import { runSmoke, smokeMarkdown } from '../src/node/smoke.js';
import { archiveSeason, hallOfFame, HOF_START, HOF_END } from '../src/node/season.js';
import { DICTS, setLang, t, moveLabel, sourceLabel } from '../web/i18n.js';
import { createCommentator } from '../web/commentary.js';
import { createReplayer } from '../src/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jev-arena-'));
const field = () => loadFighters(path.join(ROOT, 'fighters')).filter((r) => r.ok).map((r) => r.fighter);

test('round-robin fingerprints keep their original shape (committed ladders stay current)', () => {
  // The first fingerprint format, before Swiss existed. Changing it would make CI re-run
  // (and pay for) every committed ladder on the next push.
  const legacy = ({ fighters, brainId, mode, games }) =>
    crypto
      .createHash('sha256')
      .update(JSON.stringify({ engine: ENGINE_VERSION, brainId, mode, games, fighters: [...fighters].sort((a, b) => a.id.localeCompare(b.id)) }))
      .digest('hex')
      .slice(0, 16);
  const fighters = field();
  const args = { fighters, brainId: 'jev', mode: 'realtime', games: 2 };
  assert.equal(ladderInputsHash(args), legacy(args));
  assert.equal(ladderInputsHash({ ...args, format: 'roundrobin', rounds: null }), legacy(args));
  assert.notEqual(ladderInputsHash({ ...args, format: 'swiss', rounds: 5 }), legacy(args));
});

test('auto format switches to Swiss for big fields', () => {
  assert.equal(chooseFormat('auto', 16), 'roundrobin');
  assert.equal(chooseFormat('auto', 17), 'swiss');
  assert.equal(chooseFormat('roundrobin', 40), 'roundrobin');
  assert.equal(swissRoundsFor(6), 5);
  assert.equal(swissRoundsFor(32), 7);
  const fs40 = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}` }));
  assert.ok(estimate(fs40, 2, { format: 'swiss' }).matches < estimate(fs40, 2).matches / 4);
});

test('Swiss rounds avoid rematches, give each odd fighter at most one bye, and seed deterministically', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `f${i}`);
  const points = new Map(ids.map((id) => [id, 0]));
  const played = new Set();
  const byes = new Set();
  for (let round = 1; round <= 5; round++) {
    const { pairs, bye } = swissPairRound(ids, points, played, byes);
    assert.equal(pairs.length, 4);
    assert.ok(bye && !byes.has(bye), 'a fresh bye each round');
    byes.add(bye);
    const seen = new Set(pairs.flat());
    assert.equal(seen.size, 8);
    for (const [a, b] of pairs) {
      assert.ok(!played.has(pairKey(a, b)), `rematch ${a}-${b} in round ${round}`);
      played.add(pairKey(a, b));
      points.set(a, points.get(a) + (a < b ? 2 : 0));
    }
  }
  const m1 = swissMatches([['f2', 'f1']], 2, 1, new Set());
  const m2 = swissMatches([['f1', 'f2']], 2, 3, new Set());
  assert.deepEqual(m1.map((m) => m.seed), m2.map((m) => m.seed));
  assert.deepEqual(m1.map((m) => [m.a, m.b]), [['f1', 'f2'], ['f2', 'f1']]);
});

test('a Swiss ladder runs end to end with the offline brain', async () => {
  const base = field();
  const fighters = Array.from({ length: 7 }, (_, i) => ({ ...base[i % base.length], id: `x${i}`, name: `X${i}` }));
  const outDir = tmp();
  const board = await runLadder({ fighters, makeBrain: () => createBrain('instant'), brainId: 'instant', mode: 'lockstep', games: 2, concurrency: 4, outDir, format: 'swiss', rounds: 3 });
  assert.equal(board.format, 'swiss');
  assert.equal(board.rounds, 3);
  assert.equal(board.matches.length, 3 * 3 * 2);
  assert.ok(board.matches.every((m) => m.round >= 1 && fs.existsSync(path.join(outDir, m.file))));
  assert.equal(Object.values(board.fighters).reduce((s, f) => s + f.byes, 0), 3);
  assert.ok(ladderIsCurrent({ fighters, brainId: 'instant', mode: 'lockstep', games: 2, outDir, format: 'swiss', rounds: 3 }));
  assert.ok(!ladderIsCurrent({ fighters, brainId: 'instant', mode: 'lockstep', games: 2, outDir }), 'format is part of the fingerprint');
});

test('smoke test fights the whole field and reports invalid files', async () => {
  const report = await runSmoke({ file: path.join(ROOT, 'fighters', 'zen.yaml'), fightersDir: path.join(ROOT, 'fighters'), games: 2 });
  assert.ok(report.ok);
  assert.equal(report.opponents.length, field().length - 1);
  assert.equal(report.record.w + report.record.d + report.record.l, report.opponents.length * 2);
  assert.match(smokeMarkdown(report), /\| Opponent \| Game 1 \| Game 2 \|/);
  const bad = path.join(tmp(), 'bad.yaml');
  fs.writeFileSync(bad, 'name: X\nauthor: a\nstrategy: too short\n');
  const r2 = await runSmoke({ file: bad, fightersDir: path.join(ROOT, 'fighters') });
  assert.ok(!r2.ok);
  assert.match(smokeMarkdown(r2), /not a valid fighter/);
});

test('archiving a season freezes the ladder and rewrites the Hall of Fame block', () => {
  const dir = tmp();
  const ladderDir = path.join(dir, 'ladder');
  fs.mkdirSync(path.join(ladderDir, 'replays'), { recursive: true });
  const board = makeBoard({ fighters: [], results: [], brainId: 'jev', mode: 'realtime', games: 2 });
  board.fighters = [
    { id: 'zen', name: 'Zen', author: 'someone', elo: 1080, w: 9, d: 0, l: 1 },
    { id: 'tortoise', name: 'Tortoise', author: 'jev-arena', elo: 1020, w: 6, d: 0, l: 4 },
  ];
  fs.writeFileSync(path.join(ladderDir, 'leaderboard.json'), JSON.stringify(board));
  fs.writeFileSync(path.join(ladderDir, 'replays', 'a.json'), '{}');
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, `# X\n\n## Hall of Fame\n\n${HOF_START}\nplaceholder\n${HOF_END}\n\nrest\n`);
  const { entry, updated } = archiveSeason({ id: '1', ladderDir, seasonsDir: path.join(dir, 'seasons'), readmes: [readme], siteUrl: 'https://example.com/arena/' });
  assert.equal(entry.champion.name, 'Zen');
  assert.equal(entry.podium.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'seasons', '1', 'replays', 'a.json')));
  assert.deepEqual(updated, [readme]);
  const text = fs.readFileSync(readme, 'utf8');
  assert.match(text, /\| Season 1 \| \*\*Zen\*\* \| @someone \| 9-0-1 \| 1080 \|/);
  assert.match(text, /\?season=1\)/);
  assert.ok(text.endsWith('rest\n'));
  assert.throws(() => archiveSeason({ id: '1', ladderDir, seasonsDir: path.join(dir, 'seasons') }), /already exists/);
  assert.match(hallOfFame({ seasons: [] }), /hall-of-fame:end/);
});

test('every UI string exists in both languages', () => {
  const en = Object.keys(DICTS.en);
  const zh = Object.keys(DICTS['zh-TW']);
  assert.deepEqual(en.filter((k) => !zh.includes(k)), []);
  assert.deepEqual(zh.filter((k) => !en.includes(k)), []);
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-html|-ph|-title)?="([^"]+)"/g)) assert.ok(key in DICTS.en, `missing ${key}`);
  setLang('zh-TW');
  assert.equal(moveLabel('take_cover'), '找掩護');
  assert.equal(sourceLabel('reflex 2'), '反射 2');
  assert.equal(t('feed.ko', { a: 'Zen' }), 'KO！Zen 獲勝');
  setLang('en');
});

test('commentary narrates a real Jev fight in both languages', () => {
  const replay = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'jev-glass-cannon-vs-trickster.json'), 'utf8'));
  for (const lang of ['en', 'zh-TW']) {
    setLang(lang);
    const cc = createCommentator({ fighters: replay.fighters, brainLabel: 'Jev', mode: replay.mode });
    const r = createReplayer(replay);
    const lines = [cc.intro()];
    let ds;
    while ((ds = r.next()) !== null) {
      for (const d of ds) {
        const l = cc.decision(d);
        if (l) lines.push(l);
      }
      lines.push(...cc.tick(r.world));
    }
    const text = lines.map((l) => cc.plain(l.text)).join('\n');
    assert.ok(lines.length >= 8 && lines.length <= 40, `${lines.length} lines`);
    assert.match(text, lang === 'en' ? /KO! Trickster wins with 24 health left/ : /KO！Trickster 以 24 點生命獲勝/);
    assert.match(text, lang === 'en' ? /overdrive/ : /超頻/);
    for (let i = 1; i < lines.length; i++) assert.ok(lines[i].tick >= lines[i - 1].tick);
  }
  setLang('en');
});

test('makeBoard keeps the original shape for round robins', () => {
  const board = makeBoard({ fighters: [], results: [], brainId: 'mock', mode: 'lockstep', games: 2 });
  assert.equal(board.format, undefined);
});
