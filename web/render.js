import * as C from '../src/engine/constants.js';
import { zoneAt } from '../src/engine/world.js';
import { t, moveLabel } from './i18n.js';

// Canvas renderer. The simulation ticks at 20 Hz; this draws at display rate and interpolates
// between the last two snapshots so motion stays smooth.

const TAU = Math.PI * 2;
const POWERUP_STYLE = {
  repair: { color: '#4ade80', glyph: '+', label: 'fx.repair' },
  battery: { color: '#ffd166', glyph: 'ϟ', label: 'fx.battery' },
  overdrive: { color: '#f472b6', glyph: '★', label: 'fx.overdrive' },
};

export class ArenaRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = ['#ff4d6d', '#3db8ff'];
    this.names = ['Red', 'Blue'];
    this.prev = null;
    this.cur = null;
    this.tickAt = 0;
    this.tickMs = 50;
    this.particles = [];
    this.texts = [];
    this.trails = [[], []];
    this.labels = [null, null];
    this.thinking = [null, null];
    this.shake = 0;
    this.lastFrame = 0;
    this.resize();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas);
    else window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = Math.max(10, Math.round(r.width * dpr));
    this.canvas.height = Math.max(10, Math.round(r.height * dpr));
    this.s = this.canvas.width / C.ARENA_W;
  }

  setFighters(fighters) {
    this.names = fighters.map((f) => f.name);
    this.colors = sideColors(fighters.map((f) => f.color));
  }

  reset() {
    this.prev = null;
    this.cur = null;
    this.particles = [];
    this.texts = [];
    this.trails = [[], []];
    this.labels = [null, null];
    this.thinking = [null, null];
    this.shake = 0;
  }

  push(snap, events, now, tickMs) {
    this.prev = this.cur || snap;
    this.cur = snap;
    this.tickAt = now;
    this.tickMs = tickMs;
    snap.fighters.forEach((f, i) => {
      if (f.dash > 0) this.trails[i].push({ x: f.x, y: f.y, t: now });
    });
    for (const e of events) this.effect(e, now);
  }

  showDecision(side, action, source, now) {
    this.labels[side] = {
      text: moveLabel(action).toUpperCase(),
      reflex: source.startsWith('reflex'),
      fallback: source.startsWith('fallback'),
      t0: now,
    };
  }

  effect(e, now) {
    const col = e.side >= 0 ? this.colors[e.side] : '#ffffff';
    switch (e.type) {
      case 'shot':
        this.burst(e.x, e.y, col, 5, 2.5, 0.25);
        break;
      case 'blast':
        this.burst(e.x, e.y, col, 18, 5, 0.45);
        this.shake = Math.max(this.shake, 4);
        break;
      case 'hit': {
        if (e.amount < 0.5) break;
      const big = e.kind === 'blast' || e.kind === 'melee';
        this.burst(e.x, e.y, col, big ? 22 : 8, big ? 6 : 3.5, big ? 0.5 : 0.3);
        this.text(e.x + 0.7, e.y - 0.3, `-${Math.round(e.amount)}`, big ? '#ffffff' : '#ffd2d9', big ? 20 : 14, now);
        if (big) this.shake = Math.max(this.shake, e.kind === 'blast' ? 9 : 6);
        break;
      }
      case 'blocked':
        this.text(e.x, e.y - 1.4, t('fx.blocked'), '#7dd3fc', 13, now);
        break;
      case 'dodge':
        this.text(e.x, e.y - 1.4, t('fx.dodge'), '#c6ff3d', 13, now);
        break;
      case 'guard_break':
        this.text(e.x, e.y - 1.6, t('fx.guardBreak'), '#ffd166', 17, now);
        this.shake = Math.max(this.shake, 7);
        break;
      case 'impact':
        this.burst(e.x, e.y, '#94a3b8', e.kind === 'blast' ? 14 : 5, 3, 0.3);
        break;
      case 'pickup': {
        const st = POWERUP_STYLE[e.kind];
        this.ring(e.x, e.y, st.color, now);
        this.text(e.x, e.y - 1.2, t(st.label), st.color, 15, now);
        break;
      }
      case 'powerup_spawn':
        this.ring(e.x, e.y, POWERUP_STYLE[e.kind].color, now);
        break;
      case 'charge_cancel':
        this.text(e.x, e.y - 1.4, t('fx.cancelled'), '#94a3b8', 12, now);
        break;
      case 'zone_burn':
        this.burst(e.x, e.y, '#ff4d6d', 4, 1.5, 0.4);
        break;
      case 'zone_start':
        this.shake = Math.max(this.shake, 4);
        break;
      case 'whiff':
        this.text(e.x, e.y - 1.4, t('fx.whiff'), '#94a3b8', 12, now);
        break;
      case 'ko': {
        if (e.side >= 0 && this.cur) {
          const loser = this.cur.fighters[1 - e.side];
          this.burst(loser.x, loser.y, this.colors[1 - e.side], 60, 9, 0.9);
          this.burst(loser.x, loser.y, '#ffffff', 25, 6, 0.6);
        }
        this.shake = 14;
        break;
      }
      default:
    }
  }

  burst(x, y, color, n, speed, life) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: 0.05 + Math.random() * 0.07 });
    }
  }

  ring(x, y, color, now) {
    this.particles.push({ ring: true, x, y, color, t0: now, dur: 600 });
  }

  text(x, y, text, color, size, now) {
    this.texts.push({ x, y, text, color, size, t0: now, dur: 900 });
  }

  // ---------------------------------------------------------------------------------------------

  draw(now) {
    const { ctx, canvas } = this;
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * this.shake * this.dpr, (Math.random() - 0.5) * this.shake * this.dpr);
      this.shake *= 0.86;
    }

    this.drawFloor();
    this.drawPads(now);
    this.drawPillars();

    const a = this.cur ? Math.max(0, Math.min(1, (now - this.tickAt) / this.tickMs)) : 0;
    if (this.cur) this.drawZone(this.cur.tick + a, now);
    if (this.cur) {
      this.drawPowerups(now);
      this.drawTrails(now);
      this.drawProjectiles(a);
      this.cur.fighters.forEach((f, i) => this.drawFighter(i, a, now));
    } else {
      C.SPAWNS.forEach((sp, i) => this.drawIdleFighter(i, sp, now));
    }
    this.drawParticles(dt, now);
    this.drawTexts(now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawVignette();
  }

  drawFloor() {
    const { ctx, s } = this;
    const w = C.ARENA_W * s;
    const h = C.ARENA_H * s;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
    g.addColorStop(0, '#0f1a33');
    g.addColorStop(1, '#060a14');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1 * this.dpr;
    for (let x = 1; x < C.ARENA_W; x++) {
      ctx.strokeStyle = x % 4 === 0 ? 'rgba(100,140,220,0.13)' : 'rgba(100,140,220,0.05)';
      ctx.beginPath();
      ctx.moveTo(x * s, 0);
      ctx.lineTo(x * s, h);
      ctx.stroke();
    }
    for (let y = 1; y < C.ARENA_H; y++) {
      ctx.strokeStyle = y % 4 === 0 ? 'rgba(100,140,220,0.13)' : 'rgba(100,140,220,0.05)';
      ctx.beginPath();
      ctx.moveTo(0, y * s);
      ctx.lineTo(w, y * s);
      ctx.stroke();
    }
    // side tints
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, hexA(this.colors[0], 0.08));
    lg.addColorStop(0.3, 'rgba(0,0,0,0)');
    lg.addColorStop(0.7, 'rgba(0,0,0,0)');
    lg.addColorStop(1, hexA(this.colors[1], 0.08));
    ctx.fillStyle = lg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(198,255,61,0.35)';
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeRect(1 * this.dpr, 1 * this.dpr, w - 2 * this.dpr, h - 2 * this.dpr);
  }

  drawZone(tick, now) {
    const z = zoneAt(tick);
    if (!z.closing) return;
    const { ctx, s } = this;
    const W = C.ARENA_W * s;
    const H = C.ARENA_H * s;
    ctx.save();
    ctx.fillStyle = `rgba(255,60,90,${0.14 + Math.sin(now / 300) * 0.03})`;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(z.x0 * s, z.y0 * s, (z.x1 - z.x0) * s, (z.y1 - z.y0) * s);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,90,120,0.9)';
    ctx.shadowColor = '#ff4d6d';
    ctx.shadowBlur = 14 * this.dpr;
    ctx.lineWidth = 2 * this.dpr;
    ctx.setLineDash([10 * this.dpr, 6 * this.dpr]);
    ctx.lineDashOffset = -(now / 40) % 16;
    ctx.strokeRect(z.x0 * s, z.y0 * s, (z.x1 - z.x0) * s, (z.y1 - z.y0) * s);
    ctx.restore();
  }

  drawPads(now) {
    const { ctx, s } = this;
    for (const p of C.POWERUP_PADS) {
      ctx.strokeStyle = 'rgba(148,163,184,0.18)';
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.lineDashOffset = (now / 60) % 8;
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, 0.7 * s, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawPillars() {
    const { ctx, s } = this;
    for (const p of C.PILLARS) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.arc(p.x * s + 0.15 * s, p.y * s + 0.2 * s, p.r * s, 0, TAU);
      ctx.fill();
      const g = ctx.createRadialGradient(p.x * s - p.r * s * 0.3, p.y * s - p.r * s * 0.3, p.r * s * 0.1, p.x * s, p.y * s, p.r * s);
      g.addColorStop(0, '#2b3a5c');
      g.addColorStop(1, '#141d33');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, p.r * s, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(125,211,252,0.45)';
      ctx.lineWidth = 2 * this.dpr;
      ctx.stroke();
    }
  }

  drawPowerups(now) {
    const { ctx, s } = this;
    for (const pu of this.cur.powerups) {
      const st = POWERUP_STYLE[pu.type];
      if (pu.ttl < 60 && Math.floor(now / 120) % 2 === 0) continue;
      const pulse = 1 + Math.sin(now / 180) * 0.08;
      ctx.save();
      ctx.shadowColor = st.color;
      ctx.shadowBlur = 18 * this.dpr;
      ctx.fillStyle = hexA(st.color, 0.2);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.arc(pu.x * s, pu.y * s, 0.42 * s * pulse, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = st.color;
      ctx.font = `700 ${Math.round(0.5 * s)}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(st.glyph, pu.x * s, pu.y * s + 0.02 * s);
    }
  }

  drawTrails(now) {
    const { ctx, s } = this;
    this.trails.forEach((trail, i) => {
      while (trail.length && now - trail[0].t > 260) trail.shift();
      for (const p of trail) {
        const k = 1 - (now - p.t) / 260;
        ctx.fillStyle = hexA(this.colors[i], 0.35 * k);
        ctx.beginPath();
        ctx.arc(p.x * s, p.y * s, C.FIGHTER_RADIUS * s, 0, TAU);
        ctx.fill();
      }
    });
  }

  drawProjectiles(a) {
    const { ctx, s } = this;
    const prevById = new Map((this.prev?.projectiles || []).map((p) => [p.id, p]));
    for (const p of this.cur.projectiles) {
      const q = prevById.get(p.id);
      const x = q ? q.x + (p.x - q.x) * a : p.x;
      const y = q ? q.y + (p.y - q.y) * a : p.y;
      const col = this.colors[p.owner];
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = (p.kind === 'blast' ? 26 : 12) * this.dpr;
      if (q) {
        ctx.strokeStyle = hexA(col, 0.5);
        ctx.lineWidth = p.r * 1.4 * s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(q.x * s - (p.x - q.x) * s * 0.8, q.y * s - (p.y - q.y) * s * 0.8);
        ctx.lineTo(x * s, y * s);
        ctx.stroke();
      }
      ctx.fillStyle = p.kind === 'blast' ? '#ffffff' : col;
      ctx.beginPath();
      ctx.arc(x * s, y * s, p.r * s * (p.kind === 'blast' ? 1.1 : 1.3), 0, TAU);
      ctx.fill();
      if (p.kind === 'blast') {
        ctx.strokeStyle = col;
        ctx.lineWidth = 3 * this.dpr;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawIdleFighter(i, sp, now) {
    const bob = Math.sin(now / 400 + i) * 0.04;
    this.drawBody(i, sp.x, sp.y + bob, { x: i === 0 ? 1 : -1, y: 0 }, null, now);
  }

  drawFighter(i, a, now) {
    const f = this.cur.fighters[i];
    const q = this.prev.fighters[i];
    const x = q.x + (f.x - q.x) * a;
    const y = q.y + (f.y - q.y) * a;
    this.drawBody(i, x, y, f.face, f, now);
  }

  drawBody(i, x, y, face, f, now) {
    const { ctx, s } = this;
    const R = C.FIGHTER_RADIUS * s;
    const col = this.colors[i];
    const px = x * s;
    const py = y * s;

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(px + 0.1 * s, py + 0.25 * s, R * 1.05, R * 0.6, 0, 0, TAU);
    ctx.fill();

    if (f && f.overdrive > 0) {
      ctx.save();
      ctx.shadowColor = '#f472b6';
      ctx.shadowBlur = 30 * this.dpr;
      ctx.strokeStyle = hexA('#f472b6', 0.7);
      ctx.lineWidth = 3 * this.dpr;
      ctx.beginPath();
      ctx.arc(px, py, R * (1.35 + Math.sin(now / 90) * 0.06), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // charge ring
    if (f && f.charge > 0) {
      const total = C.secondsToTicks(C.BLAST.chargeTime);
      const prog = 1 - f.charge / total;
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 24 * this.dpr;
      ctx.strokeStyle = col;
      ctx.lineWidth = 4 * this.dpr;
      ctx.beginPath();
      ctx.arc(px, py, R * 1.7, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
      ctx.stroke();
      ctx.fillStyle = hexA(col, 0.12 + prog * 0.2);
      ctx.beginPath();
      ctx.arc(px, py, R * 1.7 * (1 - prog * 0.3), 0, TAU);
      ctx.fill();
      ctx.restore();
      if (Math.random() < 0.6) {
        const ang = Math.random() * TAU;
        this.particles.push({ x: x + Math.cos(ang) * 1.2, y: y + Math.sin(ang) * 1.2, vx: -Math.cos(ang) * 3, vy: -Math.sin(ang) * 3, life: 0.3, max: 0.3, color: col, size: 0.05 });
      }
    }

    // body
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = 16 * this.dpr;
    const g = ctx.createRadialGradient(px - R * 0.35, py - R * 0.35, R * 0.1, px, py, R);
    g.addColorStop(0, lighten(col, 0.35));
    g.addColorStop(1, darken(col, 0.45));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, R, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = lighten(col, 0.5);
    ctx.lineWidth = 2 * this.dpr;
    ctx.beginPath();
    ctx.arc(px, py, R, 0, TAU);
    ctx.stroke();

    // visor pointing at the enemy
    const fx = face.x;
    const fy = face.y;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(px + fx * R * 1.25, py + fy * R * 1.25);
    ctx.lineTo(px + fx * R * 0.55 - fy * R * 0.45, py + fy * R * 0.55 + fx * R * 0.45);
    ctx.lineTo(px + fx * R * 0.55 + fy * R * 0.45, py + fy * R * 0.55 - fx * R * 0.45);
    ctx.closePath();
    ctx.fill();

    // shield bubble
    if (f && f.shield > 0) {
      ctx.save();
      ctx.shadowColor = '#7dd3fc';
      ctx.shadowBlur = 20 * this.dpr;
      ctx.fillStyle = 'rgba(125,211,252,0.14)';
      ctx.strokeStyle = 'rgba(125,211,252,0.9)';
      ctx.lineWidth = 2.5 * this.dpr;
      ctx.beginPath();
      ctx.arc(px, py, R * 1.55, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // stun stars
    if (f && f.stun > 0) {
      for (let k = 0; k < 3; k++) {
        const ang = now / 150 + (k * TAU) / 3;
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(px + Math.cos(ang) * R * 1.1, py - R * 1.1 + Math.sin(ang) * R * 0.35, 2.5 * this.dpr, 0, TAU);
        ctx.fill();
      }
    }

    // mini hp bar + name
    if (f) {
      const w = R * 2.4;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(px - w / 2, py + R * 1.35, w, 4 * this.dpr);
      ctx.fillStyle = f.hp > 45 ? '#4ade80' : f.hp > 20 ? '#ffd166' : '#ff4d6d';
      ctx.fillRect(px - w / 2, py + R * 1.35, (w * Math.max(0, f.hp)) / 100, 4 * this.dpr);
    }
    ctx.font = `600 ${Math.round(11 * this.dpr)}px 'Space Grotesk', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = hexA(lighten(col, 0.4), 0.9);
    ctx.fillText(this.names[i], px, py - R * 1.75);

    // decision label
    const lab = this.labels[i];
    if (lab && now - lab.t0 < 750) {
      const k = 1 - (now - lab.t0) / 750;
      ctx.font = `700 ${Math.round(12 * this.dpr)}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = lab.reflex ? hexA('#c6ff3d', k) : lab.fallback ? hexA('#ffd166', k) : hexA('#ffffff', k * 0.9);
      ctx.fillText((lab.reflex ? '⚡ ' : '') + lab.text, px, py - R * 1.75 - 15 * this.dpr - (1 - k) * 8 * this.dpr);
    }

    // thinking bubble (only when a brain has been silent for a while)
    const th = this.thinking[i];
    if (th !== null && now - th > 300) {
      const ms = Math.round(now - th);
      const bx = px + R * 1.2;
      const by = py - R * 2.4;
      ctx.fillStyle = 'rgba(14,21,38,0.92)';
      ctx.strokeStyle = hexA(col, 0.8);
      ctx.lineWidth = 1.5 * this.dpr;
      roundRect(ctx, bx, by - 14 * this.dpr, 64 * this.dpr, 20 * this.dpr, 8 * this.dpr);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e6edf7';
      ctx.font = `600 ${Math.round(10 * this.dpr)}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'left';
      const dots = '.'.repeat(1 + (Math.floor(now / 250) % 3));
      ctx.fillText(`${dots} ${ms}ms`, bx + 6 * this.dpr, by);
    }
  }

  drawParticles(dt, now) {
    const { ctx, s } = this;
    const keep = [];
    for (const p of this.particles) {
      if (p.ring) {
        const k = (now - p.t0) / p.dur;
        if (k >= 1) continue;
        ctx.strokeStyle = hexA(p.color, 1 - k);
        ctx.lineWidth = 3 * this.dpr * (1 - k);
        ctx.beginPath();
        ctx.arc(p.x * s, p.y * s, (0.4 + k * 1.6) * s, 0, TAU);
        ctx.stroke();
        keep.push(p);
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      ctx.fillStyle = hexA(p.color, p.life / p.max);
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, p.size * s, 0, TAU);
      ctx.fill();
      keep.push(p);
    }
    this.particles = keep.slice(-600);
  }

  drawTexts(now) {
    const { ctx, s } = this;
    this.texts = this.texts.filter((t) => now - t.t0 < t.dur);
    for (const t of this.texts) {
      const k = (now - t.t0) / t.dur;
      ctx.font = `800 ${Math.round(t.size * this.dpr * (1 + (1 - k) * 0.15))}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3 * this.dpr;
      ctx.strokeStyle = `rgba(0,0,0,${0.7 * (1 - k)})`;
      ctx.strokeText(t.text, t.x * s, t.y * s - k * 0.8 * s);
      ctx.fillStyle = hexA(t.color, 1 - k * k);
      ctx.fillText(t.text, t.x * s, t.y * s - k * 0.8 * s);
    }
  }

  drawVignette() {
    const { ctx, canvas } = this;
    const g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.height * 0.35, canvas.width / 2, canvas.height / 2, canvas.width * 0.65);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

// ---------- color helpers ----------

function parseHex(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function hexA(hex, a) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
function mix(hex, target, k) {
  const [r, g, b] = parseHex(hex);
  const m = (c) => Math.round(c + (target - c) * k).toString(16).padStart(2, '0');
  return `#${m(r)}${m(g)}${m(b)}`;
}
const lighten = (hex, k) => mix(hex, 255, k);
const darken = (hex, k) => mix(hex, 0, k);

// If both fighters picked near-identical colors, nudge the blue corner so they stay readable.
export function sideColors([a, b]) {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  const d = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
  if (d > 90) return [a, b];
  return [a, d === 0 || r1 > b1 ? '#3db8ff' : '#ff4d6d'];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
