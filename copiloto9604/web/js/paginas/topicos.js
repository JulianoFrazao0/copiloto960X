// Página "Tópicos": todos os valores da NetworkTables em árvore, com busca,
// edição de valores e atalho para criar widgets no painel.

import { nt } from '../nt.js';
import { api, btn, copyText, field, fmtValue, h, icon, modal, popupMenu, selectInput, textInput, toast } from '../util.js';
import { addWidgetToPage, pageNames } from './partida.js';

let root, listEl, searchInput, countEl;
const collapsed = new Set();
let rows = new Map();        // nome -> { vl, last }
let structureKey = '';
let lastValues = 0;

function buildTree(names) {
  const rootNode = { name: '', path: '', children: new Map(), topic: null };
  for (const n of names) {
    const parts = n.split('/').filter(Boolean);
    let node = rootNode, path = '';
    parts.forEach((part, i) => {
      path += '/' + part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), topic: null });
      node = node.children.get(part);
      if (i === parts.length - 1) node.topic = n;
    });
  }
  return rootNode;
}

function countTopics(node) {
  let c = node.topic ? 1 : 0;
  for (const ch of node.children.values()) c += countTopics(ch);
  return c;
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const names = nt.names();
  const key = names.join('|') + '#' + q + '#' + [...collapsed].join('|');
  if (key === structureKey) return;
  structureKey = key;
  rows = new Map();
  const out = [h('div', { class: 'topic-row topic-head' }, h('span', {}, 'Nome'), h('span', {}, 'Tipo'), h('span', {}, 'Valor'), h('span', {}, ''))];
  if (q) {
    for (const n of names.filter((x) => x.toLowerCase().includes(q))) out.push(topicRow(n, n, 0));
  } else {
    const walk = (node, depth) => {
      const kids = [...node.children.values()].sort((a, b) => {
        const ga = a.children.size > 0, gb = b.children.size > 0;
        return ga !== gb ? (ga ? -1 : 1) : a.name.localeCompare(b.name);
      });
      for (const ch of kids) {
        if (ch.children.size) {
          const isCol = collapsed.has(ch.path);
          const type = nt.get(ch.path + '/.type');
          out.push(h('div', { class: 'topic-row group', onclick: () => { isCol ? collapsed.delete(ch.path) : collapsed.add(ch.path); render(); } },
            h('span', { class: 'nm', style: { paddingLeft: depth * 16 + 'px' } }, h('span', { class: 'tw' }, icon(isCol ? 'chevron' : 'chevronDown')), icon('folder'), ' ', ch.name, h('span', { class: 'faint', style: { fontWeight: 400, marginLeft: '6px' } }, `(${countTopics(ch)})`)),
            h('span', { class: 'ty' }, type ? `${type}` : ''),
            h('span', {}),
            h('span', { class: 'ac' }, type ? btn('', (e) => { e.stopPropagation(); addToDash(e.currentTarget, ch.path, type); }, { cls: 'ghost sm', icon: 'plus', title: 'Adicionar ao painel' }) : null)));
          if (ch.topic) out.push(topicRow(ch.topic, '(valor)', depth + 1));
          if (!isCol) walk(ch, depth + 1);
        } else if (ch.topic) out.push(topicRow(ch.topic, ch.name, depth));
      }
    };
    walk(buildTree(names), 0);
  }
  if (names.length === 0) out.push(h('div', { class: 'empty' }, nt.connected ? 'Nenhum tópico publicado ainda.' : 'Sem conexão com o robô. Os tópicos aparecem aqui quando conectar.'));
  listEl.replaceChildren(...out);
  countEl.textContent = `${names.length} tópicos`;
  updateValues(true);
}

