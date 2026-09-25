import * as C from '../src/engine/constants.js';
import { ACTION_IDS, MOVEMENT_ACTIONS, ACTS } from '../src/engine/actions.js';
import { snapshot } from '../src/engine/world.js';
import { Match } from '../src/match.js';
import { createReplayer } from '../src/replay.js';
import { validateFighter, fighterToYaml, LIMITS, slugify } from '../src/fighter.js';
import { createMockBrain } from '../src/brains/mock.js';
import { ArenaRenderer, sideColors } from './render.js';
import { t, setLang, getLang, detectLang, applyI18n, moveLabel, sourceLabel } from './i18n.js';
import { createCommentator } from './commentary.js';

const ACT_IDS = Object.keys(ACTS);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtT = (tick) => `${Math.floor(tick / C.TICK_HZ / 60)}:${String(Math.floor((tick / C.TICK_HZ) % 60)).padStart(2, '0')}`;
const TICK_MS = 1000 / C.TICK_HZ;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const params = new URLSearchParams(location.search);
setLang(detectLang());
// Broadcast view for OBS and friends: ?overlay=1 (&playlist=ladder | &replay=… | &red=…&blue=…&brain=…)
const OVERLAY = params.has('overlay') && params.get('overlay') !== '0';
if (OVERLAY) document.body.classList.add('overlay-mode');
if (OVERLAY && params.get('bg') === 'transparent') document.body.classList.add('transparent');

const app = {
  config: { mode: 'static', brains: [] },
  fighters: [],
  labFighter: null,
  mode: 'realtime',
  current: null, // { kind: 'live', match } | { kind: 'replay', ... }
  lastReplay: null,
  lastSetup: null,
  thinkingSince: [null, null],
  minds: [null, null],
  replaySpeed: Number(params.get('speed')) || 1,
  cc: null,
  ladderBase: 'ladder',
};

const renderer = new ArenaRenderer($('arena'));

boot().catch((err) => {
  console.error(err);
  toast(t('toast.startFail', { msg: err.message }));
});

// =============================================================================================
// boot
// =============================================================================================

async function boot() {
  applyI18n();
  $('feed').dataset.empty = t('feed.placeholder');
  $('langBtn').onclick = switchLang;
  const repo = document.querySelector('meta[name="jev-arena-repo"]')?.content;
  if (repo) $('repoLink').href = repo;

  app.config = await getJson('data/config.json').catch(() => ({ mode: 'static', brains: [{ id: 'mock', label: 'Mock (offline heuristics)', ready: true }] }));
  const data = await getJson('data/fighters.json').catch(() => ({ fighters: [] }));
  app.fighters = data.fighters || [];
  $('ver').textContent = `v${app.config.version || '0'}${app.config.mode === 'static' ? ' · web' : ' · local'}`;
  if (data.invalid?.length) toast(t('toast.invalidFighters', { n: data.invalid.length }));

  fillFighterSelects();
  fillBrainSelects();
  wireTabs();
  wireFight();
  wireReplays();
  initLab();
  await loadSeasons();
  await loadHighlights();

  if (params.get('red')) $('fighterA').value = params.get('red');
  if (params.get('blue')) $('fighterB').value = params.get('blue');
  requestAnimationFrame(frame);

  if (OVERLAY) return bootOverlay();
  if (params.get('season')) {
    $('seasonSelect').value = params.get('season');
    await loadLadder(seasonBase(params.get('season')));
    showTab('ladder');
  }
  if (params.get('replay')) {
    await loadReplayUrl(params.get('replay'));
    const at = Number(params.get('t'));
    if (at > 0 && app.current?.kind === 'replay') seekReplay(Math.round(at * C.TICK_HZ), true);
  } else idleStage();
}

