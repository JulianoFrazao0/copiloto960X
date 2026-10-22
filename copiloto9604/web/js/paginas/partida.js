// Página "Partida": painel configurável estilo Shuffleboard, com várias abas,
// widgets arrastáveis/redimensionáveis e layout salvo em dados/layouts.json.

import { cfg } from '../config.js';
import { poseLikeTopics } from '../campo.js';
import { events } from '../eventos.js';
import { nt } from '../nt.js';
import {
  api, btn, checkInput, clamp, confirmDialog, debounce, deepCopy, downloadFile, field, h, icon, modal,
  numInput, pickFile, popupMenu, promptDialog, selectInput, textInput, toast, uid,
} from '../util.js';
import { WIDGETS } from '../widgets.js';

const COLS = 24;
const ROWS = 18;

let state = null;        // { versao, paginas: [...] }
let pageIdx = 0;
let editing = false;
let root, tabsEl, area, grid;
let hosts = [];          // widgets montados da aba atual
let metrics = { cw: 50, rh: 40 };

const save = debounce(() => api.post('/api/layouts', { layouts: state }).catch((e) => toast('Erro ao salvar layout: ' + e.message, 'bad')), 400);

function W(tipo, x, y, w, h_, cfg_ = {}, titulo = null) {
  return { id: uid(), tipo, x, y, w, h: h_, titulo, cfg: cfg_ };
}

