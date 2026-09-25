import fs from 'node:fs';
import path from 'node:path';

// Close a season: freeze the current ladder into seasons/<id>/, record the champion in
// seasons/index.json, and rewrite the Hall of Fame block in the READMEs. Idempotent for the
// Hall of Fame; refuses to overwrite an archived season unless force is set.

export const HOF_START = '<!-- hall-of-fame:start -->';
export const HOF_END = '<!-- hall-of-fame:end -->';

export function readSeasonIndex(seasonsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(seasonsDir, 'index.json'), 'utf8'));
  } catch {
    return { seasons: [] };
  }
}

export function archiveSeason({ id, name, ladderDir, seasonsDir, readmes = [], siteUrl = '', force = false, now = new Date() }) {
  const sid = String(id).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(sid)) throw new Error(`season id "${id}" should be something like 1 or 2026-autumn`);
  const board = JSON.parse(fs.readFileSync(path.join(ladderDir, 'leaderboard.json'), 'utf8'));
  if (!board.fighters?.length) throw new Error('the ladder is empty, nothing to archive');
  const dest = path.join(seasonsDir, sid);
  if (fs.existsSync(dest) && !force) throw new Error(`seasons/${sid} already exists (use --force to replace it)`);

  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(ladderDir, dest);

  const champ = board.fighters[0];
  const entry = {
    id: sid,
    name: name || `Season ${sid}`,
    dir: `seasons/${sid}`,
    closedAt: now.toISOString(),
    brain: board.brain,
    mode: board.mode,
    format: board.format || 'roundrobin',
    fighters: board.fighters.length,
    champion: { id: champ.id, name: champ.name, author: champ.author, elo: champ.elo, record: `${champ.w}-${champ.d}-${champ.l}` },
    podium: board.fighters.slice(0, 3).map((f) => ({ id: f.id, name: f.name, author: f.author, elo: f.elo })),
  };
  const index = readSeasonIndex(seasonsDir);
  index.seasons = [...index.seasons.filter((s) => String(s.id) !== sid), entry].sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
  fs.mkdirSync(seasonsDir, { recursive: true });
  fs.writeFileSync(path.join(seasonsDir, 'index.json'), JSON.stringify(index, null, 2));

  const block = hallOfFame(index, siteUrl);
  const updated = [];
  for (const file of readmes) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const next = replaceBlock(text, block);
    if (next !== text) {
      fs.writeFileSync(file, next);
      updated.push(file);
    }
  }
  return { entry, index, updated };
}

export function hallOfFame(index, siteUrl = '') {
  const site = siteUrl.replace(/\/?$/, '/');
  const rows = [...index.seasons].reverse().map((s) => {
    const link = siteUrl ? `[final standings](${site}?season=${encodeURIComponent(s.id)})` : `\`${s.dir}/LEADERBOARD.md\``;
    return `| ${s.name} | **${s.champion.name}** | @${s.champion.author} | ${s.champion.record} | ${s.champion.elo} | ${link} |`;
  });
  return [
    HOF_START,
    '| Season | Champion | Author | W-D-L | Elo | |',
    '|---|---|---|---|---|---|',
    ...rows,
    HOF_END,
  ].join('\n');
}

export function replaceBlock(text, block) {
  const a = text.indexOf(HOF_START);
  const b = text.indexOf(HOF_END);
  if (a === -1 || b === -1 || b < a) return text;
  return text.slice(0, a) + block + text.slice(b + HOF_END.length);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const n of fs.readdirSync(src)) {
    const s = path.join(src, n);
    const d = path.join(dst, n);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