function switchLang() {
  const next = getLang() === 'en' ? 'zh-TW' : 'en';
  setLang(next, { persist: true });
  const q = new URLSearchParams(location.search);
  let saved = false;
  try {
    saved = localStorage.getItem('jev-arena.lang') === next;
  } catch {}
  if (!saved || q.has('lang')) q.set('lang', next);
  const s = q.toString();
  if (s === location.search.replace(/^\?/, '')) location.reload();
  else location.search = s;
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
    .map((f) => `<option value="${esc(f.id)}">${esc(f.name)}${f.id === 'lab' ? ` (${t('setup.yourDraft')})` : ''} · @${esc(f.author)}</option>`)
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

// Built-in brains get a translated name; configured ones (Jev, LLMs) keep the label they were given.
function brainName(b) {
  const key = `brain.${b.id}`;
  const name = t(key);
  return name === key ? b.label : name;
}

function fillBrainSelects() {
  const brains = app.config.brains || [];
  let opts = brains.map((b) => `<option value="${esc(b.id)}" ${b.ready ? '' : 'disabled'}>${esc(brainName(b))}${b.ready ? '' : ` (${t('setup.notConfigured')})`}</option>`).join('');
  // The public site can't call Jev: the API doesn't accept requests from other websites.
  if (app.config.mode === 'static') {
    opts += `<option value="jev" disabled>${esc(t('setup.jevLocal'))}</option>`;
    $('staticHint').hidden = false;
  }
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
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${name}`));
  if (name === 'fight') renderer.resize();
}

// =============================================================================================
// brains in the browser
// =============================================================================================

async function makeBrain(id) {
  if (id === 'mock') return createMockBrain({ label: brainName({ id: 'mock', label: 'Mock' }) });
  if (id === 'mock-slow') return createMockBrain({ id: 'mock-slow', label: brainName({ id: 'mock-slow', label: 'Mock (slow, 1.5s)' }), latencyMs: [1200, 1800] });
  if (app.config.mode === 'static') throw new Error(t('setup.jevLocal'));
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

// =============================================================================================
// stage: HUD, mind panels, feed, commentary
// =============================================================================================

function idleStage() {
  const fA = fighterById($('fighterA').value);
  const fB = fighterById($('fighterB').value);
  if (!fA || !fB) return;
  setupStage([fA, fB], [$('brainA').selectedOptions[0]?.text || '', $('brainB').selectedOptions[0]?.text || ''], t('stage.ready'));
  renderer.reset();
}

function setupStage(fighters, brainLabels, sub, mode = 'realtime') {
  renderer.setFighters(fighters);
  const colors = sideColors(fighters.map((f) => f.color));
  app.minds = [0, 1].map((i) => buildMind($(i === 0 ? 'mindA' : 'mindB'), fighters[i], brainLabels[i], colors[i]));
  $('hudNameA').textContent = fighters[0].name;
  $('hudNameB').textContent = fighters[1].name;
  $('hudNameA').style.color = colors[0];
  $('hudNameB').style.color = colors[1];
  $('hpA').style.background = colors[0];
  $('hpB').style.background = colors[1];
  updateHud(null, sub);
  $('feed').innerHTML = '';
  $('ticker').innerHTML = '';
  app.thinkingSince = [null, null];
  app.cc = OVERLAY ? createCommentator({ fighters, brainLabel: brainLabels[0], mode }) : null;
  if (app.cc) tickerLine(app.cc.intro());
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
            <div class="when"><b>${i + 1}·${esc(moveLabel(r.do))}</b><span>${esc(r.when)}</span></div>
            <div class="rtrack"><i style="width:0"></i><u style="left:${r.threshold * 100}%"></u></div>
          </div>`,
        )
        .join('')
    : `<div class="reflex"><div class="when"><span>${esc(t('mind.noReflexes'))}</span></div></div>`;
  el.innerHTML = `
    <div class="who"><span class="dot" style="background:${color};color:${color}"></span><span class="fname">${esc(fighter.name)}</span><span class="author">@${esc(fighter.author)}</span></div>
    <div class="brain"><span class="think"></span><span class="blabel">${esc(brainLabel)}</span><span class="bms mono"></span></div>
    <div class="stats">
      <div class="stat"><b class="s-dec">0</b><span>${esc(t('mind.decisions'))}</span></div>
      <div class="stat"><b class="s-lat">–</b><span>${esc(t('mind.p50'))}</span></div>
      <div class="stat"><b class="s-cost">–</b><span>${esc(t('mind.cost'))}</span></div>
    </div>
    <div class="now"><span class="move">${esc(t('mind.waiting'))}</span><span class="chip src">–</span></div>
    <h4><span>${esc(t('mind.movement'))}</span><span class="confv confv-m mono"></span></h4>
    <div class="bars bars-m">${barRows(MOVEMENT_ACTIONS)}</div>
    <div class="conf conf-m" title="${esc(t('mind.confidence'))}"><i></i></div>
    <h4><span>${esc(t('mind.action'))}</span><span class="confv confv-x mono"></span></h4>
    <div class="bars bars-x">${barRows(ACT_IDS)}</div>
    <div class="conf conf-x" title="${esc(t('mind.confidence'))}"><i></i></div>
    <h4><span>${esc(t('mind.reflexes'))}</span><span>${esc(t('mind.pVsThreshold'))}</span></h4>
    ${reflexHtml}
    <details class="strategy"><summary>${esc(t('mind.strategy'))}</summary><p>“${esc(fighter.strategy)}”</p></details>`;

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
    q(`.confv-${sel}`).textContent = t('mind.conf', { v: (conf ?? 0).toFixed(2) });
  };
  const reflexEls = [...el.querySelectorAll('.reflex[data-i]')];
  const lat = [];
  let count = 0;

  return {
    thinking(on) {
      q('.think').classList.toggle('on', on);
    },
    tickThinking(ms) {
      q('.bms').textContent = ms === null ? '' : t('mind.thinking', { ms });
    },
    decision(d, available) {
      count += 1;
      if (d.ms != null) lat.push(d.ms);
      q('.s-dec').textContent = count;
      const sorted = [...lat].sort((x, y) => x - y);
      q('.s-lat').textContent = sorted.length ? sorted[Math.floor(sorted.length / 2)] : '–';
      const acting = d.x && d.x !== 'wait';
      q('.move').textContent = acting ? `${moveLabel(d.m)} + ${moveLabel(d.x)}` : moveLabel(d.m);
      const chip = q('.src');
      const reflexSrc = [d.src, d.xsrc].find((x) => x && x.startsWith('reflex'));
      const label = reflexSrc || (d.src.startsWith('fallback') ? d.src : 'strategy');
      chip.textContent = sourceLabel(label);
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
      chip.textContent = t('mind.brainError');
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

function modeName(mode) {
  return mode === 'lockstep' ? t('setup.lockstep') : t('setup.realtime');
}

function nameHtml(i, fighters) {
  return `<b style="color:${renderer.colors[i]}">${esc(fighters[i].name)}</b>`;
}

function feedEvents(world, fighters) {
  const n = (i) => nameHtml(i, fighters);
  for (const e of world.events) {
    switch (e.type) {
      case 'blast':
        feed(e.tick, t('feed.blast', { a: n(e.side) }));
        break;
      case 'hit':
        if (e.amount < 0.5) break;
        if (e.kind === 'blast') feed(e.tick, t('feed.blastHit', { a: n(e.side), b: n(e.target), n: Math.round(e.amount) }), true);
        else if (e.kind === 'melee') feed(e.tick, t('feed.punch', { a: n(e.side), b: n(e.target), n: Math.round(e.amount) }));
        break;
      case 'blocked':
        if (e.amount >= 10) feed(e.tick, t('feed.blocked', { a: n(e.side), n: Math.round(e.amount) }), true);
        break;
      case 'guard_break':
        feed(e.tick, t('feed.guardBreak', { a: n(e.side) }), true);
        break;
      case 'dodge':
        feed(e.tick, t('feed.dodge', { a: n(e.side) }));
        break;
      case 'pickup':
        feed(e.tick, t('feed.pickup', { a: n(e.side), kind: esc(t(`pu.${e.kind}`)) }));
        break;
      case 'charge_cancel':
        feed(e.tick, t('feed.cancel', { a: n(e.side) }));
        break;
      case 'zone_start':
        feed(e.tick, t('feed.zone', { dps: C.ZONE.dps }), true);
        break;
      case 'ko':
        feed(e.tick, e.reason === 'ko' ? t('feed.ko', { a: n(e.side) }) : t('feed.time', { a: n(e.side) }), true);
        break;
      case 'draw':
        feed(e.tick, t('feed.draw'), true);
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
    feed(d.t, t('feed.reflex', { a: nameHtml(d.s, fighters), when: esc(r.when), p: (d.r[i] ?? 0).toFixed(2), move: `<b>${esc(moveLabel(action))}</b>` }));
  }
}

function tickerLine(line) {
  if (!line) return;
  const fighters = renderer.names;
  const html = esc(line.text)
    .replaceAll('⟦0⟧', `<b style="color:${renderer.colors[0]}">${esc(fighters[0])}</b>`)
    .replaceAll('⟦1⟧', `<b style="color:${renderer.colors[1]}">${esc(fighters[1])}</b>`);
  const el = document.createElement('div');
  el.className = `tk ${line.level}`;
  el.innerHTML = html;
  $('ticker').prepend(el);
  while ($('ticker').childNodes.length > 4) $('ticker').lastChild.remove();
}

function commentate(decisions, world) {
  if (!app.cc) return;
  for (const d of decisions) tickerLine(app.cc.decision(d));
  if (world) for (const l of app.cc.tick(world)) tickerLine(l);
}

function barRows(ids) {
  return ids.map((a) => `<div class="bar off" data-a="${a}"><span class="lbl">${esc(moveLabel(a))}</span><span class="track"><span class="fill"></span></span><span class="pct">–</span></div>`).join('');
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
  if (!fighters[0] || !fighters[1]) return toast(t('toast.pickTwo'));
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
  const ended = new Promise((resolve) => match.on('end', resolve));
  app.current = { kind: 'live', match, ended };
  setupStage(fighters, brains.map((b) => b.label), s.mode === 'lockstep' ? t('stage.lockstep') : t('stage.realtime'), s.mode);
  renderer.reset();
  renderer.push(snapshot(match.world), [], performance.now(), TICK_MS);
  $('fightBtn').textContent = t('setup.restart');
  if (OVERLAY) setOverlayBar('live', fighters, brains[0].label);

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
    commentate([d], null);
  });
  match.on('brainError', ({ side, error }) => {
    app.thinkingSince[side] = null;
    app.minds[side].thinking(false);
    app.minds[side].error(error.message);
    if (error.fatal) toast(t('toast.brain', { name: fighters[side].name, msg: error.message }));
  });
  match.on('tick', (w) => {
    renderer.push(snapshot(w), w.events, performance.now(), TICK_MS);
    updateHud(w);
    feedEvents(w, fighters);
    commentate([], w);
  });
  match.on('end', (replay) => {
    app.lastReplay = replay;
    app.thinkingSince = [null, null];
    $('replayLast').disabled = false;
    updateHud(match.world, t('stage.final'));
    if (OVERLAY) return;
    setTimeout(() => {
      if (app.current?.match === match) showResult(replay);
    }, 900);
  });
  match.on('stopped', (fatal) => {
    if (fatal) {
      toast(t('toast.stopped', { msg: fatal.message }));
      updateHud(match.world, t('stage.stopped'));
    }
  });
  await match.run({ paced: true });
}

function resultLines(replay) {
  const r = replay.result;
  const how = r.reason === 'ko' ? t('res.ko', { t: (r.tick / C.TICK_HZ).toFixed(1) }) : t('res.onHealth');
  return { r, how };
}

function showResult(replay) {
  const { r, how } = resultLines(replay);
  const f = replay.fighters;
  const colors = sideColors(f.map((x) => x.color));
  const title = r.winner === null ? t('res.draw') : t('res.wins', { name: esc(f[r.winner].name).toUpperCase() });
  const S = replay.summary || [];
  const cell = (i, fn) => (S[i] ? fn(S[i]) : '–');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const rows = [
    [t('res.healthLeft'), (i) => Math.round(r.hp[i])],
    [t('res.damage'), (i) => cell(i, (s) => Math.round(s.stats.damageDealt))],
    [t('res.accuracy'), (i) => cell(i, (s) => t('res.accuracyVal', { pct: pct(s.stats.hits, s.stats.shots), n: s.stats.shots }))],
    [t('res.heavy'), (i) => cell(i, (s) => `${s.stats.blastHits}/${s.stats.blasts}`)],
    [t('res.punches'), (i) => cell(i, (s) => `${s.stats.meleeHits}/${s.stats.melees}`)],
    [t('res.blocked'), (i) => cell(i, (s) => Math.round(s.stats.blocked))],
    [t('res.dodges'), (i) => cell(i, (s) => `${s.stats.dodges} · ${s.stats.pickups}`)],
    [t('res.decisions'), (i) => cell(i, (s) => `${s.decisions} (${Number(s.decisionsPerSecond).toFixed(1)})`)],
    [t('res.latency'), (i) => cell(i, (s) => (s.p50LatencyMs == null ? '–' : `${s.p50LatencyMs} ms`))],
    [t('res.reflexes'), (i) => cell(i, (s) => s.reflexFires)],
    [t('res.cost'), (i) => cell(i, (s) => (s.costUsd == null ? '–' : `$${s.costUsd.toFixed(5)}`))],
  ];
  $('resultModal').innerHTML = `
    <div class="result-card">
      <button class="x close" id="resClose" title="close">×</button>
      <h2 style="color:${r.winner === null ? 'var(--text)' : colors[r.winner]}">${title}</h2>
      <div class="sub">${esc(how)} · ${esc(modeName(replay.mode))} · ${esc(replay.brains[0].label)} vs ${esc(replay.brains[1].label)}</div>
      <table>
        <tr><th></th><th style="color:${colors[0]}">${esc(f[0].name)}</th><th style="color:${colors[1]}">${esc(f[1].name)}</th></tr>
        ${rows.map(([label, fn]) => `<tr><td>${esc(label)}</td><td>${fn(0)}</td><td>${fn(1)}</td></tr>`).join('')}
      </table>
      <div class="actions">
        <button class="primary" id="resRematch">${esc(t('res.rematch'))}</button>
        <button class="ghost" id="resReplay">${esc(t('res.watch'))}</button>
        <button class="ghost" id="resSave">${esc(t('res.save'))}</button>
        <button class="ghost" id="resCopy">${esc(t('res.copy'))}</button>
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
    let txt;
    if (r.winner === null) txt = t('res.shareDraw', { a: f[0].name, b: f[1].name });
    else {
      txt = t('res.shareWin', { w: f[r.winner].name, l: f[1 - r.winner].name, how });
      if (S[r.winner]) txt += t('res.shareStats', { n: S[r.winner].decisions, ms: S[r.winner].p50LatencyMs });
      txt += t('res.shareTail');
    }
    const src = app.current?.kind === 'replay' ? app.current.source : null;
    if (src) txt += ` ${shareUrl(src, 0)}`;
    copyText(txt, t('res.copied'));
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
      toast(t('toast.badReplay', { msg: err.message }));
    }
    e.target.value = '';
  });
  $('replayLast').onclick = () => app.lastReplay && startReplay(app.lastReplay);
  $('pbPlay').onclick = () => {
    const c = app.current;
    if (c?.kind !== 'replay') return;
    if (c.ended) seekReplay(0);
    c.playing = !c.playing;
    $('pbPlay').textContent = c.playing ? t('pb.pause') : t('pb.play');
  };
  $('pbSpeed').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b || app.current?.kind !== 'replay') return;
    app.current.speed = app.replaySpeed = Number(b.dataset.speed);
    $('pbSpeed').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('pbScrub').addEventListener('input', (e) => seekReplay(Number(e.target.value)));
  $('pbShare').onclick = () => {
    const c = app.current;
    if (c?.kind !== 'replay' || !c.source) return;
    const w = c.replayer.world;
    const at = !c.playing && !c.ended && w.tick > C.TICK_HZ ? w.tick : 0;
    copyText(shareUrl(c.source, at), at ? t('pb.copiedAt', { t: (at / C.TICK_HZ).toFixed(1) }) : t('pb.copiedStart'));
  };
  $('pbExit').onclick = () => {
    stopCurrent();
    idleStage();
  };
}

// A link that opens a replay on the public site (or wherever this page is served from).
function shareUrl(path, tick = 0) {
  const site = document.querySelector('meta[name="jev-arena-site"]')?.content;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = local && site && /^(ladder|seasons|highlights)\//.test(path) ? site : `${location.origin}${location.pathname}`;
  const at = tick > 0 ? `&t=${(tick / C.TICK_HZ).toFixed(1)}` : '';
  return `${base}?replay=${encodeURI(path)}${at}`;
}

async function loadReplayUrl(url) {
  try {
    startReplay(await getJson(url), { source: url });
  } catch (err) {
    toast(t('toast.loadReplay', { msg: err.message }));
    if (!OVERLAY) idleStage();
  }
}

function startReplay(replay, { source = null } = {}) {
  if (replay?.format !== 'jev-arena-replay') return toast(t('toast.notReplay'));
  if ((replay.engine ?? 1) !== C.ENGINE_VERSION) toast(t('toast.engine', { a: replay.engine ?? 1, b: C.ENGINE_VERSION }));
  stopCurrent();
  showTab('fight');
  let onEnd;
  const ended = new Promise((resolve) => (onEnd = resolve));
  app.current = { kind: 'replay', replay, source, replayer: createReplayer(replay), playing: true, speed: app.replaySpeed, acc: 0, ended: false, onEnd, done: ended };
  setupStage(replay.fighters, replay.brains.map((b) => b.label), t('stage.replay'), replay.mode);
  renderer.reset();
  renderer.push(snapshot(app.current.replayer.world), [], performance.now(), TICK_MS);
  $('playback').classList.add('show');
  $('pbShare').hidden = !source;
  document.body.classList.add('replaying');
  const f = replay.fighters;
  $('pbTitle').innerHTML = `<b>${esc(f[0].name)}</b> ${esc(t('replays.vs'))} <b>${esc(f[1].name)}</b> · ${esc(replay.brains[0].label)} · ${esc(modeName(replay.mode))}`;
  $('pbPlay').textContent = t('pb.pause');
  $('pbSpeed').querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === app.replaySpeed));
  $('pbScrub').max = String(replay.result?.tick ?? C.MATCH_TICKS);
  $('pbScrub').value = '0';
  if (OVERLAY) setOverlayBar('replay', f, replay.brains[0].label, source);
}

function replayStep(c, now, render = true) {
  const w = c.replayer.world;
  const ds = c.replayer.next();
  if (ds === null) {
    if (!c.ended) {
      c.ended = true;
      c.playing = false;
      $('pbPlay').textContent = t('pb.again');
      if (render) {
        if (c.replay.result && !OVERLAY) showResult(c.replay);
        c.onEnd?.(c.replay);
      }
    }
    return false;
  }
  const decisions = ds.map(normalizeDecision);
  for (const d of decisions) {
    app.minds[d.s].decision(d, null);
    if (render) {
      labelDecision(d.s, d, now);
      feedDecision(d, c.replay.fighters);
    }
  }
  if (render) {
    renderer.push(snapshot(w), w.events, now, TICK_MS / c.speed);
    feedEvents(w, c.replay.fighters);
    commentate(decisions, w);
    updateHud(w);
    $('pbScrub').value = String(w.tick);
    $('pbTime').textContent = `${(w.tick / C.TICK_HZ).toFixed(1)}s / ${((c.replay.result?.tick ?? C.MATCH_TICKS) / C.TICK_HZ).toFixed(1)}s`;
  }
  return true;
}

function seekReplay(tick, keepPlaying = false) {
  const c = app.current;
  if (c?.kind !== 'replay') return;
  $('resultModal').classList.remove('show');
  setupStage(c.replay.fighters, c.replay.brains.map((b) => b.label), t('stage.replay'), c.replay.mode);
  c.replayer = createReplayer(c.replay);
  c.ended = false;
  const now = performance.now();
  while (c.replayer.world.tick < tick && replayStep(c, now, false)) {}
  renderer.reset();
  const w = c.replayer.world;
  renderer.push(snapshot(w), [], now, TICK_MS);
  updateHud(w);
  $('pbScrub').value = String(w.tick);
  $('pbTime').textContent = `${(w.tick / C.TICK_HZ).toFixed(1)}s`;
  if (keepPlaying) c.playing = true;
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
  renderer.thinking = app.thinkingSince.map((x) => (c?.kind === 'live' ? x : null));
  app.minds.forEach((m, i) => {
    if (!m) return;
    const x = app.thinkingSince[i];
    m.tickThinking(c?.kind === 'live' && x !== null && now - x > 150 ? Math.round(now - x) : null);
  });
  renderer.draw(now);
  requestAnimationFrame(frame);
}

// =============================================================================================
// ladder, seasons, replay list
// =============================================================================================

function seasonBase(id) {
  const s = app.seasons?.find((x) => String(x.id) === String(id));
  return s ? s.dir : 'ladder';
}

async function loadSeasons() {
  let index = null;
  try {
    index = await getJson('seasons/index.json');
  } catch {}
  app.seasons = index?.seasons || [];
  if (app.seasons.length) {
    $('seasonSelect').innerHTML =
      `<option value="">${esc(t('ladder.current'))}</option>` + app.seasons.map((s) => `<option value="${esc(s.id)}">${esc(t('ladder.archived', { name: s.name }))}</option>`).join('');
    $('seasonPick').hidden = false;
    $('seasonSelect').onchange = () => loadLadder(seasonBase($('seasonSelect').value));
  }
  await loadLadder('ladder');
}

async function loadLadder(base = 'ladder') {
  app.ladderBase = base;
  let board;
  try {
    board = await getJson(`${base}/leaderboard.json`);
  } catch {
    $('ladderBody').innerHTML = `<div class="empty">${t('ladder.none')}</div>`;
    $('replayList').innerHTML = `<div class="empty">${esc(t('replays.empty'))}</div>`;
    return;
  }
  const mockNote = String(board.brain).startsWith('mock') ? t('ladder.mock') : '';
  const format = board.format === 'swiss' ? t('ladder.swiss', { n: board.rounds }) : t('ladder.roundrobin');
  const season = app.seasons?.find((s) => s.dir === base);
  const champ = season?.champion ? `<br><b>${esc(t('ladder.champion', { name: season.champion.name, author: season.champion.author }))}</b>` : '';
  $('ladderMeta').innerHTML =
    t('ladder.meta', { brain: esc(board.brain), mode: esc(modeName(board.mode)), format: esc(format), games: board.gamesPerPair, when: esc(board.generatedAt.slice(0, 16).replace('T', ' ')) }) +
    (board.totalCostUsd ? t('ladder.cost', { usd: board.totalCostUsd }) : '') +
    t('ladder.dot') +
    mockNote +
    champ;
  $('ladderBody').innerHTML = `<div style="overflow-x:auto"><table class="board">
    <tr><th>#</th><th>${esc(t('ladder.col.fighter'))}</th><th>${esc(t('ladder.col.author'))}</th><th class="num">Elo</th><th class="num">W-D-L</th><th class="num">KOs</th><th class="num">${esc(t('ladder.col.dmg'))}</th><th class="num">${esc(t('ladder.col.dps'))}</th><th class="num">p50</th></tr>
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
      (m) => `<div class="match-row"><div><b>${esc(names[m.a] || m.a)}</b> ${esc(t('replays.vs'))} <b>${esc(names[m.b] || m.b)}</b>${m.round ? ` <span class="round">R${m.round}</span>` : ''}</div>
      <div class="res">${m.winner ? `${esc(names[m.winner] || m.winner)} · ${m.reason === 'ko' ? esc(t('replays.ko', { s: m.seconds })) : esc(t('replays.onHealth'))}` : esc(t('replays.draw'))}</div>
      <span class="row-actions"><button class="ghost" data-file="${esc(m.file)}">${esc(t('replays.watch'))}</button><button class="ghost small" data-link="${esc(m.file)}">${esc(t('replays.link'))}</button></span></div>`,
    )
    .join('');
  $('replayList').onclick = (e) => {
    const w = e.target.closest('button[data-file]');
    if (w) loadReplayUrl(`${base}/${w.dataset.file}`);
    const l = e.target.closest('button[data-link]');
    if (l) copyText(shareUrl(`${base}/${l.dataset.link}`, 0), t('pb.copiedStart'));
  };
}

