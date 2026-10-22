// Configurações do Copiloto (salvas em dados/config.json pelo servidor Python).

import { api, debounce, toast } from './util.js';

const listeners = new Set();
const fieldCache = new Map();

export const cfg = {
  data: null,
  ntcore: false,
  versao: '',
  pathplanner: {},
  campos: [],
  field: { length: 16.541, width: 8.069, tags: [], elementos: [], image: null, imageEl: null },

  async load() {
    const r = await api.get('/api/config');
    this.data = r.config;
    this.ntcore = r.ntcore;
    this.versao = r.versao;
    this.pathplanner = r.pathplanner;
    this.campos = r.campos;
    await this.loadField();
    applyTheme();
    emit();
  },

  get(path, fallback) {
    let o = this.data;
    for (const k of path.split('.')) {
      if (o == null) return fallback;
      o = o[k];
    }
    return o === undefined ? fallback : o;
  },

  set(path, value, { save = true } = {}) {
    const keys = path.split('.');
    let o = this.data;
    for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[keys[keys.length - 1]] = value;
    if (path.startsWith('campo')) this.loadField().then(emit);
    if (path.startsWith('aparencia')) applyTheme();
    emit(path);
    if (save) saveSoon();
  },

  async saveNow() {
    saveSoon.flush();
    const r = await api.post('/api/config', { config: this.data });
    this.data = r.config;
    this.pathplanner = r.pathplanner;
    emit('pathplanner');
  },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async loadField() {
    const c = this.data.campo || {};
    let tags = [], elementos = [];
    let length = c.comprimento || 16.541, width = c.largura || 8.069;
    if (c.preset && c.preset !== 'personalizado') {
      let data = fieldCache.get(c.preset);
      if (!data) {
        try {
          data = await api.get(`/dados/campos/${encodeURIComponent(c.preset)}.json`);
          fieldCache.set(c.preset, data);
        } catch (e) { data = null; }
      }
      if (data) {
        length = data.field.length;
        width = data.field.width;
        tags = data.tags.map(parseTag);
        elementos = data.elementos || [];
      }
    } else if (c.tagsPersonalizadas) {
      tags = c.tagsPersonalizadas.map(parseTag);
    }
    let imageEl = this.field.imageEl;
    if (c.imagem && (!imageEl || imageEl.dataset.src !== c.imagem)) {
      imageEl = new Image();
      imageEl.dataset.src = c.imagem;
      imageEl.src = c.imagem;
      imageEl.onload = () => emit('campo.imagem');
    } else if (!c.imagem) imageEl = null;
    this.field = { length, width, tags, elementos, image: c.imagem, imageEl, symmetry: c.simetria || 'rotacional' };
  },
};

function parseTag(t) {
  const p = t.pose.translation, q = t.pose.rotation.quaternion;
  const yaw = Math.atan2(2 * (q.W * q.Z + q.X * q.Y), 1 - 2 * (q.Y * q.Y + q.Z * q.Z));
  return { id: t.ID, x: p.x, y: p.y, z: p.z, yaw };
}

const saveSoon = debounce(async () => {
  try {
    const r = await api.post('/api/config', { config: cfg.data });
    cfg.pathplanner = r.pathplanner;
    emit('pathplanner');
  } catch (e) {
    toast('Erro ao salvar configurações: ' + e.message, 'bad');
  }
}, 500);

function emit(path) {
  for (const fn of listeners) {
    try { fn(path); } catch (e) { console.error(e); }
  }
}

function applyTheme() {
  const a = cfg.data.aparencia || {};
  const root = document.documentElement;
  root.dataset.theme = a.tema === 'claro' ? 'claro' : 'escuro';
  const color = a.cor || '#f5a524';
  root.style.setProperty('--accent', color);
  root.style.setProperty('--accent-ink', inkFor(color));
  document.title = `Copiloto ${cfg.data.equipe || ''}`.trim();
  const logo = document.querySelector('.brand .logo');
  if (logo) logo.textContent = String(cfg.data.equipe || '9604');
}

function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#111';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#14100a' : '#ffffff';
}
