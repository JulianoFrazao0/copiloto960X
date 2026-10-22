// Rotas no formato do PathPlanner (.path / .auto, versão 2025) e a geração
// de trajetória usada na prévia: Bézier cúbica entre waypoints, perfil de
// velocidade com aceleração limitada (inclusive nas curvas) e rotação
// interpolada entre os alvos de rotação.
//
// A prévia é uma estimativa: o PathPlannerLib usa o modelo físico completo do
// robô (massa, motores, atrito), então o tempo real pode variar um pouco.

import { clamp, deepCopy, rad, wrapAngle } from './util.js';

export const PP_VERSION = '2025.0';

export function constraintsFrom(c = {}) {
  return {
    maxVelocity: c.maxVelocity ?? 3.0,
    maxAcceleration: c.maxAcceleration ?? 3.0,
    maxAngularVelocity: c.maxAngularVelocity ?? 540.0,
    maxAngularAcceleration: c.maxAngularAcceleration ?? 720.0,
    nominalVoltage: c.nominalVoltage ?? 12.0,
    unlimited: !!c.unlimited,
  };
}

const wp = (ax, ay, prev, next) => ({
  anchor: { x: ax, y: ay },
  prevControl: prev ? { x: prev[0], y: prev[1] } : null,
  nextControl: next ? { x: next[0], y: next[1] } : null,
  isLocked: false,
  linkedName: null,
});

export function newPath(constraints, from = [2.0, 4.0], to = [5.0, 4.0]) {
  const dx = (to[0] - from[0]) / 3, dy = (to[1] - from[1]) / 3;
  return normalizePath({
    version: PP_VERSION,
    waypoints: [wp(from[0], from[1], null, [from[0] + dx, from[1] + dy]), wp(to[0], to[1], [to[0] - dx, to[1] - dy], null)],
    globalConstraints: constraintsFrom(constraints),
  });
}

/** Completa campos que faltam e converte arquivos de versões anteriores. */
export function normalizePath(p) {
  p = deepCopy(p) || {};
  p.version = PP_VERSION;
  p.waypoints = p.waypoints || [];
  p.rotationTargets = (p.rotationTargets || []).map((r) => ({ waypointRelativePos: r.waypointRelativePos ?? 0, rotationDegrees: r.rotationDegrees ?? 0 }));
  p.constraintZones = p.constraintZones || [];
  p.pointTowardsZones = p.pointTowardsZones || [];
  p.eventMarkers = (p.eventMarkers || []).map((m) => ({
    name: m.name || 'Evento',
    waypointRelativePos: m.waypointRelativePos ?? 0,
    endWaypointRelativePos: m.endWaypointRelativePos ?? null,
    command: m.command === undefined ? null : m.command,
  }));
  p.globalConstraints = constraintsFrom(p.globalConstraints);
  p.goalEndState = { velocity: p.goalEndState?.velocity ?? 0, rotation: p.goalEndState?.rotation ?? 0 };
  const start = p.idealStartingState || p.previewStartingState || {};
  p.idealStartingState = { velocity: start.velocity ?? 0, rotation: start.rotation ?? 0 };
  delete p.previewStartingState;
  p.reversed = !!p.reversed;
  p.folder = p.folder ?? null;
  p.useDefaultConstraints = p.useDefaultConstraints ?? true;
  for (const w of p.waypoints) {
    w.isLocked = !!w.isLocked;
    w.linkedName = w.linkedName ?? null;
  }
  return p;
}

export function newAuto() {
  return { version: PP_VERSION, command: { type: 'sequential', data: { commands: [] } }, resetOdom: true, folder: null, choreoAuto: false };
}

export function normalizeAuto(a) {
  a = deepCopy(a) || newAuto();
  a.version = PP_VERSION;
  if (!a.command || !a.command.data) a.command = { type: 'sequential', data: { commands: [] } };
  a.resetOdom = a.resetOdom ?? true;
  a.folder = a.folder ?? null;
  a.choreoAuto = !!a.choreoAuto;
  return a;
}

// ---- Bézier ------------------------------------------------------------------
export function segments(path) {
  const w = path.waypoints, out = [];
  for (let i = 0; i < w.length - 1; i++) {
    const a = w[i], b = w[i + 1];
    out.push([a.anchor, a.nextControl || a.anchor, b.prevControl || b.anchor, b.anchor]);
  }
  return out;
}

