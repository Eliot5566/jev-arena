import * as C from '../src/engine/constants.js';
import { ACTION_IDS, MOVEMENT_ACTIONS, ACTS } from '../src/engine/actions.js';

const ACT_IDS = Object.keys(ACTS);
import { snapshot } from '../src/engine/world.js';
import { Match } from '../src/match.js';
import { createReplayer } from '../src/replay.js';
import { validateFighter, fighterToYaml, LIMITS, slugify } from '../src/fighter.js';
import { createMockBrain } from '../src/brains/mock.js';
import { createSystemOneBrain, JEV_URL } from '../src/brains/systemone.js';
import { ArenaRenderer, sideColors } from './render.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtT = (tick) => `${Math.floor(tick / C.TICK_HZ / 60)}:${String(Math.floor((tick / C.TICK_HZ) % 60)).padStart(2, '0')}`;
const pretty = (a) => a.replace('_', ' ');
const TICK_MS = 1000 / C.TICK_HZ;

const app = {
  config: { mode: 'static', brains: [] },
  fighters: [],
  labFighter: null,
  mode: 'realtime',
  current: null, // { kind: 'live', match } | { kind: 'replay', ... }
  lastReplay: null,
  lastSetup: null,
  jevKey: null,
  thinkingSince: [null, null],
  minds: [null, null],
  hpShown: [100, 100],
  replaySpeed: 1,
};

const renderer = new ArenaRenderer($('arena'));

boot().catch((err) => {
  console.error(err);
  toast(`Could not start: ${err.message}`);
});

// =============================================================================================
// boot
// =============================================================================================

async function boot() {
  const repo = document.querySelector('meta[name="jev-arena-repo"]')?.content;
  if (repo) $('repoLink').href = repo;

  app.config = await getJson('data/config.json').catch(() => ({ mode: 'static', brains: [{ id: 'mock', label: 'Mock (offline heuristics)', ready: true }] }));
  const data = await getJson('data/fighters.json').catch(() => ({ fighters: [] }));
  app.fighters = data.fighters || [];
  $('ver').textContent = `v${app.config.version || '0'}${app.config.mode === 'static' ? ' · web' : ' · local'}`;
  if (data.invalid?.length) toast(`${data.invalid.length} fighter file(s) have errors, see the terminal`);

  fillFighterSelects();
  fillBrainSelects();
  wireTabs();
  wireFight();
  wireReplays();
  initLab();
  loadLadder();

  const q = new URLSearchParams(location.search);
  if (q.get('red')) $('fighterA').value = q.get('red');
  if (q.get('blue')) $('fighterB').value = q.get('blue');
  if (q.get('replay')) loadReplayUrl(q.get('replay'));
  else idleStage();

  requestAnimationFrame(frame);
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function allFighters() {
  return app.labFighter ? [app.labFighter, ...app.fighters] : app.fighters;
}

function fighterById(id) {
  return allFighters().find((f) => f.id === id);
}

function fillFighterSelects() {
  const opts = allFighters()
    .map((f) => `<option value="${esc(f.id)}">${esc(f.name)}${f.id === 'lab' ? ' (your draft)' : ''} · @${esc(f.author)}</option>`)
    .join('');
  for (const id of ['fighterA', 'fighterB', 'labOpponent']) {
    const el = $(id);
    const keep = el.value;
    el.innerHTML = opts;
    if (keep && fighterById(keep)) el.value = keep;
  }
  if (!$('fighterA').value && app.fighters[0]) $('fighterA').value = app.fighters[0].id;
  const b = app.fighters.find((f) => f.id === 'berserker') ? 'berserker' : app.fighters[1]?.id;
  const a = app.fighters.find((f) => f.id === 'tortoise') ? 'tortoise' : app.fighters[0]?.id;
  if ($('fighterA').value === $('fighterB').value || !$('fighterB').value) {
    $('fighterA').value = a;
    $('fighterB').value = b;
  }
}

function fillBrainSelects() {
  const brains = app.config.brains || [];
  const opts = brains.map((b) => `<option value="${esc(b.id)}" ${b.ready ? '' : 'disabled'}>${esc(b.label)}${b.ready ? '' : ' (not configured)'}</option>`).join('');
  const preferred = brains.find((b) => b.id === 'jev' && b.ready) ? 'jev' : 'mock';
  for (const id of ['brainA', 'brainB']) {
    $(id).innerHTML = opts;
    $(id).value = preferred;
  }
}

function wireTabs() {
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) showTab(btn.dataset.tab);
  });
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'fight') renderer.resize();
}

// =============================================================================================
// brains in the browser
// =============================================================================================