export function defaultLayout() {
  return {
    versao: 1,
    paginas: [
      {
        id: uid(), nome: 'Teleop', widgets: [
          W('cronometro', 0, 0, 5, 4),
          W('numero', 5, 0, 3, 4, { topico: '/SmartDashboard/Bateria', unidade: 'V', casas: 2, vermelhoAbaixo: 11, amareloAbaixo: 12 }, 'Bateria'),
          W('seletor', 8, 0, 6, 4, { tabela: '/SmartDashboard/Auto' }, 'Autônomo'),
          W('booleano', 14, 0, 3, 4, { topico: '/SmartDashboard/Intake/Tem Peça', textoV: 'TEM PEÇA', textoF: 'VAZIO' }, 'Intake'),
          W('booleano', 17, 0, 3, 4, { topico: '/SmartDashboard/Shooter/Pronto', textoV: 'PRONTO', textoF: 'ACELERANDO', corF: '#7c5a10', piscar: true }, 'Shooter'),
          W('alertas', 20, 0, 4, 9, {}, 'Alertas'),
          W('campo', 0, 4, 10, 8, { rastro: true, visao: true }, 'Campo'),
          W('grafico', 10, 4, 10, 5, { topicos: ['/SmartDashboard/Shooter/RPM', '/SmartDashboard/Shooter/RPM Alvo'], janela: 10 }, 'Shooter (RPM)'),
          W('limelight', 10, 9, 5, 5, { limelight: 'limelight' }, 'Limelight'),
          W('swerve', 15, 9, 5, 5, { topico: '/SmartDashboard/Swerve/Estados', vmax: 4.5 }, 'Swerve'),
          W('eventos', 20, 9, 4, 9, { vigiar: ['/SmartDashboard/Intake/Tem Peça'] }, 'Linha do tempo'),
          W('barra', 0, 12, 5, 2, { topico: '/SmartDashboard/Escalador/Posição', min: 0, max: 1 }, 'Escalador'),
          W('booleano', 5, 12, 5, 2, { topico: '/SmartDashboard/Escalador/Travado', textoV: 'TRAVADO', textoF: 'livre' }, 'Escalada'),
          W('medidor', 0, 14, 5, 4, { topico: '/SmartDashboard/Swerve/Velocidade', min: 0, max: 5, unidade: 'm/s' }, 'Velocidade'),
          W('fms', 5, 14, 5, 4, {}, 'Partida'),
          W('numero', 10, 14, 5, 4, { topico: '/SmartDashboard/Gyro/Yaw', unidade: '°', casas: 1 }, 'Giroscópio'),
          W('botao', 15, 14, 5, 4, { topico: '/SmartDashboard/Zerar Giro', texto: 'Zerar giroscópio', modo: 'pulso' }),
        ],
      },
      {
        id: uid(), nome: 'Pit', widgets: [
          W('rotulo', 0, 0, 12, 1, { texto: 'Antes de ir para a fila', tamanho: 18 }),
          W('checklist', 0, 1, 7, 9, {}, 'Checklist pré-partida'),
          W('numero', 7, 1, 4, 4, { topico: '/SmartDashboard/Bateria', unidade: 'V', casas: 2, vermelhoAbaixo: 12.3, verdeAcima: 12.5 }, 'Bateria'),
          W('seletor', 11, 1, 6, 4, { tabela: '/SmartDashboard/Auto' }, 'Autônomo'),
          W('alertas', 17, 1, 7, 9, {}, 'Alertas'),
          W('fms', 7, 5, 10, 3, {}, 'Partida'),
          W('camera', 7, 8, 10, 8, {}, 'Câmera da Limelight'),
          W('eventos', 17, 10, 7, 6, {}, 'Linha do tempo'),
          W('botao', 0, 10, 7, 2, { topico: '/SmartDashboard/Zerar Giro', texto: 'Zerar giroscópio', modo: 'pulso' }),
          W('deslizante', 0, 12, 7, 2, { topico: '/SmartDashboard/Ajuste Shooter', min: -500, max: 500, passo: 10 }, 'Ajuste fino do shooter (RPM)'),
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
class Host {
  constructor(w) {
    this.w = w;
    const def = WIDGETS[w.tipo] || {};
    this.el = h('div', { class: 'widget' + (def.semTitulo && !w.titulo ? ' notitle' : '') });
    this.title = h('span', { class: 't' }, w.titulo || def.nome || w.tipo);
    this.tools = h('div', { class: 'w-tools' },
      btn('', () => openConfig(this), { cls: 'ghost sm', icon: 'gear', title: 'Configurar' }),
      btn('', () => removeWidget(this), { cls: 'ghost sm', icon: 'x', title: 'Remover' }));
    this.head = h('div', { class: 'w-head' }, this.title, this.tools);
    this.body = h('div', { class: 'w-body' });
    this.missing = h('div', { class: 'missing hidden' });
    this.resizeEl = h('div', { class: 'resize', title: 'Arraste para redimensionar' });
    this.el.append(this.head, this.body, this.resizeEl);
    this.body.append(this.missing);
    this.build();
    this._bindDrag();
  }

  build() {
    if (this.impl && this.impl.destroy) this.impl.destroy();
    this.body.replaceChildren(this.missing);
    const def = WIDGETS[this.w.tipo];
    if (!def) { this.body.append(h('div', { class: 'missing' }, `Tipo desconhecido: ${this.w.tipo}`)); this.impl = { update() {} }; return; }
    try {
      this.impl = def.criar(this.body, this.w, { save });
    } catch (e) {
      console.error(e);
      this.body.append(h('div', { class: 'missing' }, 'Erro no widget: ' + e.message));
      this.impl = { update() {} };
    }
    const semTitulo = def.semTitulo && !this.w.titulo;
    this.el.classList.toggle('notitle', !!semTitulo);
    this.title.textContent = this.w.titulo || def.nome;
  }

  place() {
    const { cw, rh } = metrics, g = 8;
    Object.assign(this.el.style, {
      left: this.w.x * cw + g / 2 + 'px', top: this.w.y * rh + g / 2 + 'px',
      width: this.w.w * cw - g + 'px', height: this.w.h * rh - g + 'px',
    });
  }

  update(now) {
    try { this.impl.update(); } catch (e) { console.error(e); }
    if (now - (this._checked || 0) < 500) return;
    this._checked = now;
    // aviso quando o tópico configurado não existe
    const t = this.w.cfg.topico || this.w.cfg.tabela;
    const def = WIDGETS[this.w.tipo] || {};
    const isTable = def.opcoes && def.opcoes.some((o) => o.tipo === 'tabela');
    const exists = !t || def.escrita || (isTable ? nt.children(t).length > 0 : nt.has(t));
    const show = nt.connected && !exists && (performance.now() - started > 2500);
    if (show !== !this.missing.classList.contains('hidden')) {
      this.missing.classList.toggle('hidden', !show);
      this.missing.textContent = `Tópico não encontrado:\n${t}`;
      this.missing.style.whiteSpace = 'pre-line';
    }
  }

  destroy() {
    if (this.impl && this.impl.destroy) this.impl.destroy();
    this.el.remove();
  }

  _bindDrag() {
    const startDrag = (e, mode) => {
      if (!editing || e.button !== 0) return;
      if (e.target.closest('.w-tools')) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, w: { ...this.w } };
      this.el.classList.add('dragging');
      this.el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / metrics.cw, dy = (ev.clientY - start.y) / metrics.rh;
        if (mode === 'move') {
          this.w.x = clamp(Math.round(start.w.x + dx), 0, COLS - this.w.w);
          this.w.y = Math.max(0, Math.round(start.w.y + dy));
        } else {
          this.w.w = clamp(Math.round(start.w.w + dx), 2, COLS - this.w.x);
          this.w.h = Math.max(1, Math.round(start.w.h + dy));
        }
        this.place();
      };
      const up = () => {
        this.el.classList.remove('dragging');
        this.el.removeEventListener('pointermove', move);
        this.el.removeEventListener('pointerup', up);
        this.el.removeEventListener('pointercancel', up);
        if (JSON.stringify(start.w) !== JSON.stringify(this.w)) { pushDown(this.w); save(); layoutGrid(); }
      };
      this.el.addEventListener('pointermove', move);
      this.el.addEventListener('pointerup', up);
      this.el.addEventListener('pointercancel', up);
    };
    this.resizeEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); startDrag(e, 'resize'); });
    this.el.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
    this.el.addEventListener('dblclick', () => { if (editing) openConfig(this); });
  }
}