export function bez(s, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x, y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y };
}

function bezD(s, t) {
  const u = 1 - t;
  return {
    x: 3 * u * u * (s[1].x - s[0].x) + 6 * u * t * (s[2].x - s[1].x) + 3 * t * t * (s[3].x - s[2].x),
    y: 3 * u * u * (s[1].y - s[0].y) + 6 * u * t * (s[2].y - s[1].y) + 3 * t * t * (s[3].y - s[2].y),
  };
}

function bezD2(s, t) {
  const u = 1 - t;
  return {
    x: 6 * u * (s[2].x - 2 * s[1].x + s[0].x) + 6 * t * (s[3].x - 2 * s[2].x + s[1].x),
    y: 6 * u * (s[2].y - 2 * s[1].y + s[0].y) + 6 * t * (s[3].y - 2 * s[2].y + s[1].y),
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Ponto (e direção) numa posição relativa aos waypoints (0 = primeiro, n-1 = último). */
export function pointAt(path, pos) {
  const segs = segments(path);
  if (!segs.length) {
    const a = path.waypoints[0]?.anchor || { x: 0, y: 0 };
    return { x: a.x, y: a.y, heading: 0 };
  }
  pos = clamp(pos, 0, segs.length);
  const i = Math.min(Math.floor(pos), segs.length - 1);
  const t = pos - i;
  const p = bez(segs[i], t);
  let d = bezD(segs[i], t);
  if (Math.hypot(d.x, d.y) < 1e-9) d = bezD(segs[i], clamp(t + (t < 0.5 ? 1e-3 : -1e-3), 0, 1));
  return { x: p.x, y: p.y, heading: Math.atan2(d.y, d.x) };
}

/** Amostra a rota em pontos a cada ~2 cm. */
export function samplePath(path) {
  const segs = segments(path);
  const pts = [];
  let s = 0;
  segs.forEach((seg, i) => {
    const approx = dist(seg[0], seg[1]) + dist(seg[1], seg[2]) + dist(seg[2], seg[3]);
    const n = clamp(Math.ceil(approx / 0.02), 8, 800);
    const last = i === segs.length - 1;
    for (let k = 0; k <= (last ? n : n - 1); k++) {
      const t = k / n;
      const p = bez(seg, t);
      const d1 = bezD(seg, t), d2 = bezD2(seg, t);
      const sp = Math.hypot(d1.x, d1.y);
      const curv = sp < 1e-6 ? 0 : (d1.x * d2.y - d1.y * d2.x) / (sp * sp * sp);
      if (pts.length) s += dist(pts[pts.length - 1], p);
      pts.push({ x: p.x, y: p.y, pos: i + t, s, heading: sp < 1e-9 ? (pts.length ? pts[pts.length - 1].heading : 0) : Math.atan2(d1.y, d1.x), curv });
    }
  });
  return pts;
}

function constraintsAt(path, pos) {
  let c = path.globalConstraints;
  for (const z of path.constraintZones) {
    if (pos >= z.minWaypointRelativePos && pos <= z.maxWaypointRelativePos) c = z.constraints;
  }
  return c;
}

function rotationTargets(path) {
  const n = path.waypoints.length - 1;
  const list = [{ pos: 0, rot: rad(path.idealStartingState.rotation) }];
  for (const r of [...path.rotationTargets].sort((a, b) => a.waypointRelativePos - b.waypointRelativePos)) {
    list.push({ pos: clamp(r.waypointRelativePos, 0, n), rot: rad(r.rotationDegrees) });
  }
  list.push({ pos: n, rot: rad(path.goalEndState.rotation) });
  return list;
}

export function rotationAtPos(targets, pos) {
  for (let i = 0; i < targets.length - 1; i++) {
    const a = targets[i], b = targets[i + 1];
    if (pos >= a.pos && pos <= b.pos) {
      const f = b.pos - a.pos < 1e-9 ? 1 : (pos - a.pos) / (b.pos - a.pos);
      return a.rot + wrapAngle(b.rot - a.rot) * f;
    }
  }
  return targets[targets.length - 1].rot;
}

/**
 * Gera a trajetória completa.
 * opts.holonomic: swerve/mecanum (a rotação segue os alvos) ou tração diferencial (segue a curva).
 */
export function generateTrajectory(path, opts = {}) {
  const holonomic = opts.holonomic ?? true;
  const pts = samplePath(path);
  if (pts.length < 2) return { pts, duration: 0, length: 0, maxV: 0, maxOmega: 0 };
  const n = pts.length;
  const big = 1e6;
  const vcap = new Float64Array(n), acc = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = constraintsAt(path, pts[i].pos);
    const vmax = c.unlimited ? big : Math.max(0.05, c.maxVelocity);
    const amax = c.unlimited ? big : Math.max(0.05, c.maxAcceleration);
    // a aceleração lateral nas curvas também respeita a aceleração máxima
    const k = Math.abs(pts[i].curv);
    vcap[i] = k > 1e-4 ? Math.min(vmax, Math.sqrt(amax / k)) : vmax;
    acc[i] = amax;
  }
  v[0] = Math.min(vcap[0], Math.max(0, path.idealStartingState.velocity));
  for (let i = 1; i < n; i++) {
    const ds = pts[i].s - pts[i - 1].s;
    v[i] = Math.min(vcap[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * acc[i - 1] * ds));
  }
  v[n - 1] = Math.min(v[n - 1], Math.max(0, path.goalEndState.velocity));
  for (let i = n - 2; i >= 0; i--) {
    const ds = pts[i + 1].s - pts[i].s;
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * acc[i] * ds));
  }
  const targets = rotationTargets(path);
  let t = 0, maxV = 0, maxOmega = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (i > 0) {
      const ds = p.s - pts[i - 1].s;
      const avg = (v[i] + v[i - 1]) / 2;
      t += avg > 1e-4 ? ds / avg : Math.sqrt((2 * ds) / acc[i]);
    }
    p.t = t;
    p.v = v[i];
    maxV = Math.max(maxV, v[i]);
    if (holonomic) p.rot = rotationAtPos(targets, p.pos);
    else p.rot = p.heading + (path.reversed ? Math.PI : 0);
    if (i > 0) {
      const dt = p.t - pts[i - 1].t;
      if (dt > 1e-6) maxOmega = Math.max(maxOmega, Math.abs(wrapAngle(p.rot - pts[i - 1].rot)) / dt);
    }
  }
  return { pts, duration: t, length: pts[n - 1].s, maxV, maxOmega, holonomic };
}