async function makeBrain(id) {
  if (id === 'mock') return createMockBrain();
  if (id === 'mock-slow') return createMockBrain({ id: 'mock-slow', label: 'Mock (slow, 1.5s)', latencyMs: [1200, 1800] });
  if (id === 'jev-direct') {
    const key = await askKey();
    return createSystemOneBrain({ id: 'jev', label: 'Jev · direct', url: JEV_URL, apiKey: key, pricePerMillion: C.JEV_USD_PER_MILLION_INPUT });
  }
  const meta = (app.config.brains || []).find((b) => b.id === id) || { label: id };
  return {
    id,
    label: meta.label,
    kind: meta.kind,
    model: undefined,
    pricePerMillion: id === 'jev' ? C.JEV_USD_PER_MILLION_INPUT : null,
    async decide(request) {
      const res = await fetch(`api/decide?brain=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(body.error || `HTTP ${res.status}`);
        err.fatal = !!body.fatal;
        throw err;
      }
      return body;
    },
  };
}

function askKey() {
  if (app.jevKey) return Promise.resolve(app.jevKey);
  return new Promise((resolve, reject) => {
    $('keyModal').classList.add('show');
    $('keyInput').value = '';
    $('keyInput').focus();
    const done = (ok) => {
      $('keyModal').classList.remove('show');
      $('keySave').onclick = $('keyCancel').onclick = null;
      if (ok && $('keyInput').value.trim()) {
        app.jevKey = $('keyInput').value.trim();
        resolve(app.jevKey);
      } else reject(new Error('No key entered'));
    };
    $('keySave').onclick = () => done(true);
    $('keyCancel').onclick = () => done(false);
  });
}

// =============================================================================================
// stage: HUD, mind panels, feed
// =============================================================================================

function idleStage() {
  const fA = fighterById($('fighterA').value);
  const fB = fighterById($('fighterB').value);
  if (!fA || !fB) return;
  setupStage([fA, fB], [$('brainA').selectedOptions[0]?.text || '', $('brainB').selectedOptions[0]?.text || ''], 'READY');
  renderer.reset();
}

function setupStage(fighters, brainLabels, sub) {
  renderer.setFighters(fighters);
  const colors = sideColors(fighters.map((f) => f.color));
  app.minds = [0, 1].map((i) => buildMind($(i === 0 ? 'mindA' : 'mindB'), fighters[i], brainLabels[i], colors[i]));
  $('hudNameA').textContent = fighters[0].name;
  $('hudNameB').textContent = fighters[1].name;
  $('hudNameA').style.color = colors[0];
  $('hudNameB').style.color = colors[1];
  $('hpA').style.background = colors[0];
  $('hpB').style.background = colors[1];
  app.hpShown = [100, 100];
  updateHud(null, sub);
  $('feed').innerHTML = '';
  app.thinkingSince = [null, null];
}

function updateHud(world, sub) {
  const fs = world ? world.fighters : [{ hp: 100, energy: 100 }, { hp: 100, energy: 100 }];
  ['A', 'B'].forEach((s, i) => {
    const hp = Math.max(0, fs[i].hp);
    $(`hp${s}`).style.width = `${hp}%`;
    $(`hpGhost${s}`).style.width = `${hp}%`;
    $(`en${s}`).style.width = `${fs[i].energy}%`;
  });
  const left = world ? Math.max(0, Math.ceil((C.MATCH_TICKS - world.tick) / C.TICK_HZ)) : C.MATCH_SECONDS;
  $('clock').firstChild.textContent = String(left);
  $('clock').classList.toggle('zone', !!world && world.tick >= C.ZONE.startAt * C.TICK_HZ && !world.over);
  if (sub) $('clockSub').textContent = sub;
}

function buildMind(el, fighter, brainLabel, color) {
  el.style.setProperty('--side-color', color);
  const reflexHtml = fighter.reflexes.length
    ? fighter.reflexes
        .map(
          (r, i) => `<div class="reflex" data-i="${i}">
            <div class="when"><b>${i + 1}·${esc(pretty(r.do))}</b><span>${esc(r.when)}</span></div>
            <div class="rtrack"><i style="width:0"></i><u style="left:${r.threshold * 100}%"></u></div>
          </div>`,
        )
        .join('')
    : '<div class="reflex"><div class="when"><span>No reflexes. The strategy decides everything.</span></div></div>';
  el.innerHTML = `
    <div class="who"><span class="dot" style="background:${color};color:${color}"></span><span class="fname">${esc(fighter.name)}</span><span class="author">@${esc(fighter.author)}</span></div>
    <div class="brain"><span class="think"></span><span class="blabel">${esc(brainLabel)}</span><span class="bms mono"></span></div>
    <div class="stats">
      <div class="stat"><b class="s-dec">0</b><span>decisions</span></div>
      <div class="stat"><b class="s-lat">–</b><span>p50 ms</span></div>
      <div class="stat"><b class="s-cost">–</b><span>cost</span></div>
    </div>
    <div class="now"><span class="move">waiting</span><span class="chip src">–</span></div>
    <h4><span>Movement</span><span class="confv confv-m mono"></span></h4>
    <div class="bars bars-m">${barRows(MOVEMENT_ACTIONS)}</div>
    <div class="conf conf-m" title="confidence"><i></i></div>
    <h4><span>Action</span><span class="confv confv-x mono"></span></h4>
    <div class="bars bars-x">${barRows(ACT_IDS)}</div>
    <div class="conf conf-x" title="confidence"><i></i></div>
    <h4><span>Reflexes</span><span>p vs threshold</span></h4>
    ${reflexHtml}
    <details class="strategy"><summary>Strategy</summary><p>“${esc(fighter.strategy)}”</p></details>`;

  const q = (sel) => el.querySelector(sel);
  const barsM = Object.fromEntries(MOVEMENT_ACTIONS.map((a) => [a, el.querySelector(`.bars-m .bar[data-a="${a}"]`)]));
  const barsX = Object.fromEntries(ACT_IDS.map((a) => [a, el.querySelector(`.bars-x .bar[data-a="${a}"]`)]));
  const group = (bars, ids, probs = {}, available, conf, sel) => {
    let top = null;
    for (const [k, v] of Object.entries(probs)) if (top === null || v > probs[top]) top = k;
    for (const a of ids) {
      const pv = probs[a] || 0;
      const offered = available ? available.includes(a) : a in probs;
      const row = bars[a];
      row.classList.toggle('off', !offered);
      row.classList.toggle('lead', a === top);
      row.querySelector('.fill').style.width = `${(pv * 100).toFixed(1)}%`;
      row.querySelector('.pct').textContent = offered ? `${Math.round(pv * 100)}%` : '–';
    }
    q(`.conf-${sel} > i`).style.width = `${Math.round((conf || 0) * 100)}%`;
    q(`.confv-${sel}`).textContent = `conf ${(conf ?? 0).toFixed(2)}`;
  };
  const reflexEls = [...el.querySelectorAll('.reflex[data-i]')];
  const lat = [];
  let count = 0;

  return {
    thinking(on) {
      q('.think').classList.toggle('on', on);
    },
    tickThinking(ms) {
      q('.bms').textContent = ms === null ? '' : `thinking ${ms}ms`;
    },
    decision(d, available) {
      count += 1;
      if (d.ms != null) lat.push(d.ms);
      q('.s-dec').textContent = count;
      const sorted = [...lat].sort((x, y) => x - y);
      q('.s-lat').textContent = sorted.length ? sorted[Math.floor(sorted.length / 2)] : '–';
      const acting = d.x && d.x !== 'wait';
      q('.move').textContent = acting ? `${pretty(d.m)} + ${pretty(d.x)}` : pretty(d.m);
      const chip = q('.src');
      const reflexSrc = [d.src, d.xsrc].find((x) => x && x.startsWith('reflex'));
      const label = reflexSrc || (d.src.startsWith('fallback') ? d.src : 'strategy');
      chip.textContent = label;
      chip.className = `chip src ${label.startsWith('reflex') ? 'reflex' : label.startsWith('fallback') ? 'fallback' : ''}`;
      group(barsM, MOVEMENT_ACTIONS, d.p, available?.moves, d.c, 'm');
      group(barsX, ACT_IDS, d.xp, available?.acts, d.xc, 'x');
      reflexEls.forEach((rel, i) => {
        const p = d.r?.[i];
        rel.querySelector('.rtrack > i').style.width = p == null ? '0' : `${p * 100}%`;
        rel.classList.toggle('fired', d.src === `reflex ${i + 1}` || d.xsrc === `reflex ${i + 1}`);
      });
    },
    cost(usd) {
      q('.s-cost').textContent = usd == null ? '–' : usd < 0.01 ? `${(usd * 100).toFixed(3)}¢` : `$${usd.toFixed(3)}`;
    },
    error(msg) {
      const chip = q('.src');
      chip.textContent = 'brain error';
      chip.className = 'chip src error';
      chip.title = msg;
    },
  };
}

function feed(tick, text, big = false) {
  const el = $('feed');
  const line = document.createElement('div');
  line.className = `line${big ? ' big' : ''}`;
  line.innerHTML = `<span class="ts">${fmtT(tick)}</span><span>${text}</span>`;
  el.prepend(line);
  while (el.childNodes.length > 80) el.lastChild.remove();
}

function feedEvents(world, fighters) {
  const n = (i) => `<b style="color:${renderer.colors[i]}">${esc(fighters[i].name)}</b>`;
  for (const e of world.events) {
    switch (e.type) {
      case 'blast':
        feed(e.tick, `${n(e.side)} releases a heavy shot`);
        break;
      case 'hit':
        if (e.amount < 0.5) break;
        if (e.kind === 'blast') feed(e.tick, `${n(e.side)}'s heavy shot lands on ${n(e.target)} for ${Math.round(e.amount)}`, true);
        else if (e.kind === 'melee') feed(e.tick, `${n(e.side)} punches ${n(e.target)} for ${Math.round(e.amount)}`);
        break;
      case 'blocked':
        if (e.amount >= 10) feed(e.tick, `${n(e.side)} shields a heavy shot (${Math.round(e.amount)} blocked)`, true);
        break;
      case 'guard_break':
        feed(e.tick, `${n(e.side)} breaks the shield!`, true);
        break;
      case 'dodge':
        feed(e.tick, `${n(e.side)} dashes clean through a shot`);
        break;
      case 'pickup':
        feed(e.tick, `${n(e.side)} grabs ${e.kind}`);
        break;
      case 'charge_cancel':
        feed(e.tick, `${n(e.side)}'s heavy shot is cancelled`);
        break;
      case 'zone_start':
        feed(e.tick, `The zone starts closing in. Outside it costs ${C.ZONE.dps} health a second.`, true);
        break;
      case 'ko':
        feed(e.tick, e.reason === 'ko' ? `KO! ${n(e.side)} wins` : `Time! ${n(e.side)} wins on health`, true);
        break;
      case 'draw':
        feed(e.tick, 'Draw.', true);
        break;
      default:
    }
  }
}

function feedDecision(d, fighters) {
  for (const [src, action] of [
    [d.src, d.m],
    [d.xsrc, d.x],
  ]) {
    if (!src || !src.startsWith('reflex')) continue;
    const i = Number(src.split(' ')[1]) - 1;
    const r = fighters[d.s].reflexes[i];
    if (!r) continue;
    feed(d.t, `<b style="color:${renderer.colors[d.s]}">${esc(fighters[d.s].name)}</b> ⚡ reflex “${esc(r.when)}” p=${(d.r[i] ?? 0).toFixed(2)} → <b>${pretty(action)}</b>`);
  }
}

function barRows(ids) {
  return ids.map((a) => `<div class="bar off" data-a="${a}"><span class="lbl">${pretty(a)}</span><span class="track"><span class="fill"></span></span><span class="pct">–</span></div>`).join('');
}

// Replays from engine v1 had one choice per decision.
function normalizeDecision(d) {
  if (d.m) return d;
  const move = MOVEMENT_ACTIONS.includes(d.a);
  return { ...d, m: move ? d.a : null, x: move ? 'wait' : d.a, xsrc: move ? 'strategy' : d.src, xp: move ? {} : d.p, p: move ? d.p : {}, xc: d.c };
}

function labelDecision(side, d, now) {
  const acting = d.x && d.x !== 'wait';
  renderer.showDecision(side, acting ? d.x : d.m || 'wait', acting ? d.xsrc : d.src, now);
}

// =============================================================================================
// live fights
// =============================================================================================

function wireFight() {
  $('fightBtn').onclick = () => startLive();
  $('splashFight').onclick = () => startLive();
  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    app.mode = b.dataset.mode;
    $('modeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  for (const id of ['fighterA', 'fighterB', 'brainA', 'brainB']) {
    $(id).addEventListener('change', () => {
      if (!app.current) idleStage();
    });
  }
}

function stopCurrent() {
  if (app.current?.kind === 'live') app.current.match.stop();
  app.current = null;
  document.body.classList.remove('replaying');
  $('playback').classList.remove('show');
  $('overlay').classList.remove('show');
  $('resultModal').classList.remove('show');
}

async function startLive(setup) {
  const s = setup || {
    a: $('fighterA').value,
    b: $('fighterB').value,
    brainA: $('brainA').value,
    brainB: $('brainB').value,
    mode: app.mode,
  };
  const fighters = [fighterById(s.a), fighterById(s.b)];
  if (!fighters[0] || !fighters[1]) return toast('Pick two fighters');
  let brains;
  try {
    brains = [await makeBrain(s.brainA), await makeBrain(s.brainB)];
  } catch (err) {
    return toast(err.message);
  }
  stopCurrent();
  showTab('fight');
  app.lastSetup = s;

  const match = new Match({ fighters, brains, mode: s.mode });
  app.current = { kind: 'live', match };
  setupStage(fighters, brains.map((b) => b.label), s.mode === 'lockstep' ? 'LOCKSTEP' : 'REAL-TIME');
  renderer.reset();
  renderer.push(snapshot(match.world), [], performance.now(), TICK_MS);
  $('fightBtn').textContent = 'RESTART';

  match.on('ask', ({ side }) => {
    app.thinkingSince[side] = performance.now();
    app.minds[side].thinking(true);
  });
  match.on('decision', (d) => {
    app.thinkingSince[d.s] = null;
    app.minds[d.s].thinking(false);
    app.minds[d.s].decision(d, d.available);
    const st = match.stats[d.s];
    app.minds[d.s].cost(brains[d.s].pricePerMillion != null ? (st.tokens / 1e6) * brains[d.s].pricePerMillion : null);
    labelDecision(d.s, d, performance.now());
    feedDecision(d, fighters);
  });
  match.on('brainError', ({ side, error }) => {
    app.thinkingSince[side] = null;
    app.minds[side].thinking(false);
    app.minds[side].error(error.message);
    if (error.fatal) toast(`${fighters[side].name}'s brain: ${error.message}`);
  });
  match.on('tick', (w) => {
    renderer.push(snapshot(w), w.events, performance.now(), TICK_MS);
    updateHud(w);
    feedEvents(w, fighters);
  });
  match.on('end', (replay) => {
    app.lastReplay = replay;
    app.thinkingSince = [null, null];
    $('replayLast').disabled = false;
    updateHud(match.world, 'FINAL');
    setTimeout(() => {
      if (app.current?.match === match) showResult(replay);
    }, 900);
  });
  match.on('stopped', (fatal) => {
    if (fatal) {
      toast(`Fight stopped: ${fatal.message}`);
      updateHud(match.world, 'STOPPED');
    }
  });
  await match.run({ paced: true });
}

function showResult(replay) {
  const r = replay.result;
  const f = replay.fighters;
  const colors = sideColors(f.map((x) => x.color));
  const title = r.winner === null ? 'DRAW' : `${esc(f[r.winner].name).toUpperCase()} WINS`;
  const how = r.reason === 'ko' ? `KO at ${(r.tick / C.TICK_HZ).toFixed(1)}s` : 'on health at the bell';
  const S = replay.summary || [];
  const cell = (i, fn) => (S[i] ? fn(S[i]) : '–');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const rows = [
    ['Health left', (i) => Math.round(r.hp[i])],
    ['Damage dealt', (i) => cell(i, (s) => Math.round(s.stats.damageDealt))],
    ['Bolt accuracy', (i) => cell(i, (s) => `${pct(s.stats.hits, s.stats.shots)} of ${s.stats.shots}`)],
    ['Heavy shots landed', (i) => cell(i, (s) => `${s.stats.blastHits}/${s.stats.blasts}`)],
    ['Punches landed', (i) => cell(i, (s) => `${s.stats.meleeHits}/${s.stats.melees}`)],
    ['Damage blocked', (i) => cell(i, (s) => Math.round(s.stats.blocked))],
    ['Dodges · power-ups', (i) => cell(i, (s) => `${s.stats.dodges} · ${s.stats.pickups}`)],
    ['Decisions (per s)', (i) => cell(i, (s) => `${s.decisions} (${Number(s.decisionsPerSecond).toFixed(1)})`)],
    ['p50 latency', (i) => cell(i, (s) => (s.p50LatencyMs == null ? '–' : `${s.p50LatencyMs} ms`))],
    ['Reflexes fired', (i) => cell(i, (s) => s.reflexFires)],
    ['Brain cost', (i) => cell(i, (s) => (s.costUsd == null ? '–' : `$${s.costUsd.toFixed(5)}`))],
  ];
  $('resultModal').innerHTML = `
    <div class="result-card">
      <button class="x close" id="resClose" title="close">×</button>
      <h2 style="color:${r.winner === null ? 'var(--text)' : colors[r.winner]}">${title}</h2>
      <div class="sub">${how} · ${esc(replay.mode)} · ${esc(replay.brains[0].label)} vs ${esc(replay.brains[1].label)}</div>
      <table>
        <tr><th></th><th style="color:${colors[0]}">${esc(f[0].name)}</th><th style="color:${colors[1]}">${esc(f[1].name)}</th></tr>
        ${rows.map(([label, fn]) => `<tr><td>${label}</td><td>${fn(0)}</td><td>${fn(1)}</td></tr>`).join('')}
      </table>
      <div class="actions">
        <button class="primary" id="resRematch">REMATCH</button>
        <button class="ghost" id="resReplay">Watch replay</button>
        <button class="ghost" id="resSave">Save replay</button>
        <button class="ghost" id="resCopy">Copy result</button>
      </div>
    </div>`;
  $('resultModal').classList.add('show');
  $('resClose').onclick = () => $('resultModal').classList.remove('show');
  $('resultModal').onclick = (e) => {
    if (e.target === $('resultModal')) $('resultModal').classList.remove('show');
  };
  $('resRematch').onclick = () => (app.lastSetup ? startLive(app.lastSetup) : startReplay(replay));
  $('resReplay').onclick = () => startReplay(replay);
  $('resSave').onclick = () => download(`${slugify(f[0].name)}-vs-${slugify(f[1].name)}.json`, JSON.stringify(replay));
  $('resCopy').onclick = () => {
    const txt =
      r.winner === null
        ? `⚔ ${f[0].name} vs ${f[1].name}: draw after 60s.`
        : `⚔ ${f[r.winner].name} beat ${f[1 - r.winner].name} (${how}) in Jev Arena.` +
          (S[r.winner] ? ` ${S[r.winner].decisions} decisions at p50 ${S[r.winner].p50LatencyMs}ms.` : '') +
          ' Fighters are written in plain English.';
    navigator.clipboard?.writeText(txt).then(() => toast('Copied'), () => toast(txt));
  };
}

// =============================================================================================
// replays
// =============================================================================================

function wireReplays() {
  $('replayFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      startReplay(JSON.parse(await file.text()));
    } catch (err) {
      toast(`Not a replay: ${err.message}`);
    }
    e.target.value = '';
  });
  $('replayLast').onclick = () => app.lastReplay && startReplay(app.lastReplay);
  $('pbPlay').onclick = () => {
    const c = app.current;
    if (c?.kind !== 'replay') return;
    if (c.ended) seekReplay(0);
    c.playing = !c.playing;
    $('pbPlay').textContent = c.playing ? 'Pause' : 'Play';
  };
  $('pbSpeed').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b || app.current?.kind !== 'replay') return;
    app.current.speed = app.replaySpeed = Number(b.dataset.speed);
    $('pbSpeed').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('pbScrub').addEventListener('input', (e) => seekReplay(Number(e.target.value)));
  $('pbExit').onclick = () => {
    stopCurrent();
    idleStage();
  };
}

