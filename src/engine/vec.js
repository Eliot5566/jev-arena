// Tiny 2D vector helpers. The simulation only uses + - * / and sqrt, which are exact
// IEEE operations in every JS engine, so replays re-simulate identically everywhere.

export const v = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.sqrt(a.x * a.x + a.y * a.y);
export const dist = (a, b) => len(sub(a, b));
export const norm = (a) => {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
// Rotate +90 degrees (counter-clockwise in math coords, clockwise on a y-down screen).
export const perp = (a) => ({ x: -a.y, y: a.x });

// Does the segment p->q pass within r of point c?
export function segmentHitsCircle(p, q, c, r) {
  const d = sub(q, p);
  const f = sub(p, c);
  const dd = dot(d, d);
  if (dd < 1e-12) return dot(f, f) <= r * r;
  let t = -dot(f, d) / dd;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const closest = add(p, mul(d, t));
  const off = sub(closest, c);
  return dot(off, off) <= r * r;
}

export const round = (n, digits = 2) => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};