/** Estado interpolado da trajetória no tempo t. */
export function sampleTraj(traj, t) {
  const pts = traj.pts;
  if (!pts.length) return null;
  if (t <= 0) return { ...pts[0] };
  if (t >= traj.duration) return { ...pts[pts.length - 1] };
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const f = b.t - a.t < 1e-9 ? 0 : (t - a.t) / (b.t - a.t);
  return {
    x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, v: a.v + (b.v - a.v) * f,
    rot: a.rot + wrapAngle(b.rot - a.rot) * f, pos: a.pos + (b.pos - a.pos) * f, t,
  };
}

/** Posição relativa mais próxima de um ponto do campo (para clicar na rota). */
export function nearestPos(traj, x, y) {
  let best = null, bd = Infinity;
  for (const p of traj.pts) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { pos: best.pos, dist: Math.sqrt(bd), point: best } : null;
}

// ---- edição de waypoints ---------------------------------------------------
export function waypointHeading(w) {
  if (w.nextControl) return Math.atan2(w.nextControl.y - w.anchor.y, w.nextControl.x - w.anchor.x);
  if (w.prevControl) return Math.atan2(w.anchor.y - w.prevControl.y, w.anchor.x - w.prevControl.x);
  return 0;
}

export function controlLength(w, which) {
  const c = w[which];
  return c ? dist(c, w.anchor) : 0;
}

export function setWaypointHeading(w, angle) {
  const ln = controlLength(w, 'nextControl'), lp = controlLength(w, 'prevControl');
  if (w.nextControl) w.nextControl = { x: w.anchor.x + Math.cos(angle) * ln, y: w.anchor.y + Math.sin(angle) * ln };
  if (w.prevControl) w.prevControl = { x: w.anchor.x - Math.cos(angle) * lp, y: w.anchor.y - Math.sin(angle) * lp };
}