async function loadReplayUrl(url) {
  try {
    startReplay(await getJson(url));
  } catch (err) {
    toast(`Could not load replay: ${err.message}`);
    idleStage();
  }
}

function startReplay(replay) {
  if (replay?.format !== 'jev-arena-replay') return toast('That file is not a Jev Arena replay');
  if ((replay.engine ?? 1) !== C.ENGINE_VERSION) toast(`Recorded with engine v${replay.engine ?? 1}, this viewer runs v${C.ENGINE_VERSION}. Playback may drift.`);
  stopCurrent();
  showTab('fight');
  app.current = { kind: 'replay', replay, replayer: createReplayer(replay), playing: true, speed: app.replaySpeed, acc: 0, ended: false };
  setupStage(replay.fighters, replay.brains.map((b) => b.label), 'REPLAY');
  renderer.reset();
  renderer.push(snapshot(app.current.replayer.world), [], performance.now(), TICK_MS);
  $('playback').classList.add('show');
  document.body.classList.add('replaying');
  const f = replay.fighters;
  $('pbTitle').innerHTML = `<b>${esc(f[0].name)}</b> vs <b>${esc(f[1].name)}</b> · ${esc(replay.brains[0].label)} · ${esc(replay.mode)}`;
  $('pbPlay').textContent = 'Pause';
  $('pbScrub').max = String(replay.result?.tick ?? C.MATCH_TICKS);
  $('pbScrub').value = '0';
}