let started = performance.now();

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Depois de soltar/redimensionar: empurra para baixo os widgets que ficaram por baixo. */
function pushDown(moved) {
  const ws = page().widgets;
  const queue = [moved];
  let guard = 0;
  while (queue.length && guard++ < 500) {
    const a = queue.shift();
    for (const b of ws) {
      if (b !== a && b !== moved && overlaps(a, b)) {
        b.y = a.y + a.h;
        queue.push(b);
      }
    }
  }
}

function page() { return state.paginas[pageIdx]; }

function layoutGrid() {
  const r = area.getBoundingClientRect();
  const width = r.width - 16;
  const cw = width / COLS;
  const rh = clamp((r.height - 16) / ROWS, 30, 80);
  metrics = { cw, rh };
  const maxRow = Math.max(ROWS, ...page().widgets.map((w) => w.y + w.h)) + (editing ? 4 : 0);
  grid.style.height = maxRow * rh + 'px';
  grid.style.setProperty('--cw', cw + 'px');
  grid.style.setProperty('--rh', rh + 'px');
  hosts.forEach((ho) => ho.place());
}

/** Os tópicos vigiados pelas "Linhas do tempo" valem para todas as abas. */
function syncWatchers() {
  events.clearWatched();
  for (const p of state.paginas) for (const w of p.widgets) if (w.tipo === 'eventos') events.setWatched(w.id, w.cfg.vigiar || []);
}

function renderPage() {
  syncWatchers();
  hosts.forEach((ho) => ho.destroy());
  hosts = page().widgets.map((w) => new Host(w));
  grid.replaceChildren(...hosts.map((ho) => ho.el));
  layoutGrid();
}