function topicRow(name, label, depth) {
  const vl = h('span', { class: 'vl', title: 'Clique para editar' });
  vl.addEventListener('click', () => editValue(name, vl));
  const row = h('div', { class: 'topic-row' },
    h('span', { class: 'nm', title: name, style: { paddingLeft: depth * 16 + 20 + 'px' } }, label),
    h('span', { class: 'ty' }, nt.type(name) || ''),
    vl,
    h('span', { class: 'ac' },
      btn('', () => copyText(name), { cls: 'ghost sm', icon: 'copy', title: 'Copiar o nome' }),
      btn('', (e) => addToDash(e.currentTarget, name, null), { cls: 'ghost sm', icon: 'plus', title: 'Adicionar ao painel' })));
  rows.set(name, { vl, last: undefined, row, changedAt: 0 });
  return row;
}

function updateValues(force = false) {
  for (const [name, r] of rows) {
    const e = nt.entry(name);
    if (!force && e === r.last) continue;
    const changed = r.last !== undefined && e !== r.last;
    r.last = e;
    // só pisca valores que mudam raramente (os que mudam o tempo todo ficariam piscando sem parar)
    const now = performance.now();
    const rare = now - r.changedAt > 2000;
    if (changed) r.changedAt = now;
    if (r.vl.querySelector('input')) continue;
    const v = e ? e.value : undefined;
    r.vl.textContent = v === undefined ? '' : fmtValue(v);
    r.vl.className = 'vl' + (v === true ? ' bool-t' : v === false ? ' bool-f' : '');
    if (changed && rare && !force) { r.row.classList.remove('flash'); void r.row.offsetWidth; r.row.classList.add('flash'); }
  }
}

function parseInput(type, text) {
  if (type === 'boolean') return /^(1|true|verdadeiro|sim|v|s)$/i.test(text.trim());
  if (type === 'double' || type === 'float') { const v = parseFloat(text.replace(',', '.')); if (!Number.isFinite(v)) throw new Error('número inválido'); return v; }
  if (type === 'int') { const v = parseInt(text, 10); if (!Number.isFinite(v)) throw new Error('inteiro inválido'); return v; }
  if (type.endsWith('[]')) {
    const t = text.trim();
    const arr = t.startsWith('[') ? JSON.parse(t) : t.split(',').map((s) => s.trim()).filter(Boolean);
    if (type === 'string[]') return arr.map(String);
    if (type === 'boolean[]') return arr.map((x) => x === true || /^(1|true|sim)$/i.test(String(x)));
    return arr.map((x) => { const v = parseFloat(x); if (!Number.isFinite(v)) throw new Error('lista inválida'); return v; });
  }
  return text;
}

function editValue(name, vl) {
  const type = nt.type(name);
  if (nt.status.fonte === 'replay') { toast('Na reprodução os valores são só leitura', 'warn'); return; }
  if (!type || type.startsWith('struct:') || type === 'raw') { toast('Esse tipo não dá para editar aqui', 'warn'); return; }
  if (type === 'boolean') { nt.write(name, type, !nt.get(name)); return; }
  const v = nt.get(name);
  const inp = h('input', { class: 'input sm', value: Array.isArray(v) ? v.join(', ') : String(v ?? '') });
  vl.replaceChildren(inp);
  inp.focus();
  inp.select();
  let finished = false;
  const done = (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      try { nt.write(name, type, parseInput(type, inp.value)); } catch (e) { toast('Valor inválido: ' + e.message, 'bad'); }
    }
    inp.remove();
    const r = rows.get(name);
    if (r) { r.last = undefined; updateValues(true); }
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
  inp.addEventListener('blur', () => done(true));
}

/** Escolhe o melhor widget para um tópico ou tabela. */
function suggestWidget(name, tableType) {
  if (tableType === 'Field2d') return ['campo', { topico: name + '/Robot' }];
  if (tableType === 'String Chooser') return ['seletor', { tabela: name }];
  if (tableType === 'Alerts') return ['alertas', { tabela: name }];
  if (tableType) return null;
  const type = nt.type(name), v = nt.get(name);
  if (type === 'boolean') return ['booleano', { topico: name }];
  if (['double', 'int', 'float'].includes(type)) return ['numero', { topico: name, casas: 2 }];
  if (type === 'struct:Pose2d' || type === 'struct:Pose3d' || (type === 'double[]' && Array.isArray(v) && v.length === 3)) return ['campo', { topico: name }];
  if (type === 'struct:SwerveModuleState[]') return ['swerve', { topico: name }];
  return ['texto', { topico: name }];
}