function replayStep(c, now, render = true) {
  const w = c.replayer.world;
  const ds = c.replayer.next();
  if (ds === null) {
    if (!c.ended) {
      c.ended = true;
      c.playing = false;
      $('pbPlay').textContent = 'Replay';
      if (c.replay.result && render) showResult(c.replay);
    }
    return false;
  }
  for (const raw of ds) {
    const d = normalizeDecision(raw);
    app.minds[d.s].decision(d, null);
    if (render) {
      labelDecision(d.s, d, now);
      feedDecision(d, c.replay.fighters);
    }
  }
  if (render) {
    renderer.push(snapshot(w), w.events, now, TICK_MS / c.speed);
    feedEvents(w, c.replay.fighters);
    updateHud(w);
    $('pbScrub').value = String(w.tick);
    $('pbTime').textContent = `${(w.tick / C.TICK_HZ).toFixed(1)}s / ${((c.replay.result?.tick ?? C.MATCH_TICKS) / C.TICK_HZ).toFixed(1)}s`;
  }
  return true;
}

function seekReplay(tick) {
  const c = app.current;
  if (c?.kind !== 'replay') return;
  $('resultModal').classList.remove('show');
  setupStage(c.replay.fighters, c.replay.brains.map((b) => b.label), 'REPLAY');
  c.replayer = createReplayer(c.replay);
  c.ended = false;
  const now = performance.now();
  while (c.replayer.world.tick < tick && replayStep(c, now, false)) {}
  renderer.reset();
  const w = c.replayer.world;
  renderer.push(snapshot(w), [], now, TICK_MS);
  updateHud(w);
  $('pbTime').textContent = `${(w.tick / C.TICK_HZ).toFixed(1)}s`;
}