export function setControlLength(w, which, len) {
  len = Math.max(0.05, len);
  const a = waypointHeading(w);
  const sgn = which === 'nextControl' ? 1 : -1;
  w[which] = { x: w.anchor.x + sgn * Math.cos(a) * len, y: w.anchor.y + sgn * Math.sin(a) * len };
}

export function moveAnchor(w, x, y) {
  const dx = x - w.anchor.x, dy = y - w.anchor.y;
  w.anchor = { x, y };
  if (w.prevControl) w.prevControl = { x: w.prevControl.x + dx, y: w.prevControl.y + dy };
  if (w.nextControl) w.nextControl = { x: w.nextControl.x + dx, y: w.nextControl.y + dy };
}

/** Move um controle; o controle oposto acompanha a direção (curva suave), mantendo o comprimento. */
export function moveControl(w, which, x, y) {
  w[which] = { x, y };
  const other = which === 'nextControl' ? 'prevControl' : 'nextControl';
  if (w[other]) {
    const len = dist(w[other], w.anchor);
    const a = Math.atan2(w.anchor.y - y, w.anchor.x - x);
    w[other] = { x: w.anchor.x + Math.cos(a) * len, y: w.anchor.y + Math.sin(a) * len };
  }
}

/** Ajusta todas as posições relativas (alvos, eventos, zonas) quando waypoints mudam. */
function remapPositions(path, fn) {
  const n = path.waypoints.length - 1;
  const m = (v) => (v == null ? v : clamp(fn(v), 0, n));
  for (const r of path.rotationTargets) r.waypointRelativePos = m(r.waypointRelativePos);
  for (const e of path.eventMarkers) {
    e.waypointRelativePos = m(e.waypointRelativePos);
    if (e.endWaypointRelativePos != null) e.endWaypointRelativePos = m(e.endWaypointRelativePos);
  }
  for (const z of [...path.constraintZones, ...path.pointTowardsZones]) {
    z.minWaypointRelativePos = m(z.minWaypointRelativePos);
    z.maxWaypointRelativePos = m(z.maxWaypointRelativePos);
  }
}

export function addWaypointEnd(path, x, y) {
  const w = path.waypoints;
  const last = w[w.length - 1];
  const d = Math.hypot(x - last.anchor.x, y - last.anchor.y);
  const len = clamp(d / 3, 0.25, 1.5);
  const dirNew = Math.atan2(y - last.anchor.y, x - last.anchor.x);
  const hLast = last.prevControl ? waypointHeading(last) : dirNew;
  last.nextControl = { x: last.anchor.x + Math.cos(hLast) * len, y: last.anchor.y + Math.sin(hLast) * len };
  w.push({
    anchor: { x, y }, prevControl: { x: x - Math.cos(dirNew) * len, y: y - Math.sin(dirNew) * len },
    nextControl: null, isLocked: false, linkedName: null,
  });
}

/** Divide o segmento i em t (de Casteljau) — a curva continua exatamente igual. */
export function insertWaypoint(path, i, t = 0.5) {
  const w = path.waypoints;
  const seg = segments(path)[i];
  if (!seg) return;
  const mid = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const p01 = mid(seg[0], seg[1]), p12 = mid(seg[1], seg[2]), p23 = mid(seg[2], seg[3]);
  const p012 = mid(p01, p12), p123 = mid(p12, p23), p = mid(p012, p123);
  w[i].nextControl = p01;
  w[i + 1].prevControl = p23;
  w.splice(i + 1, 0, { anchor: p, prevControl: p012, nextControl: p123, isLocked: false, linkedName: null });
  remapPositions(path, (v) => {
    if (v <= i) return v;
    if (v >= i + 1) return v + 1;
    const f = v - i;
    return f <= t ? i + f / t : i + 1 + (f - t) / (1 - t);
  });
}