function renderTabs() {
  const tabs = state.paginas.map((p, i) => h('button', {
    class: 'ptab' + (i === pageIdx ? ' on' : ''),
    onclick: () => { pageIdx = i; try { localStorage.setItem('copiloto.pagina', String(i)); } catch (e) { /* sem storage */ } renderTabs(); renderPage(); },
    ondblclick: () => editing && renamePage(i),
  }, p.nome));
  const editBtn = btn(editing ? 'Concluir' : 'Editar layout', toggleEdit, { cls: editing ? 'primary sm' : 'sm', icon: editing ? 'check' : 'edit', title: 'Editar layout (E)' });
  const items = [...tabs];
  if (editing) items.push(btn('', addPage, { cls: 'ghost sm', icon: 'plus', title: 'Nova aba' }));
  items.push(h('div', { class: 'spacer' }));
  if (editing) {
    items.push(btn('Adicionar widget', () => openPicker(), { cls: 'sm', icon: 'plus' }));
    const more = btn('', (e) => popupMenu(e.currentTarget, [
      { label: 'Renomear aba', icon: 'edit', onClick: () => renamePage(pageIdx) },
      { label: 'Duplicar aba', icon: 'copy', onClick: duplicatePage },
      { label: 'Exportar layout (.json)', icon: 'download', onClick: () => downloadFile('layout-copiloto.json', JSON.stringify(state, null, 2)) },
      { label: 'Importar layout…', icon: 'upload', onClick: importLayout },
      '-',
      { label: 'Restaurar layout padrão', icon: 'undo', onClick: resetLayout },
      { label: 'Excluir aba', icon: 'trash', danger: true, onClick: deletePage },
    ]), { cls: 'ghost sm', icon: 'dots', title: 'Mais opções' });
    items.push(more);
  }
  items.push(editBtn);
  tabsEl.replaceChildren(...items);
}

function toggleEdit() {
  editing = !editing;
  grid.classList.toggle('editing', editing);
  renderTabs();
  layoutGrid();
}

async function renamePage(i) {
  const name = await promptDialog('Renomear aba', 'Nome', state.paginas[i].nome);
  if (name) { state.paginas[i].nome = name; save(); renderTabs(); }
}

async function addPage() {
  const name = await promptDialog('Nova aba', 'Nome da aba', 'Nova aba');
  if (!name) return;
  state.paginas.push({ id: uid(), nome: name, widgets: [] });
  pageIdx = state.paginas.length - 1;
  save(); renderTabs(); renderPage();
}

function duplicatePage() {
  const copy = deepCopy(page());
  copy.id = uid();
  copy.nome += ' (cópia)';
  copy.widgets.forEach((w) => { w.id = uid(); });
  state.paginas.splice(pageIdx + 1, 0, copy);
  pageIdx++;
  save(); renderTabs(); renderPage();
}

async function deletePage() {
  if (state.paginas.length <= 1) { toast('O painel precisa de pelo menos uma aba', 'warn'); return; }
  if (!(await confirmDialog(`Excluir a aba "${page().nome}" e todos os seus widgets?`, { ok: 'Excluir', danger: true }))) return;
  state.paginas.splice(pageIdx, 1);
  pageIdx = Math.max(0, pageIdx - 1);
  save(); renderTabs(); renderPage();
}

async function resetLayout() {
  if (!(await confirmDialog('Trocar todo o painel pelo layout padrão? (Dica: exporte o atual antes.)', { ok: 'Restaurar', danger: true }))) return;
  state = defaultLayout();
  pageIdx = 0;
  save(); renderTabs(); renderPage();
}

async function importLayout() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.paginas) throw new Error('arquivo não é um layout do Copiloto');
    state = data;
    pageIdx = 0;
    save(); renderTabs(); renderPage();
    toast('Layout importado', 'ok');
  } catch (e) { toast('Não consegui importar: ' + e.message, 'bad'); }
}

