// Desenho do campo em canvas, com zoom, arraste e conversão metros <-> pixels.
// Sistema de coordenadas do WPILib/PathPlanner: origem no canto da aliança azul,
// x ao longo do comprimento, y para cima, ângulos anti-horários.

import { cfg } from './config.js';
import { clamp, cssVar, fitCanvas, rad } from './util.js';

export class FieldView {
  constructor(container, opts = {}) {
    this.opts = Object.assign({ interactive: true, tags: true, grid: true, padding: 18, labels: true, zoom: true }, opts);
    this.container = container;
    this.canvas = document.createElement('canvas');
    container.append(this.canvas);
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.flipped = false;
    this.highlightTags = new Set();
    this.layers = [];
    this.scale = 50;
    this._dirty = true;
    this._ro = new ResizeObserver(() => this.redraw());
    this._ro.observe(container);
    if (this.opts.interactive) this._bindPointer();
    this._unsub = cfg.onChange(() => this.redraw());
  }

  destroy() {
    this._ro.disconnect();
    this._unsub();
    this.canvas.remove();
  }

  get field() { return cfg.field; }

  redraw() { this._dirty = true; }

  /** Desenha se algo mudou (chamar no requestAnimationFrame da página). */
  frame(force = false) {
    if (!this._dirty && !force) return;
    this._dirty = false;
    this.draw();
  }

  resetView() { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.redraw(); }

  _layout(w, h) {
    const { length: L, width: W } = this.field;
    const p = this.opts.padding;
    const base = Math.min((w - 2 * p) / L, (h - 2 * p) / W);
    this.scale = Math.max(1, base * this.zoom);
    this.ox = (w - L * this.scale) / 2 + this.pan.x;
    this.oy = (h + W * this.scale) / 2 + this.pan.y;
    this.w = w; this.h = h;
  }

  toPx(x, y) {
    if (this.flipped) { x = this.field.length - x; y = this.field.width - y; }
    return [this.ox + x * this.scale, this.oy - y * this.scale];
  }

  toField(px, py) {
    let x = (px - this.ox) / this.scale, y = (this.oy - py) / this.scale;
    if (this.flipped) { x = this.field.length - x; y = this.field.width - y; }
    return [x, y];
  }