export function deleteWaypoint(path, i) {
  const w = path.waypoints;
  if (w.length <= 2) return false;
  w.splice(i, 1);
  if (i === 0) w[0].prevControl = null;
  if (i >= w.length) w[w.length - 1].nextControl = null;
  if (i > 0 && i < w.length) {
    // garante controles nos vizinhos
    if (!w[i - 1].nextControl) setControlLength(w[i - 1], 'nextControl', 0.5);
    if (!w[i].prevControl) setControlLength(w[i], 'prevControl', 0.5);
  }
  remapPositions(path, (v) => {
    if (i === 0) return v - 1;
    if (v <= i - 1) return v;
    if (v >= i + 1) return v - 1;
    return i - 1 + (v - (i - 1)) / 2;
  });
  return true;
}

/** Espelha a rota para a outra aliança. */
export function flipPath(path, L, W, symmetry = 'rotacional') {
  const p = deepCopy(path);
  const fp = (pt) => (pt ? (symmetry === 'espelhada' ? { x: L - pt.x, y: pt.y } : { x: L - pt.x, y: W - pt.y }) : pt);
  const fr = (d) => {
    const r = symmetry === 'espelhada' ? 180 - d : d + 180;
    return ((((r + 180) % 360) + 360) % 360) - 180;
  };
  for (const w of p.waypoints) {
    w.anchor = fp(w.anchor); w.prevControl = fp(w.prevControl); w.nextControl = fp(w.nextControl);
  }
  for (const r of p.rotationTargets) r.rotationDegrees = fr(r.rotationDegrees);
  p.idealStartingState.rotation = fr(p.idealStartingState.rotation);
  p.goalEndState.rotation = fr(p.goalEndState.rotation);
  for (const z of p.pointTowardsZones || []) if (z.fieldPosition) z.fieldPosition = fp(z.fieldPosition);
  return p;
}

// ---- autônomos -----------------------------------------------------------------
/**
 * Monta a linha do tempo de um .auto.
 * getTraj(nome) -> trajetória gerada (ou null); durations: tempo estimado dos comandos nomeados.
 */
export function buildAutoTimeline(auto, getTraj, durations = {}) {
  const items = [];
  const walk = (cmd, t0, depth) => {
    if (!cmd) return t0;
    const d = cmd.data || {};
    switch (cmd.type) {
      case 'path': {
        const traj = getTraj(d.pathName);
        const dur = traj ? traj.duration : 0;
        items.push({ kind: 'path', name: d.pathName, start: t0, end: t0 + dur, traj, depth, missing: !traj });
        return t0 + dur;
      }
      case 'wait': {
        const dur = Math.max(0, +d.waitTime || 0);
        items.push({ kind: 'wait', name: `Esperar ${dur}s`, start: t0, end: t0 + dur, depth });
        return t0 + dur;
      }
      case 'named': {
        const dur = Math.max(0, +(durations[d.name] ?? 0));
        items.push({ kind: 'named', name: d.name || '?', start: t0, end: t0 + dur, depth });
        return t0 + dur;
      }
      case 'sequential': {
        let t = t0;
        for (const c of d.commands || []) t = walk(c, t, depth + 1);
        return t;
      }
      case 'parallel':
      case 'race':
      case 'deadline': {
        const ends = (d.commands || []).map((c) => walk(c, t0, depth + 1));
        if (!ends.length) return t0;
        if (cmd.type === 'parallel') return Math.max(...ends);
        if (cmd.type === 'race') return Math.min(...ends);
        return ends[0];
      }
      default:
        return t0;
    }
  };
  const duration = walk(auto.command, 0, 0);
  const paths = items.filter((i) => i.kind === 'path' && i.traj).sort((a, b) => a.start - b.start);
  return { items, duration, paths };
}

/** Pose do robô no autônomo no tempo t. */
export function autoPoseAt(timeline, t) {
  const ps = timeline.paths;
  if (!ps.length) return null;
  let current = null;
  for (const p of ps) {
    if (t >= p.start) current = p;
  }
  if (!current) return sampleTraj(ps[0].traj, 0);
  return sampleTraj(current.traj, t - current.start);
}

export function pathNamesIn(cmd, out = []) {
  if (!cmd) return out;
  if (cmd.type === 'path') out.push(cmd.data?.pathName);
  for (const c of cmd.data?.commands || []) pathNamesIn(c, out);
  return out;
}