async function addToDash(anchor, name, tableType) {
  const sug = suggestWidget(name, tableType);
  if (!sug) { toast(`Não há widget para o tipo ${tableType}`, 'warn'); return; }
  let pages = pageNames();
  if (!pages.length) {
    const r = await api.get('/api/layouts').catch(() => null);
    pages = r && r.layouts ? r.layouts.paginas.map((p) => p.nome) : [];
  }
  const items = pages.map((p, i) => ({
    label: `Adicionar em "${p}"`, icon: 'partida', onClick: () => {
      location.hash = 'partida';
      // espera a página Partida existir (se ainda não foi aberta)
      const tryAdd = (n) => {
        if (pageNames().length) { addWidgetToPage(i, sug[0], sug[1], name.split('/').pop()); toast('Widget adicionado — ajuste em "Editar layout"', 'ok'); }
        else if (n > 0) setTimeout(() => tryAdd(n - 1), 150);
      };
      tryAdd(20);
    },
  }));
  if (!items.length) { toast('Abra a aba Partida uma vez antes', 'warn'); return; }
  popupMenu(anchor, items);
}

function newTopicDialog() {
  let name = '/SmartDashboard/', type = 'double', value = '0';
  const body = h('div', { class: 'col' },
    field('Nome do tópico', textInput(name, (v) => { name = v.trim(); }, { live: true })),
    field('Tipo', selectInput(type, ['double', 'boolean', 'string', 'int', 'double[]', 'string[]'], (v) => { type = v; })),
    field('Valor', textInput(value, (v) => { value = v; }, { live: true }), 'Listas: valores separados por vírgula'));
  modal({
    title: 'Publicar um valor', body,
    actions: [{ label: 'Cancelar' }, {
      label: 'Publicar', cls: 'primary', onClick: (close) => {
        if (!name.startsWith('/') || name.endsWith('/')) { toast('O nome precisa começar com / e não terminar com /', 'bad'); return; }
        try { nt.write(name, type, parseInput(type, value)); close(); } catch (e) { toast('Valor inválido: ' + e.message, 'bad'); }
      },
    }],
  });
}

export default {
  id: 'topicos', title: 'Tópicos', icon: 'topicos',

  mount(el) {
    root = el;
    searchInput = h('input', { class: 'input', placeholder: 'Buscar tópico… (ex.: limelight, Shooter)', style: { maxWidth: '380px' } });
    searchInput.addEventListener('input', () => render());
    countEl = h('span', { class: 'faint', style: { fontSize: '12px' } });
    listEl = h('div', { style: { flex: 1, overflowY: 'auto' } });
    el.append(h('div', { class: 'content' },
      h('div', { class: 'toolbar' }, icon('search'), searchInput, countEl, h('div', { class: 'spacer' }),
        btn('Recolher tudo', () => { for (const n of nt.names()) { const parts = n.split('/').filter(Boolean); let p = ''; for (const part of parts.slice(0, -1)) { p += '/' + part; collapsed.add(p); } } render(); }, { cls: 'ghost sm', icon: 'chevron' }),
        btn('Expandir tudo', () => { collapsed.clear(); render(); }, { cls: 'ghost sm', icon: 'chevronDown' }),
        btn('Publicar valor', newTopicDialog, { cls: 'sm', icon: 'send' })),
      listEl));
    render();
  },

  frame(now) {
    if (now - lastValues < 120) return;
    lastValues = now;
    render();
    updateValues();
  },
};