// =============================================================================================
// frame loop
// =============================================================================================

let lastNow = 0;
function frame(now) {
  const dt = lastNow ? now - lastNow : 0;
  lastNow = now;
  const c = app.current;
  if (c?.kind === 'replay' && c.playing) {
    c.acc += dt * c.speed;
    let guard = 0;
    while (c.acc >= TICK_MS && guard++ < 12) {
      c.acc -= TICK_MS;
      if (!replayStep(c, now)) break;
    }
  }
  renderer.thinking = app.thinkingSince.map((t) => (c?.kind === 'live' ? t : null));
  app.minds.forEach((m, i) => {
    if (!m) return;
    const t = app.thinkingSince[i];
    m.tickThinking(c?.kind === 'live' && t !== null && now - t > 150 ? Math.round(now - t) : null);
  });
  renderer.draw(now);
  requestAnimationFrame(frame);
}

// =============================================================================================
// ladder + replay list
// =============================================================================================

async function loadLadder() {
  let board;
  try {
    board = await getJson('ladder/leaderboard.json');
  } catch {
    $('ladderBody').innerHTML = `<div class="empty">No ladder yet. Run <code>npx jev-arena ladder</code> (add <code>TYPESAFE_API_KEY</code> to let Jev play), or let the GitHub Action do it on every merged fighter.</div>`;
    $('replayList').innerHTML = `<div class="empty">Ladder replays appear here once a ladder has been run.</div>`;
    return;
  }
  const mockNote = String(board.brain).startsWith('mock') ? ' <b style="color:var(--gold)">This ladder was run with the offline mock brain, not AI.</b> Add a TYPESAFE_API_KEY secret and CI re-runs it with Jev.' : '';
  $('ladderMeta').innerHTML = `Brain <code>${esc(board.brain)}</code> · ${esc(board.mode)} · ${board.gamesPerPair} games per pair · updated ${esc(board.generatedAt.slice(0, 16).replace('T', ' '))} UTC${board.totalCostUsd ? ` · the whole ladder cost $${board.totalCostUsd}` : ''}.${mockNote}`;
  $('ladderBody').innerHTML = `<div style="overflow-x:auto"><table class="board">
    <tr><th>#</th><th>Fighter</th><th>Author</th><th class="num">Elo</th><th class="num">W-D-L</th><th class="num">KOs</th><th class="num">Dmg ±</th><th class="num">Dec/s</th><th class="num">p50</th></tr>
    ${board.fighters
      .map(
        (f, i) => `<tr title="${esc(f.tagline || '')}"><td>${i + 1}</td><td><span class="swatch" style="background:${esc(f.color)}"></span><b>${esc(f.name)}</b></td><td>@${esc(f.author)}</td>
        <td class="num">${f.elo}</td><td class="num">${f.w}-${f.d}-${f.l}</td><td class="num">${f.kos}</td><td class="num">${f.damageDealt - f.damageTaken > 0 ? '+' : ''}${f.damageDealt - f.damageTaken}</td>
        <td class="num">${f.decisionsPerSecond}</td><td class="num">${f.p50LatencyMs ?? '–'}${f.p50LatencyMs != null ? 'ms' : ''}</td></tr>`,
      )
      .join('')}
  </table></div>`;
  const names = Object.fromEntries(board.fighters.map((f) => [f.id, f.name]));
  $('replayList').innerHTML = board.matches
    .map(
      (m) => `<div class="match-row"><div><b>${esc(names[m.a] || m.a)}</b> vs <b>${esc(names[m.b] || m.b)}</b></div>
      <div class="res">${m.winner ? `${esc(names[m.winner] || m.winner)} · ${m.reason === 'ko' ? `KO ${m.seconds}s` : 'on health'}` : 'draw'}</div>
      <button class="ghost" data-file="${esc(m.file)}">Watch</button></div>`,
    )
    .join('');
  $('replayList').onclick = (e) => {
    const b = e.target.closest('button[data-file]');
    if (b) loadReplayUrl(`ladder/${b.dataset.file}`);
  };
}