function freeSpot(w, hh) {
  const ws = page().widgets;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x <= COLS - w; x++) {
      const hit = ws.some((o) => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + hh > o.y);
      if (!hit) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function defaultsFor(tipo) {
  const out = {};
  for (const o of WIDGETS[tipo].opcoes) {
    if (o.padrao !== undefined) out[o.k] = deepCopy(o.padrao);
    else if (o.padraoCfg) out[o.k] = cfg.get(o.padraoCfg);
  }
  return out;
}

export function addWidget(tipo, cfgOverride = {}, titulo = null, openCfg = true) {
  const def = WIDGETS[tipo];
  const [w, hh] = def.tam;
  const spot = freeSpot(w, hh);
  const widget = { id: uid(), tipo, x: spot.x, y: spot.y, w, h: hh, titulo, cfg: { ...defaultsFor(tipo), ...cfgOverride } };
  page().widgets.push(widget);
  save();
  renderPage();
  const host = hosts.find((ho) => ho.w === widget);
  if (openCfg && host) openConfig(host);
  return widget;
}

/** Usado pela página de tópicos: adiciona um widget à aba escolhida. */
export function addWidgetToPage(pIdx, tipo, cfgOverride, titulo) {
  pageIdx = pIdx;
  renderTabs();
  renderPage();
  return addWidget(tipo, cfgOverride, titulo, false);
}

export function pageNames() { return state ? state.paginas.map((p) => p.nome) : []; }

function openPicker() {
  const grid_ = h('div', { class: 'widget-pick' });
  const m = modal({ title: 'Adicionar widget', body: grid_, wide: true });
  for (const [tipo, def] of Object.entries(WIDGETS)) {
    grid_.append(h('button', { onclick: () => { m.close(); addWidget(tipo); } }, icon(def.icone), h('b', {}, def.nome), h('span', {}, def.desc)));
  }
}

function topicList(filtro) {
  const names = nt.names().filter((n) => !n.includes('/.'));
  if (filtro === 'pose') return poseLikeTopics(nt);
  if (!filtro) return names;
  return names.filter((n) => {
    const t = nt.type(n);
    if (filtro === 'number') return ['double', 'int', 'float'].includes(t);
    if (filtro === 'boolean') return t === 'boolean' || t === 'double' || t === 'int';
    if (filtro === 'string') return t === 'string' || t === 'string[]';
    return true;
  });
}

function tableList() {
  const tables = new Set();
  for (const n of nt.names()) {
    if (n.endsWith('/.type')) tables.add(n.slice(0, -'/.type'.length));
  }
  return [...tables].sort();
}

function openConfig(host) {
  const w = host.w;
  const def = WIDGETS[w.tipo];
  const draft = deepCopy(w.cfg);
  let titulo = w.titulo ?? '';
  const listId = 'dl-' + uid();
  const body = h('div', { class: 'col', style: { gap: '12px' } });
  body.append(field('Título', textInput(titulo, (v) => { titulo = v; }, { placeholder: def.nome, live: true }),
    def.semTitulo ? 'Deixe vazio para esconder a barra de título' : null));
  for (const o of def.opcoes) {
    let input;
    const set = (v) => { draft[o.k] = v; };
    if (o.tipo === 'topico' || o.tipo === 'tabela') {
      const dl = h('datalist', { id: listId + o.k }, (o.tipo === 'tabela' ? tableList() : topicList(o.filtro)).map((n) => h('option', { value: n })));
      const preview = h('div', { class: 'hint mono' });
      const inp = textInput(draft[o.k] ?? (o.padraoCfg ? cfg.get(o.padraoCfg) : ''), (v) => { set(v.trim()); showPrev(); }, { list: listId + o.k, live: true, placeholder: o.padraoCfg ? cfg.get(o.padraoCfg) : '/SmartDashboard/…' });
      const showPrev = () => {
        const t = draft[o.k] || (o.padraoCfg ? cfg.get(o.padraoCfg) : '');
        if (!t) { preview.textContent = ''; return; }
        if (o.tipo === 'tabela') preview.textContent = nt.children(t).length ? `✓ ${nt.children(t).length} valores nesta tabela` : '✗ tabela não encontrada (ainda)';
        else {
          const e = nt.entry(t);
          preview.textContent = e ? `✓ ${e.type} = ${JSON.stringify(e.value).slice(0, 80)}` : '✗ tópico não encontrado (ainda)';
        }
      };
      showPrev();
      input = h('div', { class: 'col', style: { gap: '4px' } }, inp, dl, preview);
    } else if (o.tipo === 'topicos' || o.tipo === 'lista') {
      const dl = o.tipo === 'topicos' ? h('datalist', { id: listId + o.k }, topicList(o.filtro).map((n) => h('option', { value: n }))) : null;
      const ta = h('textarea', { class: 'input', rows: 5 });
      ta.value = (draft[o.k] || []).join('\n');
      ta.addEventListener('input', () => set(ta.value.split('\n').map((s) => s.trim()).filter(Boolean)));
      input = h('div', { class: 'col', style: { gap: '4px' } }, ta, dl);
      if (o.tipo === 'topicos') {
        const sel = h('select', { class: 'input sm' }, h('option', { value: '' }, '+ Adicionar tópico da lista…'), topicList(o.filtro).map((n) => h('option', { value: n }, n)));
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + sel.value;
          ta.dispatchEvent(new Event('input'));
          sel.value = '';
        });
        input.append(sel);
      }
    } else if (o.tipo === 'numero') {
      input = numInput(draft[o.k], set, { allowEmpty: true });
    } else if (o.tipo === 'cor') {
      input = h('input', { type: 'color', class: 'input', value: draft[o.k] || o.padrao || '#f5a524' });
      input.addEventListener('input', () => set(input.value));
    } else if (o.tipo === 'bool') {
      input = checkInput(o.label, draft[o.k] ?? o.padrao, set);
      body.append(input);
      continue;
    } else if (o.tipo === 'select') {
      input = selectInput(draft[o.k] ?? o.padrao, o.op, set);
    } else {
      input = textInput(draft[o.k] ?? '', set, { placeholder: o.ph || '', live: true });
    }
    body.append(field(o.label, input, o.hint));
  }
  modal({
    title: `${def.nome} — configurar`, body,
    actions: [
      { label: 'Remover', cls: 'danger', icon: 'trash', onClick: (close) => { close(); removeWidget(host); } },
      { label: 'Cancelar' },
      {
        label: 'Aplicar', cls: 'primary', onClick: (close) => {
          w.cfg = draft;
          w.titulo = titulo.trim() || null;
          host.build();
          syncWatchers();
          save();
          close();
        },
      },
    ],
  });
}

