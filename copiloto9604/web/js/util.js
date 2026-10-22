// Utilidades de interface: criação de elementos, ícones, modais, avisos e API.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---- ícones (traço simples, 24x24) -------------------------------------
const ICONS = {
  partida: 'M3 5h18v14H3z M3 10h18 M8 5v14',
  autonomo: 'M4 19c4 0 4-14 8-14s4 14 8 14 M4 19h.01 M20 19h.01',
  odometria: 'M12 3a9 9 0 1 0 9 9 M12 12l6-6 M16 3h5v5',
  limelight: 'M4 7h3l2-3h6l2 3h3v12H4z M12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z',
  topicos: 'M4 6h16 M4 12h16 M4 18h10',
  gravacoes: 'M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16z M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  config: 'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7z M13 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  record: 'M12 6a6 6 0 1 0 0 12a6 6 0 0 0 0-12z',
  save: 'M5 4h11l4 4v12H4V4z M8 4v5h8V4 M8 20v-6h8v6',
  folder: 'M3 6h6l2 2h10v11H3z',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 7.5-2',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  x: 'M6 6l12 12 M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  mirror: 'M12 3v18 M8 7l-5 5 5 5z M16 7l5 5-5 5z',
  target: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z',
  pointer: 'M5 3l14 8-6 2-2 6z',
  rotate: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
  zone: 'M4 4h16v16H4z M4 12h16',
  undo: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  upload: 'M12 20V9 M7 14l5-5 5 5 M5 4h14',
  dots: 'M5 12h.01 M12 12h.01 M19 12h.01',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  warn: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  error: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M9 9l6 6 M15 9l-6 6',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 11v6 M12 7.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  send: 'M4 12l16-8-6 16-2-7z',
  number: 'M5 9h14 M5 15h14 M10 4L8 20 M16 4l-2 16',
  bool: 'M4 7h16v10H4z M14 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 0 0-5 0z',
  text: 'M5 6h14 M12 6v13',
  graph: 'M4 4v16h16 M7 15l4-5 3 3 5-7',
  gauge: 'M4 16a8 8 0 1 1 16 0 M12 16l4-5',
  bar: 'M4 10h16v5H4z M4 10h9v5H4z',
  button: 'M4 8h16v8H4z M9 12h6',
  slider: 'M4 12h16 M9 9v6',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  field: 'M3 5h18v14H3z M12 5v14 M12 9.5a2.5 2.5 0 1 0 0 5',
  camera: 'M3 7h4l2-2h6l2 2h4v12H3z M12 10a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  timer: 'M12 7v6l3 2 M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M10 1h4',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z M10 21h4',
  swerve: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  crosshair: 'M12 2v6 M12 16v6 M2 12h6 M16 12h6 M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  fms: 'M4 20V9l8-5 8 5v11 M9 20v-6h6v6',
  events: 'M4 6h3 M4 12h3 M4 18h3 M10 6h10 M10 12h10 M10 18h10',
  heading: 'M5 12h14',
  checklist: 'M4 6l2 2 3-3 M11 7h9 M4 12l2 2 3-3 M11 13h9 M4 18l2 2 3-3 M11 19h9',
  robot: 'M5 8h14v11H5z M9 12h.01 M15 12h.01 M12 4v4 M9 16h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M20 20l-4-4',
  hot: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 2 1 3 3 3 3s1-3 0-7z',
  wifi: 'M2 9a15 15 0 0 1 20 0 M5 12.5a10 10 0 0 1 14 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.dots);
  svg.append(path);
  return svg;
}

export function btn(label, onClick, opts = {}) {
  const b = h('button', {
    class: 'btn ' + (opts.cls || ''), title: opts.title || null, type: 'button',
    onclick: onClick, disabled: opts.disabled,
  });
  if (opts.icon) b.append(icon(opts.icon));
  if (label) b.append(h('span', {}, label));
  if (!label && opts.icon) b.classList.add('icon');
  return b;
}

// ---- números --------------------------------------------------------------
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export function fmt(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  if (typeof v !== 'number') return String(v);
  return v.toFixed(digits);
}