  /** Ângulo de campo -> ângulo de tela (canvas tem y para baixo). */
  screenAngle(a) { return -(this.flipped ? a + Math.PI : a); }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    this.ctx = ctx;
    this._layout(w, h);
    ctx.clearRect(0, 0, w, h);
    this.drawField(ctx);
    for (const layer of this.layers) {
      ctx.save();
      try { layer(ctx, this); } catch (e) { console.error(e); }
      ctx.restore();
    }
  }

  drawField(ctx) {
    const f = this.field;
    const [x0, y0] = this.toPx(0, f.width);
    const [x1, y1] = this.toPx(f.length, 0);
    const left = Math.min(x0, x1), top = Math.min(y0, y1);
    const fw = Math.abs(x1 - x0), fh = Math.abs(y1 - y0);
    const s = this.scale;
    ctx.save();
    ctx.fillStyle = cssVar('--carpet');
    roundRect(ctx, left, top, fw, fh, Math.min(10, s * 0.25));
    ctx.fill();
    ctx.clip();

    if (f.imageEl && f.imageEl.complete && f.imageEl.naturalWidth) {
      ctx.globalAlpha = 0.9;
      if (this.flipped) {
        ctx.save();
        ctx.translate(left + fw, top + fh);
        ctx.rotate(Math.PI);
        ctx.drawImage(f.imageEl, 0, 0, fw, fh);
        ctx.restore();
      } else ctx.drawImage(f.imageEl, left, top, fw, fh);
      ctx.globalAlpha = 1;
    } else {
      // zonas das alianças (só para orientação)
      const zone = Math.min(f.length * 0.24, 4.0);
      const [bx] = this.toPx(zone, 0);
      const [rx] = this.toPx(f.length - zone, 0);
      const [bwall] = this.toPx(0, 0);
      const [rwall] = this.toPx(f.length, 0);
      const gb = ctx.createLinearGradient(bwall, 0, bx, 0);
      gb.addColorStop(0, 'rgba(59,130,246,.20)'); gb.addColorStop(1, 'rgba(59,130,246,0)');
      ctx.fillStyle = gb; ctx.fillRect(Math.min(bwall, bx), top, Math.abs(bx - bwall), fh);
      const gr = ctx.createLinearGradient(rwall, 0, rx, 0);
      gr.addColorStop(0, 'rgba(239,68,68,.20)'); gr.addColorStop(1, 'rgba(239,68,68,0)');
      ctx.fillStyle = gr; ctx.fillRect(Math.min(rwall, rx), top, Math.abs(rx - rwall), fh);
    }

    if (this.opts.grid) {
      ctx.strokeStyle = cssVar('--carpet-line');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < f.length; x++) { const [px] = this.toPx(x, 0); ctx.moveTo(px, top); ctx.lineTo(px, top + fh); }
      for (let y = 1; y < f.width; y++) { const [, py] = this.toPx(0, y); ctx.moveTo(left, py); ctx.lineTo(left + fw, py); }
      ctx.stroke();
    }
    // linha central
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1.5;
    const [cx] = this.toPx(f.length / 2, 0);
    ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + fh); ctx.stroke();
    ctx.setLineDash([]);

    for (const el of f.elementos || []) {
      if (el.tipo !== 'retangulo') continue;
      const [ax, ay] = this.toPx(el.x, el.y + el.h);
      const [bx2, by2] = this.toPx(el.x + el.w, el.y);
      const color = el.alianca === 'vermelho' ? '239,68,68' : el.alianca === 'azul' ? '59,130,246' : '160,170,180';
      ctx.fillStyle = `rgba(${color},.14)`;
      ctx.strokeStyle = `rgba(${color},.7)`;
      ctx.lineWidth = 1.5;
      const rx2 = Math.min(ax, bx2), ry2 = Math.min(ay, by2);
      ctx.fillRect(rx2, ry2, Math.abs(bx2 - ax), Math.abs(by2 - ay));
      ctx.strokeRect(rx2, ry2, Math.abs(bx2 - ax), Math.abs(by2 - ay));
      if (this.opts.labels && s > 25) {
        ctx.fillStyle = `rgba(${color},.9)`;
        ctx.font = `700 ${Math.max(9, s * 0.2)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(el.nome, rx2 + Math.abs(bx2 - ax) / 2, ry2 + Math.abs(by2 - ay) / 2);
      }
    }
    ctx.restore();

    // borda
    ctx.strokeStyle = cssVar('--line-2');
    ctx.lineWidth = 2;
    roundRect(ctx, left, top, fw, fh, Math.min(10, s * 0.25));
    ctx.stroke();

    if (this.opts.tags) this.drawTags(ctx);

    if (this.opts.labels && s > 22) {
      ctx.fillStyle = cssVar('--faint');
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let x = 0; x <= f.length; x += 2) { const [px, py] = this.toPx(x, this.flipped ? f.width : 0); ctx.fillText(`${x}`, px, py + 4); }
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let y = 0; y <= f.width; y += 2) { const [px, py] = this.toPx(this.flipped ? f.length : 0, y); ctx.fillText(`${y}`, px - 5, py); }
    }
  }

  drawTags(ctx) {
    const s = this.scale;
    const len = Math.max(5, 0.33 * s);
    for (const t of this.field.tags) {
      const [px, py] = this.toPx(t.x, t.y);
      const a = this.screenAngle(t.yaw);
      const hl = this.highlightTags.has(t.id);
      // a tag é uma linha perpendicular à direção para onde ela "olha"
      const nx = Math.cos(a + Math.PI / 2), ny = Math.sin(a + Math.PI / 2);
      ctx.strokeStyle = hl ? '#22c55e' : 'rgba(255,255,255,.75)';
      ctx.lineWidth = hl ? 4 : 2.5;
      ctx.beginPath();
      ctx.moveTo(px - nx * len / 2, py - ny * len / 2);
      ctx.lineTo(px + nx * len / 2, py + ny * len / 2);
      ctx.stroke();
      ctx.strokeStyle = hl ? 'rgba(34,197,94,.8)' : 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * len * 0.45, py + Math.sin(a) * len * 0.45);
      ctx.stroke();
      if (s > 28) {
        ctx.fillStyle = hl ? '#22c55e' : 'rgba(255,255,255,.6)';
        ctx.font = `700 ${Math.max(8, s * 0.14)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(t.id), px + Math.cos(a) * len * 0.95, py + Math.sin(a) * len * 0.95);
      }
    }
  }

  // ---- interação ----------------------------------------------------------
  _bindPointer() {
    const c = this.canvas;
    let drag = null;
    const pt = (e) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const [x, y] = this.toField(px, py);
      return { px, py, x, y, e };
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = pt(e);
      const handled = e.button === 0 && this.opts.onDown && this.opts.onDown(p);
      drag = { start: p, last: p, pan: !handled, moved: false, button: e.button };
    });
    c.addEventListener('pointermove', (e) => {
      const p = pt(e);
      if (!drag) { this.opts.onHover && this.opts.onHover(p); return; }
      if (Math.hypot(p.px - drag.start.px, p.py - drag.start.py) > 3) drag.moved = true;
      if (drag.pan) {
        if (this.opts.zoom) {
          this.pan.x += p.px - drag.last.px;
          this.pan.y += p.py - drag.last.py;
          this.redraw();
        }
      } else this.opts.onMove && this.opts.onMove(p, drag);
      drag.last = p;
    });
    const up = (e) => {
      if (!drag) return;
      const p = pt(e);
      if (!drag.pan && this.opts.onUp) this.opts.onUp(p, drag);
      if (drag.pan && !drag.moved && drag.button === 0 && this.opts.onClick) this.opts.onClick(p);
      drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => this.opts.onDblClick && this.opts.onDblClick(pt(e)));
    c.addEventListener('contextmenu', (e) => { if (this.opts.onContext) { e.preventDefault(); this.opts.onContext(pt(e)); } });
    c.addEventListener('wheel', (e) => {
      if (!this.opts.zoom) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const before = this.toField(px, py);
      this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0015), 0.5, 8);
      this._layout(this.w, this.h);
      const [ax, ay] = this.toPx(before[0], before[1]);
      this.pan.x += px - ax;
      this.pan.y += py - ay;
      this.redraw();
    }, { passive: false });
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Desenha o robô (retângulo com para-choque e seta de frente). */
export function drawRobot(ctx, fv, pose, opts = {}) {
  if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return;
  const robo = cfg.get('robo', {});
  const L = (opts.length ?? robo.comprimento ?? 0.86) * fv.scale;
  const W = (opts.width ?? robo.largura ?? 0.86) * fv.scale;
  const [px, py] = fv.toPx(pose.x, pose.y);
  const a = fv.screenAngle(pose.rot || 0);
  const color = opts.color || cssVar('--accent');
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(a);
  ctx.globalAlpha = opts.alpha ?? 1;
  if (opts.ghost) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-L / 2, -W / 2, L, W);
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = withAlpha(color, opts.fillAlpha ?? 0.28);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, fv.scale * 0.05);
    roundRect(ctx, -L / 2, -W / 2, L, W, Math.min(L, W) * 0.12);
    ctx.fill();
    ctx.stroke();
  }
  // frente
  ctx.fillStyle = color;
  ctx.beginPath();
  const tip = L / 2 - Math.max(2, L * 0.06);
  ctx.moveTo(tip, 0);
  ctx.lineTo(tip - L * 0.28, -W * 0.22);
  ctx.lineTo(tip - L * 0.28, W * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (opts.label && fv.scale > 20) {
    ctx.save();
    ctx.font = '600 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(opts.label, px, py - Math.max(L, W) * 0.62 - 4);
    ctx.restore();
  }
}