function removeWidget(host) {
  const ws = page().widgets;
  const i = ws.indexOf(host.w);
  if (i < 0) return;
  ws.splice(i, 1);
  host.destroy();
  hosts = hosts.filter((x) => x !== host);
  save();
  toast('Widget removido', '', 2000);
}

// ---------------------------------------------------------------------------
export default {
  id: 'partida', title: 'Partida', icon: 'partida',

  async mount(el) {
    root = el;
    tabsEl = h('div', { class: 'dash-tabs' });
    grid = h('div', { class: 'dash-grid' });
    area = h('div', { class: 'dash-area' }, grid);
    root.append(h('div', { class: 'content' }, tabsEl, area));
    const r = await api.get('/api/layouts').catch(() => ({ layouts: null }));
    state = r.layouts && r.layouts.paginas ? r.layouts : defaultLayout();
    if (!r.layouts) save();
    try { pageIdx = clamp(parseInt(localStorage.getItem('copiloto.pagina') || '0', 10) || 0, 0, state.paginas.length - 1); } catch (e) { pageIdx = 0; }
    new ResizeObserver(() => layoutGrid()).observe(area);
    renderTabs();
    renderPage();
    started = performance.now();
    document.addEventListener('keydown', (e) => {
      if (!root.classList.contains('active') || e.target.closest('input, textarea, select, .modal')) return;
      if (e.key === 'e' || e.key === 'E') toggleEdit();
    });
  },

  frame(now) {
    const stale = !nt.connected;
    for (const ho of hosts) {
      ho.el.classList.toggle('stale', stale);
      ho.update(now);
    }
  },
};