async function loadHighlights() {
  let idx = null;
  try {
    idx = await getJson('highlights/index.json');
  } catch {}
  app.highlights = idx?.highlights || [];
  if (!app.highlights.length) return;
  $('highlightsBox').hidden = false;
  const zh = getLang() === 'zh-TW';
  $('highlightList').innerHTML = app.highlights
    .map(
      (h) => `<div class="match-row"><div><b>${esc(zh && h.title_zh ? h.title_zh : h.title)}</b></div><div class="res"></div>
      <span class="row-actions"><button class="ghost" data-file="${esc(h.file)}">${esc(t('replays.watch'))}</button><button class="ghost small" data-link="${esc(h.file)}">${esc(t('replays.link'))}</button></span></div>`,
    )
    .join('');
  $('highlightList').onclick = (e) => {
    const w = e.target.closest('button[data-file]');
    if (w) loadReplayUrl(w.dataset.file);
    const l = e.target.closest('button[data-link]');
    if (l) copyText(shareUrl(l.dataset.link, 0), t('pb.copiedStart'));
  };
}

// =============================================================================================
// broadcast overlay (?overlay=1)
// =============================================================================================

// The badge says where a replay came from: the current ladder, an archived season or a highlight.
function replayBadge(source) {
  const s = String(source || '');
  const season = app.seasons?.find((x) => x.dir && s.startsWith(`${x.dir}/`));
  if (season) return t('ov.season', { id: season.id });
  if (s.startsWith('highlights/')) return t('ov.highlight');
  if (s.startsWith('ladder/')) return t('ov.replay');
  return t('ov.replayAny');
}