// =============================================================================================
// fighter lab
// =============================================================================================

const LAB_KEY = 'jev-arena.lab.v1';

function initLab() {
  $('labTemplate').innerHTML = '<option value="">Blank</option>' + app.fighters.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  $('labFallback').innerHTML = MOVEMENT_ACTIONS.map((a) => `<option value="${a}">${pretty(a)}</option>`).join('');
  $('labNotes').innerHTML = ACTION_IDS.map((a) => `<label for="note-${a}">${a}</label><input type="text" id="note-${a}" maxlength="${LIMITS.actionNote}" placeholder="optional coach's note" />`).join('');

  let draft = null;
  try {
    draft = JSON.parse(localStorage.getItem(LAB_KEY) || 'null');
  } catch {}
  labLoad(
    draft || {
      name: 'My Fighter',
      author: 'your-github-handle',
      color: '#c6ff3d',
      tagline: '',
      strategy: 'I fight at medium range. I strafe while shooting bolts, shield when a heavy shot is coming, and finish badly hurt enemies with melee.',
      reflexes: [{ when: 'A heavy shot is flying at me.', do: 'shield', threshold: 0.7 }],
      actions: {},
      fallback: 'strafe_left',
      min_confidence: 0.2,
    },
  );

  $('tab-lab').addEventListener('input', labChanged);
  $('tab-lab').addEventListener('change', (e) => {
    if (e.target.id === 'labTemplate' && e.target.value) {
      const f = fighterById(e.target.value);
      if (f) labLoad({ ...f, name: `${f.name} II`, author: $('labAuthor').value || 'your-github-handle' });
      return;
    }
    labChanged();
  });
  $('labAddReflex').onclick = () => {
    const rs = labRead().reflexes;
    if (rs.length >= LIMITS.reflexes) return toast(`At most ${LIMITS.reflexes} reflexes`);
    rs.push({ when: '', do: 'dash', threshold: 0.7 });
    renderReflexRows(rs);
    labChanged();
  };
  $('labReflexes').addEventListener('click', (e) => {
    const x = e.target.closest('button.x');
    if (!x) return;
    const rs = labRead().reflexes;
    rs.splice(Number(x.dataset.i), 1);
    renderReflexRows(rs);
    labChanged();
  });
  $('labFight').onclick = () => {
    const { ok, errors, fighter } = validateFighter(labRead(), 'lab');
    if (!ok) return toast(errors[0]);
    app.labFighter = fighter;
    fillFighterSelects();
    $('fighterA').value = 'lab';
    $('fighterB').value = $('labOpponent').value || app.fighters[0]?.id;
    startLive();
  };
  $('labCopy').onclick = () => navigator.clipboard?.writeText($('labYaml').textContent).then(() => toast('YAML copied'), () => toast('Copy failed, select the text instead'));
  $('labDownload').onclick = () => download(`${slugify($('labName').value)}.yaml`, $('labYaml').textContent);
  if (!$('labOpponent').value && app.fighters[0]) $('labOpponent').value = app.fighters.find((f) => f.id === 'berserker')?.id || app.fighters[0].id;
}