export function drawPolyline(ctx, fv, pts, { color, width = 2, dash = null, alpha = 1 } = {}) {
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = fv.toPx(p.x, p.y);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

export function withAlpha(color, a) {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

// ---- leitura de poses vindas da NetworkTables -------------------------------

/** Aceita Field2d [x, y, graus], botpose da Limelight, struct Pose2d/Pose3d e listas. */
export function parsePose(value, topicName = '') {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (/botpose/i.test(topicName)) { const b = parseBotpose(value); return b && b.pose; }
    if (value.length >= 3 && typeof value[0] === 'number') {
      return { x: value[0], y: value[1], rot: rad(value[2]) };
    }
    if (value.length && typeof value[0] === 'object') return parsePose(value[0]);
    return null;
  }
  if (typeof value === 'object' && typeof value.x === 'number') return { x: value.x, y: value.y, rot: value.rot || 0 };
  return null;
}

/** Lista de poses: Field2d com várias poses (3 números cada) ou struct Pose2d[]. */
export function parsePoses(value) {
  if (!Array.isArray(value)) return [];
  if (value.length && typeof value[0] === 'object') return value.map(parsePose).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < value.length; i += 3) out.push({ x: value[i], y: value[i + 1], rot: rad(value[i + 2]) });
  return out;
}

/** botpose da Limelight: [x, y, z, roll, pitch, yaw, latência, nTags, span, distMédia, áreaMédia, ...tags]. */
export function parseBotpose(arr) {
  if (!Array.isArray(arr) || arr.length < 6) return null;
  const tagCount = arr.length > 7 ? arr[7] : (arr[0] || arr[1] ? 1 : 0);
  const out = {
    pose: { x: arr[0], y: arr[1], rot: rad(arr[5]) }, z: arr[2],
    latency: arr[6] ?? null, tagCount, span: arr[8] ?? null, avgDist: arr[9] ?? null, avgArea: arr[10] ?? null,
    fiducials: [],
  };
  for (let i = 11; i + 6 < arr.length; i += 7) {
    out.fiducials.push({ id: arr[i], txnc: arr[i + 1], tync: arr[i + 2], ta: arr[i + 3], distCam: arr[i + 4], distRobot: arr[i + 5], ambiguity: arr[i + 6] });
  }
  if (!tagCount || (arr[0] === 0 && arr[1] === 0)) out.pose = null;
  return out;
}

/** Topicos que parecem poses (para listas de escolha). */
export function poseLikeTopics(nt) {
  return nt.names().filter((n) => {
    const e = nt.entry(n);
    if (!e) return false;
    if (e.type === 'struct:Pose2d' || e.type === 'struct:Pose3d' || e.type === 'struct:Pose2d[]') return true;
    return e.type === 'double[]' && Array.isArray(e.value) && (e.value.length === 3 || (e.value.length >= 3 && /botpose|pose|field/i.test(n)));
  });
}