function setOverlayBar(kind, fighters, brainLabel, source = null) {
  $('ovBadge').textContent = kind === 'live' ? t('ov.live') : replayBadge(source);
  $('ovBadge').className = `ov-badge ${kind}`;
  $('ovTitle').innerHTML = `${nameHtml(0, fighters)} ${esc(t('replays.vs'))} ${nameHtml(1, fighters)} <span>· ${esc(brainLabel)}</span>`;
  const site = document.querySelector('meta[name="jev-arena-site"]')?.content || location.href;
  $('ovSite').textContent = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function showCard(html, ms) {
  $('ovCard').innerHTML = html;
  $('ovCard').classList.add('show');
  return sleep(ms).then(() => $('ovCard').classList.remove('show'));
}

function nextCard(fighters) {
  const colors = sideColors(fighters.map((f) => f.color));
  return `<div class="k">${esc(t('ov.next'))}</div>
    <div class="ov-vs"><b style="color:${colors[0]}">${esc(fighters[0].name)}</b><span>${esc(t('replays.vs'))}</span><b style="color:${colors[1]}">${esc(fighters[1].name)}</b></div>
    <div class="tags"><i>${esc(fighters[0].tagline || '')}</i><i>${esc(fighters[1].tagline || '')}</i></div>`;
}

function winnerCard(replay) {
  const { r, how } = resultLines(replay);
  const f = replay.fighters;
  if (r.winner === null) return `<div class="k">${esc(t('res.draw'))}</div>`;
  const colors = sideColors(f.map((x) => x.color));
  const s = replay.summary?.[r.winner];
  return `<div class="k">${esc(t('ov.winner'))}</div>
    <div class="big" style="color:${colors[r.winner]}">${esc(f[r.winner].name)}</div>
    <div class="sub">${esc(how)} · ${Math.round(r.hp[r.winner])} HP</div>
    ${s ? `<div class="sub">${esc(t('ov.decisions', { n: s.decisions, ms: s.p50LatencyMs ?? '–' }))}</div>` : ''}`;
}

async function bootOverlay() {
  $('overlay').classList.remove('show');
  const shuffle = params.has('shuffle');
  const loop = params.get('loop') !== '0';
  if (params.get('red') && params.get('blue')) return overlayLive(loop);
  let files = [];
  if (params.get('replay')) files = [params.get('replay')];
  else if (params.get('playlist') === 'highlights') files = (app.highlights || []).map((h) => h.file);
  else {
    const base = params.get('season') ? seasonBase(params.get('season')) : 'ladder';
    try {
      const board = await getJson(`${base}/leaderboard.json`);
      files = board.matches.map((m) => `${base}/${m.file}`);
    } catch (err) {
      return toast(t('toast.loadReplay', { msg: err.message }));
    }
  }
  if (shuffle) files.sort(() => Math.random() - 0.5);
  for (let i = 0; ; i = (i + 1) % files.length) {
    let replay;
    try {
      replay = await getJson(files[i]);
    } catch {
      await sleep(1000);
      continue;
    }
    if (files.length > 1) {
      stopCurrent();
      setupStage(replay.fighters, replay.brains.map((b) => b.label), t('stage.replay'), replay.mode);
      renderer.reset();
      setOverlayBar('replay', replay.fighters, replay.brains[0].label, files[i]);
      await showCard(nextCard(replay.fighters), 3500);
    }
    startReplay(replay, { source: files[i] });
    const done = await app.current.done;
    await sleep(1200);
    await showCard(winnerCard(done), 6000);
    if (!loop && i === files.length - 1) break;
  }
}

async function overlayLive(loop) {
  const brain = params.get('brain') || 'mock';
  const mode = params.get('mode') === 'lockstep' ? 'lockstep' : 'realtime';
  let a = params.get('red');
  let b = params.get('blue');
  for (;;) {
    const fighters = [fighterById(a), fighterById(b)];
    if (!fighters[0] || !fighters[1]) return toast(t('toast.pickTwo'));
    setupStage(fighters, [brain, brain], t('stage.ready'), mode);
    renderer.reset();
    setOverlayBar('live', fighters, brain);
    await showCard(nextCard(fighters), 3500);
    app.lastReplay = null;
    await startLive({ a, b, brainA: brain, brainB: brain, mode }); // resolves when the fight ends
    const replay = app.lastReplay;
    if (!replay) return;
    await sleep(1200);
    await showCard(winnerCard(replay), 6000);
    if (!loop) return;
    const ids = app.fighters.map((f) => f.id).sort(() => Math.random() - 0.5);
    [a, b] = ids;
  }
}

// =============================================================================================
// fighter lab
// =============================================================================================

const LAB_KEY = 'jev-arena.lab.v1';

function initLab() {
  $('labTemplate').innerHTML = `<option value="">${esc(t('lab.blank'))}</option>` + app.fighters.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  $('labFallback').innerHTML = MOVEMENT_ACTIONS.map((a) => `<option value="${a}">${esc(moveLabel(a))}</option>`).join('');
  $('labNotes').innerHTML = ACTION_IDS.map((a) => `<label for="note-${a}">${esc(moveLabel(a))}</label><input type="text" id="note-${a}" maxlength="${LIMITS.actionNote}" placeholder="${esc(t('lab.notePh'))}" />`).join('');

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
    if (rs.length >= LIMITS.reflexes) return toast(t('lab.maxReflexes', { n: LIMITS.reflexes }));
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
  $('labCopy').onclick = () => copyText($('labYaml').textContent, t('lab.yamlCopied'));
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
        <input type="text" class="r-when" maxlength="${LIMITS.reflexWhen}" placeholder="${esc(t('lab.whenPh'))}" value="${esc(r.when)}" />
        <select class="r-do">${ACTION_IDS.map((a) => `<option value="${a}" ${a === r.do ? 'selected' : ''}>${esc(moveLabel(a))}</option>`).join('')}</select>
        <input type="range" class="r-th" min="0.5" max="0.99" step="0.01" value="${r.threshold}" title="${esc(t('lab.threshold'))}" />
        <button class="x" data-i="${i}" title="${esc(t('lab.remove'))}">×</button>
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
  $('labStatus').innerHTML = ok ? `<div class="ok">${esc(t('lab.valid'))}</div>` : `<ul class="errors">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
  $('labYaml').textContent = fighterToYaml(fighter);
  try {
    localStorage.setItem(LAB_KEY, JSON.stringify(raw));
  } catch {}
}

// =============================================================================================
// utils
// =============================================================================================

function copyText(text, okMsg) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    toast(ok ? okMsg : t('toast.copyFailed', { text }));
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback);
  else fallback();
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