function labLoad(f) {
  $('labName').value = f.name || '';
  $('labAuthor').value = f.author || '';
  $('labColor').value = f.color || '#38bdf8';
  $('labTagline').value = f.tagline || '';
  $('labStrategy').value = f.strategy || '';
  $('labFallback').value = f.fallback || 'strafe_left';
  $('labConf').value = String(f.min_confidence ?? 0.2);
  for (const a of ACTION_IDS) $(`note-${a}`).value = f.actions?.[a] || '';
  renderReflexRows(f.reflexes || []);
  labChanged();
}

function renderReflexRows(rs) {
  $('labReflexes').innerHTML = rs
    .map(
      (r, i) => `<div class="reflex-row" data-i="${i}">
        <input type="text" class="r-when" maxlength="${LIMITS.reflexWhen}" placeholder="When… (a yes/no statement about the fight)" value="${esc(r.when)}" />
        <select class="r-do">${ACTION_IDS.map((a) => `<option value="${a}" ${a === r.do ? 'selected' : ''}>${pretty(a)}</option>`).join('')}</select>
        <input type="range" class="r-th" min="0.5" max="0.99" step="0.01" value="${r.threshold}" title="threshold" />
        <button class="x" data-i="${i}" title="remove">×</button>
      </div>`,
    )
    .join('');
}