export function fmtTime(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—:——';
  const s = Math.ceil(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtValue(v) {
  if (v == null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (typeof v === 'boolean') return v ? 'verdadeiro' : 'falso';
  if (Array.isArray(v)) return '[' + v.map((x) => (typeof x === 'object' && x ? fmtObj(x) : fmtValue(x))).join(', ') + ']';
  if (typeof v === 'object') return fmtObj(v);
  return String(v);
}

function fmtObj(o) {
  return '{' + Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? '[…]' : fmtValue(v)}`).join(', ') + '}';
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export const deepCopy = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  // flush() roda agora o que estava pendente e devolve o resultado (ex.: a Promise do salvamento)
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; return fn(...args); } return undefined; };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.pending = () => t != null;
  return d;
}

// ---- API do servidor --------------------------------------------------------
async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(url, opts); } catch (e) { throw new Error('Sem resposta do Copiloto (o programa Python está aberto?)'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* sem corpo */ }
  if (!res.ok) throw new Error((data && data.erro) || `Erro ${res.status}`);
  return data;
}
export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
};

// ---- avisos rápidos (toasts) ------------------------------------------------
export function toast(msg, kind = '', ms = 3200) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: 'toast ' + kind }, msg);
  box.append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, ms);
}

// ---- modais -------------------------------------------------------------------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const footer = actions.length ? h('footer', {}, actions.map((a) => btn(a.label, () => a.onClick ? a.onClick(close) : close(), { cls: a.cls || '', icon: a.icon }))) : null;
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('header', {}, h('h3', {}, title), btn('', close, { cls: 'ghost sm', icon: 'x', title: 'Fechar (Esc)' })),
    h('div', { class: 'body' }, body),
    footer);
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  setTimeout(() => { const f = box.querySelector('input:not([type=checkbox]), select, textarea'); f && f.focus(); }, 30);
  return { close, box };
}

export function confirmDialog(message, { ok = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: 'Confirmar', body: h('p', { style: { margin: 0 } }, message),
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Cancelar' },
        { label: ok, cls: danger ? 'danger' : 'primary', onClick: (close) => { done = true; resolve(true); close(); } },
      ],
    });
    return m;
  });
}

export function promptDialog(title, label, value = '', hint = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'input', value });
    const submit = (close) => { done = true; resolve(input.value.trim()); close(); };
    const m = modal({
      title, body: h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null),
      onClose: () => { if (!done) resolve(null); },
      actions: [{ label: 'Cancelar' }, { label: 'OK', cls: 'primary', onClick: submit }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
    setTimeout(() => input.select(), 40);
  });
}

// ---- menu de contexto ---------------------------------------------------------
export function popupMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('hr')); continue; }
    const b = h('button', { class: it.danger ? 'danger' : '', onclick: () => { menu.remove(); it.onClick(); } });
    if (it.icon) b.append(icon(it.icon));
    b.append(h('span', {}, it.label));
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(window.innerWidth - mw - 8, r.left) + 'px';
  menu.style.top = Math.min(window.innerHeight - mh - 8, r.bottom + 4) + 'px';
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  return menu;
}

// ---- campos de formulário -------------------------------------------------
export function field(label, input, hint) {
  return h('div', { class: 'field' }, label ? h('label', {}, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function numInput(value, onChange, opts = {}) {
  const inp = h('input', {
    class: 'input ' + (opts.sm ? 'sm' : ''), type: 'number', step: opts.step ?? 'any',
    min: opts.min, max: opts.max, value: value ?? '',
  });
  const commit = () => {
    if (inp.value === '') { if (opts.allowEmpty) onChange(null); return; }
    let v = parseFloat(inp.value);
    if (!Number.isFinite(v)) return;
    if (opts.min != null) v = Math.max(opts.min, v);
    if (opts.max != null) v = Math.min(opts.max, v);
    onChange(v);
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } e.stopPropagation(); });
  if (!opts.unit) return inp;
  return h('div', { class: 'unit-input' }, inp, h('span', {}, opts.unit));
}

export function textInput(value, onChange, opts = {}) {
  const inp = h('input', { class: 'input ' + (opts.sm ? 'sm' : ''), value: value ?? '', placeholder: opts.placeholder || '', list: opts.list || null });
  inp.addEventListener(opts.live ? 'input' : 'change', () => onChange(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
  return inp;
}

export function selectInput(value, options, onChange, opts = {}) {
  const sel = h('select', { class: 'input ' + (opts.sm ? 'sm' : '') },
    options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, label);
    }));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function checkInput(label, value, onChange) {
  const c = h('input', { type: 'checkbox', checked: !!value });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'check' }, c, h('span', {}, label));
}

export function copyText(text) {
  const done = () => toast('Copiado!', 'ok', 1400);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Não consegui copiar', 'bad'); }
  ta.remove();
}

export function codeBlock(text) {
  return h('div', { class: 'code' }, text, btn('', () => copyText(text), { cls: 'sm copy', icon: 'copy', title: 'Copiar' }));
}

export function downloadFile(name, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => { resolve(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

// Canvas com nitidez em telas de alta densidade; chama draw quando o tamanho muda.
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const hh = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