function labRead() {
  const actions = {};
  for (const a of ACTION_IDS) {
    const v = $(`note-${a}`).value.trim();
    if (v) actions[a] = v;
  }
  return {
    name: $('labName').value,
    author: $('labAuthor').value,
    color: $('labColor').value,
    tagline: $('labTagline').value,
    strategy: $('labStrategy').value,
    actions,
    reflexes: [...$('labReflexes').querySelectorAll('.reflex-row')].map((row) => ({
      when: row.querySelector('.r-when').value,
      do: row.querySelector('.r-do').value,
      threshold: Number(row.querySelector('.r-th').value),
    })),
    fallback: $('labFallback').value,
    min_confidence: Number($('labConf').value),
  };
}

function labChanged() {
  const raw = labRead();
  const { ok, errors, fighter } = validateFighter(raw, 'lab');
  const count = (id, n, max) => {
    $(id).textContent = `${n}/${max}`;
    $(id).classList.toggle('over', n > max);
  };
  count('cName', raw.name.trim().length, LIMITS.name);
  count('cTag', raw.tagline.trim().length, LIMITS.tagline);
  count('cStrat', raw.strategy.trim().replace(/\s+/g, ' ').length, LIMITS.strategyMax);
  $('cConf').textContent = raw.min_confidence.toFixed(2);
  $('labStatus').innerHTML = ok ? '<div class="ok">✔ Valid fighter. Ready for the ring.</div>' : `<ul class="errors">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
  $('labYaml').textContent = fighterToYaml(fighter);
  try {
    localStorage.setItem(LAB_KEY, JSON.stringify(raw));
  } catch {}
}

// =============================================================================================
// utils
// =============================================================================================

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
