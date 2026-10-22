// Página "Autônomo": editor de rotas e autônomos no formato do PathPlanner.
// Os arquivos ficam em <projeto do robô>/src/main/deploy/pathplanner, então o
// PathPlannerLib (AutoBuilder.buildAuto) usa exatamente o que foi desenhado aqui.

import { cfg } from '../config.js';
import { drawRobot, FieldView, withAlpha } from '../campo.js';
import { nt } from '../nt.js';
import * as T from '../trajetoria.js';
import {
  api, btn, checkInput, clamp, clear, codeBlock, confirmDialog, cssVar, debounce, deepCopy, deg, field, fmt, h, icon,
  numInput, popupMenu, promptDialog, rad, selectInput, textInput, toast, wrapDeg,
} from '../util.js';

const PATH_COLORS = ['#f5a524', '#22d3ee', '#a78bfa', '#22c55e', '#f472b6', '#60a5fa', '#facc15', '#fb7185'];

let root, listEl, inspector, toolbarEl, fv, timelineEls, searchInput, footEl;
let lists = { paths: [], autos: [], settings: {}, info: {} };
let commandNames = [];
let mode = 'paths';
let cur = null;               // { kind, name, data }
let traj = null;              // trajetória da rota aberta
let redTrajs = [];            // versões espelhadas (aliança vermelha) para desenhar
let timeline = null;          // linha do tempo do autônomo aberto
let tool = 'select';
let sel = null;               // { type, index }
let hover = null;
let showRed = false;
let colorBySpeed = true;
let saveState = 'ok';
const history = { undo: [], redo: [] };
const play = { t: 0, playing: false, speed: 1, last: 0 };
const pathCache = new Map();  // nome -> { data, traj }

const holonomic = () => cfg.get('robo.tipo', 'swerve') !== 'diferencial';

// ---- carregar / salvar ----------------------------------------------------------
async function refreshLists() {
  try {
    const r = await api.get('/api/pp/lista');
    lists = r;
    commandNames = [...new Set([...(r.comandos || []), ...(cfg.get('comandos', []) || [])])].sort();
  } catch (e) { toast('Erro ao listar rotas: ' + e.message, 'bad'); }
  renderList();
  renderFoot();
}

async function loadPathData(name) {
  const c = pathCache.get(name);
  if (c) return c;
  try {
    const r = await api.get('/api/pp/path?nome=' + encodeURIComponent(name));
    const data = effective(T.normalizePath(r.dados));
    const entry = { data, traj: T.generateTrajectory(data, { holonomic: holonomic() }) };
    pathCache.set(name, entry);
    return entry;
  } catch (e) { return null; }
}

/** Quando a rota usa as restrições padrão, copia as das Configurações (o PathPlannerLib lê globalConstraints). */
function effective(p) {
  if (p.useDefaultConstraints) p.globalConstraints = T.constraintsFrom({ ...p.globalConstraints, ...cfg.get('restricoes', {}) });
  return p;
}

async function open(kind, name) {
  if (cur && saveSoon.pending()) saveSoon.flush();
  try {
    const r = await api.get(`/api/pp/${kind}?nome=` + encodeURIComponent(name));
    cur = { kind, name, data: kind === 'path' ? effective(T.normalizePath(r.dados)) : T.normalizeAuto(r.dados) };
  } catch (e) { toast(e.message, 'bad'); return; }
  mode = kind === 'path' ? 'paths' : 'autos';
  history.undo = []; history.redo = [];
  sel = null;
  play.t = 0; play.playing = false;
  try { localStorage.setItem('copiloto.aberto', JSON.stringify({ kind, name })); } catch (e) { /* sem storage */ }
  await regenerate();
  renderAll();
  fv.resetView();
}

const saveSoon = debounce(async () => {
  if (!cur) return;
  const { kind, name } = cur;
  const data = deepCopy(cur.data);
  setSave('saving');
  try {
    await api.post('/api/pp/salvar', { tipo: kind, nome: name, dados: data });
    if (kind === 'path') pathCache.set(name, { data: deepCopy(data), traj: T.generateTrajectory(data, { holonomic: holonomic() }) });
    setSave('ok');
  } catch (e) {
    setSave('error');
    toast('Erro ao salvar: ' + e.message, 'bad');
  }
}, 700);

function setSave(s) {
  saveState = s;
  const el = root && root.querySelector('.save-state');
  if (!el) return;
  const map = { ok: ['ok', 'check', 'Salvo'], saving: ['', 'save', 'Salvando…'], dirty: ['dirty', 'edit', 'Alterado'], error: ['dirty', 'warn', 'Erro ao salvar'] };
  const [cls, ic, text] = map[s];
  el.className = 'save-state ' + cls;
  el.replaceChildren(icon(ic), text);
}

function pushHistory() {
  history.undo.push(JSON.stringify(cur.data));
  if (history.undo.length > 120) history.undo.shift();
  history.redo = [];
}

/** Depois de qualquer mudança: recalcula, salva e redesenha. */
function changed({ inspector: rerender = true } = {}) {
  if (cur.kind === 'path') effective(cur.data);
  setSave('dirty');
  saveSoon();
  regenerate().then(() => {
    if (rerender) renderInspector();
    fv.redraw();
  });
}

async function regenerate() {
  if (!cur) { traj = null; timeline = null; return; }
  const flip = (data) => T.generateTrajectory(T.flipPath(data, cfg.field.length, cfg.field.width, cfg.field.symmetry), { holonomic: holonomic() });
  if (cur.kind === 'path') {
    traj = T.generateTrajectory(cur.data, { holonomic: holonomic() });
    timeline = null;
    redTrajs = showRed ? [flip(cur.data)] : [];
  } else {
    traj = null;
    const names = [...new Set(T.pathNamesIn(cur.data.command))];
    await Promise.all(names.map((n) => loadPathData(n)));
    timeline = T.buildAutoTimeline(cur.data, (n) => pathCache.get(n)?.traj || null, cfg.get('duracoes', {}) || {});
    redTrajs = showRed ? names.map((n) => pathCache.get(n)?.data).filter(Boolean).map(flip) : [];
  }
  updateTimeline();
}

function undo() {
  if (!cur || !history.undo.length) return;
  history.redo.push(JSON.stringify(cur.data));
  cur.data = JSON.parse(history.undo.pop());
  sel = null;
  changed();
}

function redo() {
  if (!cur || !history.redo.length) return;
  history.undo.push(JSON.stringify(cur.data));
  cur.data = JSON.parse(history.redo.pop());
  sel = null;
  changed();
}

// ---- lista lateral -----------------------------------------------------------------
function renderList() {
  const items = mode === 'paths' ? lists.paths : lists.autos;
  const q = (searchInput.value || '').toLowerCase();
  const filtered = items.filter((i) => i.nome.toLowerCase().includes(q));
  const groups = new Map();
  for (const it of filtered) {
    const k = it.pasta || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const kind = mode === 'paths' ? 'path' : 'auto';
  const out = [];
  for (const [folder, its] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (folder || groups.size > 1) out.push(h('div', { class: 'folder-label' }, icon('folder'), folder || 'Sem pasta'));
    for (const it of its) {
      const active = cur && cur.kind === kind && cur.name === it.nome;
      out.push(h('div', { class: 'list-item' + (active ? ' active' : ''), onclick: () => open(kind, it.nome) },
        icon(kind === 'path' ? 'autonomo' : 'play'),
        h('span', { class: 'name', title: it.nome }, it.nome),
        h('span', { class: 'actions' }, btn('', (e) => { e.stopPropagation(); itemMenu(e.currentTarget, kind, it.nome); }, { cls: 'ghost sm', icon: 'dots', title: 'Opções' }))));
    }
  }
  if (!filtered.length) out.push(h('div', { class: 'empty' }, q ? 'Nada encontrado' : mode === 'paths' ? 'Nenhuma rota ainda.' : 'Nenhum autônomo ainda.'));
  listEl.replaceChildren(...out);
  root.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    const n = b.dataset.mode === 'paths' ? lists.paths.length : lists.autos.length;
    b.lastChild.textContent = `${b.dataset.mode === 'paths' ? 'Rotas' : 'Autônomos'} (${n})`;
  });
}

function renderFoot() {
  const info = lists.info || cfg.pathplanner || {};
  const exemplo = /exemplo/i.test(info.descricao || '');
  footEl.replaceChildren(
    h('div', { class: 'row', style: { marginBottom: '4px' } }, h('span', { class: 'badge ' + (exemplo ? 'warn' : 'ok') }, exemplo ? 'Pasta de exemplo' : 'Projeto do robô'),
      h('a', { href: '#configuracoes', style: { marginLeft: 'auto', fontSize: '12px' } }, 'Trocar')),
    h('div', { class: 'faint mono', style: { wordBreak: 'break-all', fontSize: '11px' }, title: info.pasta }, info.pasta || ''));
}

function itemMenu(anchor, kind, name) {
  const items = [
    { label: 'Renomear', icon: 'edit', onClick: () => renameItem(kind, name) },
    { label: 'Duplicar', icon: 'copy', onClick: () => duplicateItem(kind, name) },
  ];
  if (kind === 'path') items.push({ label: 'Duplicar espelhado (outra aliança)', icon: 'mirror', onClick: () => duplicateItem(kind, name, true) });
  items.push({ label: 'Mover para pasta…', icon: 'folder', onClick: () => moveToFolder(kind, name) });
  items.push('-', { label: 'Excluir', icon: 'trash', danger: true, onClick: () => deleteItem(kind, name) });
  popupMenu(anchor, items);
}

async function newItem() {
  const kind = mode === 'paths' ? 'path' : 'auto';
  const base = kind === 'path' ? 'Nova Rota' : 'Novo Autônomo';
  const name = await promptDialog(kind === 'path' ? 'Nova rota' : 'Novo autônomo', 'Nome', uniqueName(base, kind));
  if (!name) return;
  if (exists(kind, name)) { toast('Já existe um arquivo com esse nome', 'bad'); return; }
  const data = kind === 'path' ? effective(T.newPath(cfg.get('restricoes'))) : T.newAuto();
  try {
    await api.post('/api/pp/salvar', { tipo: kind, nome: name, dados: data });
    await refreshLists();
    await open(kind, name);
  } catch (e) { toast(e.message, 'bad'); }
}

function exists(kind, name) {
  return (kind === 'path' ? lists.paths : lists.autos).some((i) => i.nome === name);
}

function uniqueName(base, kind) {
  let n = base, i = 2;
  while (exists(kind, n)) n = `${base} ${i++}`;
  return n;
}

async function renameItem(kind, name) {
  const novo = await promptDialog('Renomear', 'Novo nome', name);
  if (!novo || novo === name) return;
  try {
    if (cur && cur.name === name && cur.kind === kind) await saveSoon.flush();
    const r = await api.post('/api/pp/renomear', { tipo: kind, nome: name, novo });
    pathCache.delete(name);
    if (r.autosAtualizados && r.autosAtualizados.length) toast(`Autônomos atualizados: ${r.autosAtualizados.join(', ')}`, 'ok', 4500);
    if (cur && cur.kind === kind && cur.name === name) cur.name = novo;
    await refreshLists();
    if (cur && cur.kind === 'auto') { await regenerate(); renderInspector(); }
  } catch (e) { toast(e.message, 'bad'); }
}

async function duplicateItem(kind, name, mirror = false) {
  try {
    const r = await api.get(`/api/pp/${kind}?nome=` + encodeURIComponent(name));
    let data = r.dados;
    if (mirror) data = T.flipPath(T.normalizePath(data), cfg.field.length, cfg.field.width, cfg.field.symmetry);
    const novo = uniqueName(name + (mirror ? ' (vermelho)' : ' (cópia)'), kind);
    await api.post('/api/pp/salvar', { tipo: kind, nome: novo, dados: data });
    await refreshLists();
    await open(kind, novo);
  } catch (e) { toast(e.message, 'bad'); }
}

async function moveToFolder(kind, name) {
  const r = await api.get(`/api/pp/${kind}?nome=` + encodeURIComponent(name));
  const folder = await promptDialog('Mover para pasta', 'Nome da pasta (vazio = sem pasta)', r.dados.folder || '');
  if (folder === null) return;
  r.dados.folder = folder || null;
  await api.post('/api/pp/salvar', { tipo: kind, nome: name, dados: r.dados });
  if (cur && cur.kind === kind && cur.name === name) cur.data.folder = folder || null;
  await refreshLists();
}

async function deleteItem(kind, name) {
  let msg = `Excluir "${name}"? (O arquivo vai para dados/lixeira, dá para recuperar.)`;
  if (kind === 'path') {
    const users = [];
    for (const a of lists.autos) {
      try {
        const r = await api.get('/api/pp/auto?nome=' + encodeURIComponent(a.nome));
        if (T.pathNamesIn(r.dados.command).includes(name)) users.push(a.nome);
      } catch (e) { /* ignora */ }
    }
    if (users.length) msg += `\n\nAtenção: usada nos autônomos: ${users.join(', ')}`;
  }
  if (!(await confirmDialog(msg, { ok: 'Excluir', danger: true }))) return;
  if (cur && cur.kind === kind && cur.name === name) saveSoon.cancel();
  try {
    await api.post('/api/pp/excluir', { tipo: kind, nome: name });
    pathCache.delete(name);
    if (cur && cur.kind === kind && cur.name === name) { cur = null; traj = null; timeline = null; }
    await refreshLists();
    renderAll();
  } catch (e) { toast(e.message, 'bad'); }
}

// ---- barra de ferramentas e linha do tempo -----------------------------------------
function renderToolbar() {
  const items = [];
  if (cur && cur.kind === 'path') {
    const tools = [['select', 'pointer', 'Selecionar e arrastar (V)'], ['add', 'plus', 'Adicionar ponto — clique no campo; perto da rota insere no meio (A)']];
    if (holonomic()) tools.push(['rot', 'rotate', 'Alvo de rotação — clique na rota (R)']);
    tools.push(['event', 'flag', 'Evento / comando nomeado — clique na rota (M)']);
    items.push(h('div', { class: 'seg' }, tools.map(([id, ic, title]) => {
      const b = h('button', { class: tool === id ? 'on' : '', title, onclick: () => { tool = id; renderToolbar(); } }, icon(ic));
      return b;
    })));
    items.push(h('div', { class: 'sep' }));
    items.push(btn('', undo, { cls: 'ghost', icon: 'undo', title: 'Desfazer (Ctrl+Z)' }), btn('', redo, { cls: 'ghost', icon: 'redo', title: 'Refazer (Ctrl+Shift+Z)' }));
    items.push(h('div', { class: 'sep' }));
    items.push(btn('', () => { colorBySpeed = !colorBySpeed; renderToolbar(); fv.redraw(); }, { cls: colorBySpeed ? 'on' : 'ghost', icon: 'graph', title: 'Colorir a rota pela velocidade' }));
  }
  if (cur) {
    items.push(btn('', () => { showRed = !showRed; renderToolbar(); regenerate().then(() => fv.redraw()); }, { cls: showRed ? 'on' : 'ghost', icon: 'mirror', title: 'Mostrar como fica para a aliança vermelha' }));
  }
  items.push(btn('', () => fv.resetView(), { cls: 'ghost', icon: 'fit', title: 'Enquadrar o campo' }));
  items.push(h('div', { class: 'spacer' }));
  if (cur) {
    items.push(h('span', { class: 'faint', style: { fontSize: '13px', fontWeight: 650, color: 'var(--text)' } }, cur.name));
    items.push(h('span', { class: 'save-state' }));
    if (cur.kind === 'auto' && nt.status.fonte === 'sim') {
      items.push(btn('Testar no simulador', testInSim, { cls: 'sm primary', icon: 'play', title: 'Seleciona este autônomo e começa o modo autônomo no robô simulado' }));
    }
    items.push(btn('Hot reload', hotReload, { cls: 'sm', icon: 'hot', title: 'Experimental: manda para o PathPlannerLib no robô (desabilitado, fora do FMS) sem fazer deploy' }));
  }
  toolbarEl.replaceChildren(...items);
  setSave(saveState);
}

function buildTimeline() {
  const range = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0 });
  const time = h('span', { class: 'time' });
  const playBtn = btn('', () => togglePlay(), { cls: 'primary', icon: 'play', title: 'Prévia (Espaço)' });
  const speed = selectInput(1, [[0.25, '0,25×'], [0.5, '0,5×'], [1, '1×'], [2, '2×']], (v) => { play.speed = +v; }, { sm: true });
  speed.style.width = '76px';
  range.addEventListener('input', () => { play.t = +range.value; play.playing = false; updateTimeline(); fv.redraw(); });
  timelineEls = { range, time, playBtn };
  return h('div', { class: 'timeline' }, playBtn, range, time, speed);
}

function duration() {
  if (traj) return traj.duration;
  if (timeline) return timeline.duration;
  return 0;
}

function updateTimeline() {
  if (!timelineEls) return;
  const d = duration();
  timelineEls.range.max = Math.max(0.01, d);
  timelineEls.range.value = play.t;
  timelineEls.time.replaceChildren(h('b', {}, fmt(play.t, 2)), ` / ${fmt(d, 2)} s`);
  timelineEls.playBtn.replaceChildren(icon(play.playing ? 'pause' : 'play'));
}

function togglePlay() {
  if (!cur) return;
  if (!play.playing && play.t >= duration() - 1e-3) play.t = 0;
  play.playing = !play.playing;
  play.last = performance.now();
  updateTimeline();
}

async function testInSim() {
  await saveSoon.flush();
  const table = cfg.get('topicos.seletorAuto', '/SmartDashboard/Auto');
  await nt.write(table + '/selected', 'string', cur.name);
  setTimeout(() => nt.write('/Copiloto/Sim/Modo', 'string', 'auto'), 300);
  toast(`Rodando "${cur.name}" no simulador`, 'ok');
  location.hash = 'odometria';
}

async function hotReload() {
  if (!cur) return;
  if (nt.status.fonte !== 'nt' || !nt.connected) { toast('Hot reload precisa estar conectado ao robô (ou à simulação WPILib)', 'warn'); return; }
  if (nt.robotState().enabled) { toast('Desabilite o robô antes do hot reload', 'warn'); return; }
  saveSoon.flush();
  const topic = cur.kind === 'path' ? '/PathPlanner/HotReload/hotReloadPath' : '/PathPlanner/HotReload/hotReloadAuto';
  const payload = cur.kind === 'path' ? { name: cur.name, path: cur.data } : { name: cur.name, auto: cur.data };
  await nt.write(topic, 'string', JSON.stringify(payload));
  toast('Enviado para o robô. Lembre de fazer deploy para ficar permanente.', 'ok', 4500);
}

// ---- desenho no campo -----------------------------------------------------------------
function speedColor(v, vmax) {
  const f = clamp(v / Math.max(0.1, vmax), 0, 1);
  // azul (devagar) -> verde -> amarelo -> vermelho (rápido)
  const stops = [[59, 130, 246], [34, 197, 94], [234, 179, 8], [239, 68, 68]];
  const x = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), t = x - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * t));
  return `rgb(${c.join(',')})`;
}

function drawTraj(ctx, tr, { color, width = 3.5, bySpeed = false, vmax = 3, alpha = 1, dash = null }) {
  const pts = tr.pts;
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  if (!bySpeed) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = fv.toPx(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  } else {
    const step = Math.max(1, Math.floor(pts.length / 300));
    for (let i = 0; i < pts.length - step; i += step) {
      const a = pts[i], b = pts[Math.min(pts.length - 1, i + step)];
      ctx.strokeStyle = speedColor((a.v + b.v) / 2, vmax);
      ctx.beginPath();
      ctx.moveTo(...fv.toPx(a.x, a.y));
      ctx.lineTo(...fv.toPx(b.x, b.y));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawRange(ctx, path, from, to, color, width) {
  const pts = [];
  for (let p = from; p <= to + 1e-9; p += 0.02) pts.push(T.pointAt(path, Math.min(p, to)));
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = fv.toPx(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.restore();
}

function robotHalf() {
  const r = cfg.get('robo', {});
  return Math.max(r.comprimento || 0.86, r.largura || 0.86) / 2;
}

/** Posição (px) da alça que gira o robô fantasma. */
function rotHandle(x, y, rotDeg) {
  const d = robotHalf() + 0.22;
  return fv.toPx(x + Math.cos(rad(rotDeg)) * d, y + Math.sin(rad(rotDeg)) * d);
}

function drawHandle(ctx, x, y, r, fill, stroke, selected) {
  ctx.beginPath();
  ctx.arc(x, y, r + (selected ? 2 : 0), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = selected ? 3 : 2;
  ctx.strokeStyle = selected ? '#fff' : stroke;
  ctx.stroke();
}

function drawRotGhost(ctx, x, y, rotDeg, color, selected) {
  drawRobot(ctx, fv, { x, y, rot: rad(rotDeg) }, { ghost: true, color, alpha: 0.9 });
  const [cx, cy] = fv.toPx(x, y);
  const [hx, hy] = rotHandle(x, y, rotDeg);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.setLineDash([]);
  drawHandle(ctx, hx, hy, 5, color, '#0006', selected);
}

function drawPathEditor(ctx) {
  const p = cur.data;
  const accent = cssVar('--accent');
  const purple = cssVar('--purple');
  if (showRed) for (const rt of redTrajs) drawTraj(ctx, rt, { color: '#ef4444', width: 2.5, alpha: 0.7, dash: [8, 6] });
  // zonas de restrição
  for (const z of p.constraintZones) drawRange(ctx, p, z.minWaypointRelativePos, z.maxWaypointRelativePos, 'rgba(239,68,68,.28)', 14);
  // eventos com faixa
  p.eventMarkers.forEach((m) => {
    if (m.endWaypointRelativePos != null) drawRange(ctx, p, m.waypointRelativePos, m.endWaypointRelativePos, withAlpha(purple, 0.3), 11);
  });
  if (traj) drawTraj(ctx, traj, { color: accent, bySpeed: colorBySpeed, vmax: p.globalConstraints.maxVelocity });

  // robôs fantasmas: início, fim e alvos de rotação
  const w = p.waypoints;
  if (w.length) {
    const startRot = holonomic() ? p.idealStartingState.rotation : deg(T.waypointHeading(w[0])) + (p.reversed ? 180 : 0);
    const endRot = holonomic() ? p.goalEndState.rotation : deg(T.waypointHeading(w[w.length - 1])) + (p.reversed ? 180 : 0);
    if (holonomic()) {
      drawRotGhost(ctx, w[0].anchor.x, w[0].anchor.y, startRot, '#22c55e', sel && sel.type === 'start');
      drawRotGhost(ctx, w[w.length - 1].anchor.x, w[w.length - 1].anchor.y, endRot, '#ef4444', sel && sel.type === 'end');
      p.rotationTargets.forEach((r, i) => {
        const pt = T.pointAt(p, r.waypointRelativePos);
        drawRotGhost(ctx, pt.x, pt.y, r.rotationDegrees, cssVar('--cyan'), sel && sel.type === 'rot' && sel.index === i);
      });
    } else {
      drawRobot(ctx, fv, { x: w[0].anchor.x, y: w[0].anchor.y, rot: rad(startRot) }, { ghost: true, color: '#22c55e' });
      drawRobot(ctx, fv, { x: w[w.length - 1].anchor.x, y: w[w.length - 1].anchor.y, rot: rad(endRot) }, { ghost: true, color: '#ef4444' });
    }
  }
  // eventos
  ctx.font = '600 11px system-ui';
  p.eventMarkers.forEach((m, i) => {
    const pt = T.pointAt(p, m.waypointRelativePos);
    const [x, y] = fv.toPx(pt.x, pt.y);
    const s = sel && sel.type === 'marker' && sel.index === i;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = purple;
    ctx.strokeStyle = s ? '#fff' : '#0008';
    ctx.lineWidth = s ? 3 : 1.5;
    ctx.fillRect(-6, -6, 12, 12);
    ctx.strokeRect(-6, -6, 12, 12);
    ctx.restore();
    ctx.fillStyle = purple;
    ctx.textAlign = 'left';
    ctx.fillText(m.name, x + 10, y - 9);
  });
  // waypoints
  w.forEach((wp, i) => {
    const [ax, ay] = fv.toPx(wp.anchor.x, wp.anchor.y);
    for (const which of ['prevControl', 'nextControl']) {
      const c = wp[which];
      if (!c) continue;
      const [cx, cy] = fv.toPx(c.x, c.y);
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(cx, cy); ctx.stroke();
      const s = sel && sel.type === which && sel.index === i;
      drawHandle(ctx, cx, cy, 4.5, '#e8edf4', '#0008', s);
    }
    const color = i === 0 ? '#22c55e' : i === w.length - 1 ? '#ef4444' : accent;
    const s = sel && sel.type === 'anchor' && sel.index === i;
    const hv = hover && hover.type === 'anchor' && hover.index === i;
    drawHandle(ctx, ax, ay, hv ? 8 : 7, color, '#000a', s);
    if (wp.linkedName) {
      ctx.fillStyle = '#fff'; ctx.font = '600 10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('🔗 ' + wp.linkedName, ax, ay - 14);
    }
  });
  // robô da prévia
  if (traj && traj.pts.length > 1) {
    const s = T.sampleTraj(traj, play.t);
    if (s) drawRobot(ctx, fv, s, { color: accent, fillAlpha: 0.35 });
  }
  // dica do cursor
  if (hover && hover.type === 'path' && (tool === 'add' || tool === 'rot' || tool === 'event')) {
    const pt = T.pointAt(p, hover.pos);
    const [x, y] = fv.toPx(pt.x, pt.y);
    drawHandle(ctx, x, y, 5, tool === 'event' ? purple : tool === 'rot' ? cssVar('--cyan') : accent, '#000a', false);
  }
}

function drawAutoView(ctx) {
  if (!timeline) return;
  if (showRed) for (const rt of redTrajs) drawTraj(ctx, rt, { color: '#ef4444', width: 2, alpha: 0.6, dash: [8, 6] });
  const seen = new Map();
  timeline.paths.forEach((it) => {
    if (!seen.has(it.name)) seen.set(it.name, PATH_COLORS[seen.size % PATH_COLORS.length]);
  });
  timeline.paths.forEach((it) => {
    const color = seen.get(it.name);
    drawTraj(ctx, it.traj, { color, width: 3.5 });
    const end = it.traj.pts[it.traj.pts.length - 1];
    const [x, y] = fv.toPx(end.x, end.y);
    drawHandle(ctx, x, y, 4, color, '#000a', false);
  });
  const first = timeline.paths[0];
  if (first) drawRobot(ctx, fv, first.traj.pts[0], { ghost: true, color: '#22c55e', label: 'Início' });
  const pose = T.autoPoseAt(timeline, play.t);
  if (pose) drawRobot(ctx, fv, pose, { color: cssVar('--accent'), fillAlpha: 0.35 });
}

// ---- interação com o campo -----------------------------------------------------------
const HIT = 10;

function hitTest(px, py) {
  if (!cur || cur.kind !== 'path') return null;
  const p = cur.data;
  const near = (x, y) => Math.hypot(px - x, py - y) <= HIT;
  const w = p.waypoints;
  // controles do selecionado primeiro
  const order = w.map((_, i) => i);
  if (sel && sel.index != null && ['anchor', 'prevControl', 'nextControl'].includes(sel.type)) {
    order.splice(order.indexOf(sel.index), 1);
    order.unshift(sel.index);
  }
  for (const i of order) {
    for (const which of ['prevControl', 'nextControl']) {
      const c = w[i][which];
      if (c && near(...fv.toPx(c.x, c.y))) return { type: which, index: i };
    }
  }
  for (let i = 0; i < w.length; i++) if (near(...fv.toPx(w[i].anchor.x, w[i].anchor.y))) return { type: 'anchor', index: i };
  for (let i = 0; i < p.eventMarkers.length; i++) {
    const pt = T.pointAt(p, p.eventMarkers[i].waypointRelativePos);
    if (near(...fv.toPx(pt.x, pt.y))) return { type: 'marker', index: i };
  }
  if (holonomic() && w.length) {
    for (let i = 0; i < p.rotationTargets.length; i++) {
      const r = p.rotationTargets[i];
      const pt = T.pointAt(p, r.waypointRelativePos);
      if (near(...rotHandle(pt.x, pt.y, r.rotationDegrees))) return { type: 'rot', index: i, handle: true };
      if (Math.hypot(...[px, py].map((v, k) => v - fv.toPx(pt.x, pt.y)[k])) < HIT) return { type: 'rot', index: i };
    }
    const a = w[0].anchor, b = w[w.length - 1].anchor;
    if (near(...rotHandle(a.x, a.y, p.idealStartingState.rotation))) return { type: 'start', handle: true };
    if (near(...rotHandle(b.x, b.y, p.goalEndState.rotation))) return { type: 'end', handle: true };
  }
  if (traj) {
    const [fx, fy] = fv.toField(px, py);
    const n = T.nearestPos(traj, fx, fy);
    if (n && n.dist * fv.scale < HIT + 4) return { type: 'path', pos: n.pos };
  }
  return null;
}

let drag = null;

function onDown(pt) {
  if (!cur || cur.kind !== 'path') return false;
  const hit = hitTest(pt.px, pt.py);
  if (tool !== 'select' && (!hit || hit.type === 'path')) return false; // clique tratado em onClick
  if (!hit || hit.type === 'path') { if (sel) { sel = null; renderInspector(); fv.redraw(); } return false; }
  sel = { type: hit.type, index: hit.index };
  drag = { hit, started: false, before: JSON.stringify(cur.data) };
  renderInspector();
  fv.redraw();
  return true;
}

const lazyInspector = debounce(() => renderInspector(), 120);

function onMove(pt, d) {
  if (!drag) return;
  if (!drag.started) { drag.started = true; history.undo.push(drag.before); history.redo = []; }
  const p = cur.data;
  const { hit } = drag;
  const snap = pt.e.shiftKey;
  let x = pt.x, y = pt.y;
  if (snap && (hit.type === 'anchor')) { x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10; }
  x = clamp(x, 0, cfg.field.length); y = clamp(y, 0, cfg.field.width);
  if (hit.type === 'anchor') T.moveAnchor(p.waypoints[hit.index], x, y);
  else if (hit.type === 'prevControl' || hit.type === 'nextControl') T.moveControl(p.waypoints[hit.index], hit.type, pt.x, pt.y);
  else if (hit.type === 'start' || hit.type === 'end' || (hit.type === 'rot' && hit.handle)) {
    let center;
    if (hit.type === 'start') center = p.waypoints[0].anchor;
    else if (hit.type === 'end') center = p.waypoints[p.waypoints.length - 1].anchor;
    else center = T.pointAt(p, p.rotationTargets[hit.index].waypointRelativePos);
    let a = deg(Math.atan2(pt.y - center.y, pt.x - center.x));
    a = snap ? Math.round(a / 15) * 15 : Math.round(a);
    a = wrapDeg(a);
    if (hit.type === 'start') p.idealStartingState.rotation = a;
    else if (hit.type === 'end') p.goalEndState.rotation = a;
    else p.rotationTargets[hit.index].rotationDegrees = a;
  } else if (hit.type === 'rot' || hit.type === 'marker') {
    const n = T.nearestPos(traj, pt.x, pt.y);
    if (n) {
      const pos = Math.round(n.pos * 100) / 100;
      if (hit.type === 'rot') p.rotationTargets[hit.index].waypointRelativePos = pos;
      else {
        const m = p.eventMarkers[hit.index];
        if (m.endWaypointRelativePos != null) m.endWaypointRelativePos = clamp(m.endWaypointRelativePos + pos - m.waypointRelativePos, 0, p.waypoints.length - 1);
        m.waypointRelativePos = pos;
      }
    }
  }
  traj = T.generateTrajectory(p, { holonomic: holonomic() });
  if (showRed) redTrajs = [T.generateTrajectory(T.flipPath(p, cfg.field.length, cfg.field.width, cfg.field.symmetry), { holonomic: holonomic() })];
  updateTimeline();
  fv.redraw();
  lazyInspector();
}

function onUp() {
  if (drag && drag.started) changed();
  drag = null;
}

function onHover(pt) {
  const hit = hitTest(pt.px, pt.py);
  const key = JSON.stringify(hit);
  if (key !== JSON.stringify(hover)) { hover = hit; fv.redraw(); }
  fv.canvas.style.cursor = hit && hit.type !== 'path' ? 'grab' : tool !== 'select' ? 'crosshair' : 'default';
}

function onClick(pt) {
  if (!cur || cur.kind !== 'path') return;
  const p = cur.data;
  const hit = hitTest(pt.px, pt.py);
  if (tool === 'add') {
    pushHistory();
    if (hit && hit.type === 'path') {
      const seg = Math.min(Math.floor(hit.pos), p.waypoints.length - 2);
      T.insertWaypoint(p, seg, clamp(hit.pos - seg, 0.05, 0.95));
      sel = { type: 'anchor', index: seg + 1 };
    } else {
      T.addWaypointEnd(p, clamp(pt.x, 0, cfg.field.length), clamp(pt.y, 0, cfg.field.width));
      sel = { type: 'anchor', index: p.waypoints.length - 1 };
    }
    changed();
  } else if ((tool === 'rot' || tool === 'event') && hit && hit.type === 'path') {
    pushHistory();
    const pos = Math.round(hit.pos * 100) / 100;
    if (tool === 'rot') {
      const s = traj.pts.find((q) => q.pos >= pos) || traj.pts[traj.pts.length - 1];
      p.rotationTargets.push({ waypointRelativePos: pos, rotationDegrees: Math.round(wrapDeg(deg(s.rot))) });
      sel = { type: 'rot', index: p.rotationTargets.length - 1 };
    } else {
      const name = commandNames[0] || 'Evento';
      p.eventMarkers.push({ name, waypointRelativePos: pos, endWaypointRelativePos: null, command: { type: 'named', data: { name } } });
      sel = { type: 'marker', index: p.eventMarkers.length - 1 };
    }
    changed();
  }
}

function onDblClick(pt) {
  if (!cur || cur.kind !== 'path' || tool !== 'select') return;
  const hit = hitTest(pt.px, pt.py);
  if (hit && hit.type !== 'path') return;
  pushHistory();
  T.addWaypointEnd(cur.data, clamp(pt.x, 0, cfg.field.length), clamp(pt.y, 0, cfg.field.width));
  sel = { type: 'anchor', index: cur.data.waypoints.length - 1 };
  changed();
}

function deleteSelected() {
  if (!cur || cur.kind !== 'path' || !sel) return;
  const p = cur.data;
  pushHistory();
  if (sel.type === 'anchor' || sel.type === 'prevControl' || sel.type === 'nextControl') {
    if (!T.deleteWaypoint(p, sel.index)) { history.undo.pop(); toast('A rota precisa de pelo menos 2 pontos', 'warn'); return; }
  } else if (sel.type === 'rot') p.rotationTargets.splice(sel.index, 1);
  else if (sel.type === 'marker') p.eventMarkers.splice(sel.index, 1);
  else { history.undo.pop(); return; }
  sel = null;
  changed();
}

// ---- inspetor ------------------------------------------------------------------------------
function section(title, ...children) {
  return [h('div', { class: 'section-title' }, title), ...children];
}

/** Edita um campo da rota guardando histórico. */
function edit(fn) {
  return (v) => { pushHistory(); fn(v); changed(); };
}

function renderInspector() {
  if (!inspector) return;
  if (!cur) {
    inspector.replaceChildren(h('div', { class: 'empty' },
      h('p', {}, 'Escolha uma rota ou autônomo na lista, ou crie um novo.'),
      h('p', { class: 'faint' }, 'Dica: os arquivos são do PathPlanner. No robô, use AutoBuilder.buildAuto("nome").')));
    return;
  }
  if (cur.kind === 'path') renderPathInspector();
  else renderAutoInspector();
}

function posInput(value, max, onChange) {
  return numInput(Math.round(value * 100) / 100, (v) => onChange(clamp(v, 0, max)), { step: 0.05, min: 0, max, sm: true });
}

function renderPathInspector() {
  const p = cur.data;
  const n = p.waypoints.length - 1;
  const out = [];
  // seleção
  if (sel && ['anchor', 'prevControl', 'nextControl'].includes(sel.type) && p.waypoints[sel.index]) {
    const i = sel.index, wp = p.waypoints[i];
    const label = i === 0 ? 'Ponto inicial' : i === n ? 'Ponto final' : `Ponto ${i}`;
    out.push(...section(label,
      h('div', { class: 'grid2' },
        field('X (m)', numInput(fmtN(wp.anchor.x), edit((v) => T.moveAnchor(wp, v, wp.anchor.y)), { step: 0.01, sm: true })),
        field('Y (m)', numInput(fmtN(wp.anchor.y), edit((v) => T.moveAnchor(wp, wp.anchor.x, v)), { step: 0.01, sm: true })),
        field('Direção (°)', numInput(fmtN(deg(T.waypointHeading(wp)), 1), edit((v) => T.setWaypointHeading(wp, rad(v))), { step: 1, sm: true })),
        h('div'),
        wp.prevControl ? field('Controle anterior (m)', numInput(fmtN(T.controlLength(wp, 'prevControl')), edit((v) => T.setControlLength(wp, 'prevControl', v)), { step: 0.05, min: 0.05, sm: true })) : h('div'),
        wp.nextControl ? field('Controle seguinte (m)', numInput(fmtN(T.controlLength(wp, 'nextControl')), edit((v) => T.setControlLength(wp, 'nextControl', v)), { step: 0.05, min: 0.05, sm: true })) : h('div')),
      h('div', { class: 'row wrap' },
        i < n ? btn('Inserir ponto depois', () => { pushHistory(); T.insertWaypoint(p, i, 0.5); sel = { type: 'anchor', index: i + 1 }; changed(); }, { cls: 'sm', icon: 'plus' }) : null,
        btn('Excluir', deleteSelected, { cls: 'sm danger', icon: 'trash', disabled: n < 2 })),
      wp.linkedName ? h('div', { class: 'hint' }, `Waypoint ligado ("${wp.linkedName}"): no PathPlanner ele é compartilhado entre rotas.`) : null));
  } else if (sel && sel.type === 'rot' && p.rotationTargets[sel.index]) {
    const r = p.rotationTargets[sel.index];
    out.push(...section('Alvo de rotação',
      h('div', { class: 'grid2' },
        field('Posição (0 a ' + n + ')', posInput(r.waypointRelativePos, n, edit((v) => { r.waypointRelativePos = v; }))),
        field('Rotação (°)', numInput(fmtN(r.rotationDegrees, 1), edit((v) => { r.rotationDegrees = wrapDeg(v); }), { step: 1, sm: true }))),
      btn('Excluir alvo', deleteSelected, { cls: 'sm danger', icon: 'trash' })));
  } else if (sel && sel.type === 'marker' && p.eventMarkers[sel.index]) {
    out.push(...section('Evento', markerEditor(p, p.eventMarkers[sel.index], n), btn('Excluir evento', deleteSelected, { cls: 'sm danger', icon: 'trash' })));
  } else if (sel && (sel.type === 'start' || sel.type === 'end')) {
    // tratado em "Início e fim"
  } else {
    out.push(h('div', { class: 'hint', style: { marginTop: '6px' } },
      'Arraste os pontos e as alças. Clique duas vezes no campo para adicionar um ponto no fim. ',
      h('kbd', {}, 'Del'), ' exclui, ', h('kbd', {}, 'Shift'), ' encaixa, ', h('kbd', {}, 'Espaço'), ' toca a prévia.'));
  }

  // início e fim
  const hol = holonomic();
  out.push(...section('Início e fim',
    h('div', { class: 'grid2' },
      hol ? field('Rotação inicial (°)', numInput(fmtN(p.idealStartingState.rotation, 1), edit((v) => { p.idealStartingState.rotation = wrapDeg(v); }), { step: 1, sm: true })) : null,
      field('Velocidade inicial (m/s)', numInput(p.idealStartingState.velocity, edit((v) => { p.idealStartingState.velocity = Math.max(0, v); }), { step: 0.1, min: 0, sm: true })),
      hol ? field('Rotação final (°)', numInput(fmtN(p.goalEndState.rotation, 1), edit((v) => { p.goalEndState.rotation = wrapDeg(v); }), { step: 1, sm: true })) : null,
      field('Velocidade final (m/s)', numInput(p.goalEndState.velocity, edit((v) => { p.goalEndState.velocity = Math.max(0, v); }), { step: 0.1, min: 0, sm: true }))),
    hol ? null : checkInput('Andar de ré (reversed)', p.reversed, edit((v) => { p.reversed = v; }))));

  // restrições
  const c = p.globalConstraints;
  out.push(...section('Restrições',
    checkInput('Usar as restrições padrão (Configurações)', p.useDefaultConstraints, edit((v) => { p.useDefaultConstraints = v; })),
    h('div', { class: 'grid2' },
      field('Vel. máx (m/s)', numInput(c.maxVelocity, edit((v) => { c.maxVelocity = v; p.useDefaultConstraints = false; }), { step: 0.1, min: 0.1, sm: true })),
      field('Acel. máx (m/s²)', numInput(c.maxAcceleration, edit((v) => { c.maxAcceleration = v; p.useDefaultConstraints = false; }), { step: 0.1, min: 0.1, sm: true })),
      field('Vel. angular (°/s)', numInput(c.maxAngularVelocity, edit((v) => { c.maxAngularVelocity = v; p.useDefaultConstraints = false; }), { step: 10, min: 1, sm: true })),
      field('Acel. angular (°/s²)', numInput(c.maxAngularAcceleration, edit((v) => { c.maxAngularAcceleration = v; p.useDefaultConstraints = false; }), { step: 10, min: 1, sm: true })))));

  // alvos de rotação
  if (hol) {
    out.push(h('div', { class: 'section-title' }, 'Alvos de rotação', h('span', { class: 'spacer' }),
      btn('', () => { pushHistory(); p.rotationTargets.push({ waypointRelativePos: n / 2, rotationDegrees: 0 }); sel = { type: 'rot', index: p.rotationTargets.length - 1 }; changed(); }, { cls: 'ghost sm', icon: 'plus', title: 'Adicionar' })));
    out.push(p.rotationTargets.length ? h('div', { class: 'mini-list' }, p.rotationTargets.map((r, i) => h('div', {
      class: 'mini-item' + (sel && sel.type === 'rot' && sel.index === i ? ' sel' : ''), onclick: (e) => { if (e.target.closest('input,button')) return; sel = { type: 'rot', index: i }; renderInspector(); fv.redraw(); },
    }, h('div', { class: 'top' }, icon('rotate'), h('span', { class: 'grow' }, `${fmt(r.rotationDegrees, 0)}° na posição ${fmt(r.waypointRelativePos, 2)}`))))) : h('div', { class: 'hint' }, 'Use a ferramenta de rotação e clique na rota para o robô virar no caminho.'));
  }

  // eventos
  out.push(h('div', { class: 'section-title' }, 'Eventos (comandos nomeados)', h('span', { class: 'spacer' }),
    btn('', () => { pushHistory(); const name = commandNames[0] || 'Evento'; p.eventMarkers.push({ name, waypointRelativePos: n / 2, endWaypointRelativePos: null, command: { type: 'named', data: { name } } }); sel = { type: 'marker', index: p.eventMarkers.length - 1 }; changed(); }, { cls: 'ghost sm', icon: 'plus', title: 'Adicionar' })));
  out.push(p.eventMarkers.length ? h('div', { class: 'mini-list' }, p.eventMarkers.map((m, i) => h('div', {
    class: 'mini-item' + (sel && sel.type === 'marker' && sel.index === i ? ' sel' : ''), onclick: (e) => { if (e.target.closest('input,button')) return; sel = { type: 'marker', index: i }; renderInspector(); fv.redraw(); },
  }, h('div', { class: 'top' }, icon('flag'), h('span', { class: 'grow' }, m.name), h('span', { class: 'faint mono' }, m.endWaypointRelativePos != null ? `${fmt(m.waypointRelativePos, 2)}→${fmt(m.endWaypointRelativePos, 2)}` : fmt(m.waypointRelativePos, 2)))))) : h('div', { class: 'hint' }, 'Ex.: ligar o intake no meio da rota.'));

  // zonas
  out.push(h('div', { class: 'section-title' }, 'Zonas de restrição', h('span', { class: 'spacer' }),
    btn('', () => { pushHistory(); p.constraintZones.push({ name: 'Zona', minWaypointRelativePos: Math.max(0, n / 2 - 0.25), maxWaypointRelativePos: Math.min(n, n / 2 + 0.25), constraints: T.constraintsFrom({ ...p.globalConstraints, maxVelocity: Math.max(0.5, p.globalConstraints.maxVelocity / 2) }) }); changed(); }, { cls: 'ghost sm', icon: 'plus', title: 'Adicionar' })));
  out.push(p.constraintZones.length ? h('div', { class: 'mini-list' }, p.constraintZones.map((z, i) => h('div', { class: 'mini-item' },
    h('div', { class: 'top' }, icon('zone'), textInput(z.name, edit((v) => { z.name = v; }), { sm: true }),
      btn('', () => { pushHistory(); p.constraintZones.splice(i, 1); changed(); }, { cls: 'ghost sm', icon: 'trash', title: 'Excluir' })),
    h('div', { class: 'grid2' },
      field('De', posInput(z.minWaypointRelativePos, n, edit((v) => { z.minWaypointRelativePos = Math.min(v, z.maxWaypointRelativePos); }))),
      field('Até', posInput(z.maxWaypointRelativePos, n, edit((v) => { z.maxWaypointRelativePos = Math.max(v, z.minWaypointRelativePos); }))),
      field('Vel. máx (m/s)', numInput(z.constraints.maxVelocity, edit((v) => { z.constraints.maxVelocity = v; }), { step: 0.1, min: 0.1, sm: true })),
      field('Acel. máx (m/s²)', numInput(z.constraints.maxAcceleration, edit((v) => { z.constraints.maxAcceleration = v; }), { step: 0.1, min: 0.1, sm: true })))))) : h('div', { class: 'hint' }, 'Para ir mais devagar num trecho (ex.: chegando para coletar).'));

  // resumo
  if (traj) {
    const maxOmegaDeg = deg(traj.maxOmega);
    const over = hol && maxOmegaDeg > c.maxAngularVelocity * 1.02;
    out.push(...section('Resumo',
      h('div', { class: 'stats' },
        stat('Tempo', fmt(traj.duration, 2), 's'),
        stat('Distância', fmt(traj.length, 2), 'm'),
        stat('Vel. máx', fmt(traj.maxV, 2), 'm/s'),
        hol ? stat('Giro máx', fmt(maxOmegaDeg, 0), '°/s', over ? 'warn' : '') : null),
      over ? h('div', { class: 'hint', style: { color: 'var(--yellow)' } }, `A rotação pede ${fmt(maxOmegaDeg, 0)}°/s, acima do limite de ${c.maxAngularVelocity}°/s: o robô vai atrasar a rotação. Afaste os alvos ou aumente o limite.`) : null,
      h('div', { class: 'hint' }, 'Tempo estimado; o PathPlannerLib usa o modelo físico do robô e pode variar um pouco.')));
  }
  out.push(...section('Pasta', textInput(p.folder || '', edit((v) => { p.folder = v.trim() || null; refreshListSoon(); }), { sm: true, placeholder: 'Sem pasta' })));
  clear(inspector, out);
}

const refreshListSoon = debounce(() => refreshLists(), 900);

function fmtN(v, d = 3) { return Math.round(v * 10 ** d) / 10 ** d; }

function stat(k, v, unit, cls = '') {
  return h('div', { class: 'stat ' + cls }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', {}, unit) : null));
}

function commandDatalist() {
  const id = 'cmds-' + Math.random().toString(36).slice(2, 7);
  return [id, h('datalist', { id }, commandNames.map((c) => h('option', { value: c })))];
}

function markerEditor(p, m, n) {
  const [dlId, dl] = commandDatalist();
  const name = textInput(m.name, edit((v) => {
    m.name = v.trim() || 'Evento';
    m.command = { type: 'named', data: { name: m.name } };
  }), { sm: true, list: dlId });
  return h('div', { class: 'col' },
    field('Comando nomeado', h('div', {}, name, dl), 'O mesmo nome do NamedCommands.registerCommand no código'),
    h('div', { class: 'grid2' },
      field('Posição', posInput(m.waypointRelativePos, n, edit((v) => { m.waypointRelativePos = v; }))),
      field('Termina em (opcional)', numInput(m.endWaypointRelativePos ?? '', edit((v) => { m.endWaypointRelativePos = v == null ? null : clamp(Math.max(v, m.waypointRelativePos), 0, n); }), { step: 0.05, min: 0, max: n, sm: true, allowEmpty: true }))),
    h('div', { class: 'hint' }, 'Com "termina em", o comando roda só enquanto o robô está nesse trecho.'));
}

// ---- inspetor do autônomo ----------------------------------------------------------------
const KIND_LABEL = { path: 'Rota', named: 'Comando', wait: 'Espera', sequential: 'Sequência', parallel: 'Paralelo', race: 'Corrida', deadline: 'Prazo' };
const GROUP_HINT = {
  sequential: 'Um depois do outro',
  parallel: 'Todos juntos; termina quando todos terminarem',
  race: 'Todos juntos; termina quando o primeiro terminar',
  deadline: 'Todos juntos; termina quando o primeiro da lista terminar',
};

function newCommand(type) {
  if (type === 'path') return { type: 'path', data: { pathName: lists.paths[0]?.nome || '' } };
  if (type === 'named') return { type: 'named', data: { name: commandNames[0] || 'Comando' } };
  if (type === 'wait') return { type: 'wait', data: { waitTime: 0.5 } };
  return { type, data: { commands: [] } };
}

function addMenu(anchor, list) {
  popupMenu(anchor, [
    { label: 'Rota', icon: 'autonomo', onClick: () => { pushHistory(); list.push(newCommand('path')); changed(); } },
    { label: 'Comando nomeado', icon: 'flag', onClick: () => { pushHistory(); list.push(newCommand('named')); changed(); } },
    { label: 'Espera', icon: 'timer', onClick: () => { pushHistory(); list.push(newCommand('wait')); changed(); } },
    '-',
    { label: 'Grupo paralelo', icon: 'list', onClick: () => { pushHistory(); list.push(newCommand('parallel')); changed(); } },
    { label: 'Grupo em sequência', icon: 'list', onClick: () => { pushHistory(); list.push(newCommand('sequential')); changed(); } },
    { label: 'Grupo corrida (race)', icon: 'list', onClick: () => { pushHistory(); list.push(newCommand('race')); changed(); } },
    { label: 'Grupo com prazo (deadline)', icon: 'list', onClick: () => { pushHistory(); list.push(newCommand('deadline')); changed(); } },
  ]);
}

function cmdTime(cmd) {
  if (!timeline) return '';
  if (cmd.type === 'path') {
    const t = pathCache.get(cmd.data.pathName)?.traj;
    return t ? `${fmt(t.duration, 2)} s` : '?';
  }
  if (cmd.type === 'wait') return `${fmt(+cmd.data.waitTime || 0, 2)} s`;
  if (cmd.type === 'named') return `${fmt(+(cfg.get('duracoes', {}) || {})[cmd.data.name] || 0, 1)} s`;
  return '';
}

function renderCmd(cmd, list, idx, [dlId]) {
  const d = cmd.data;
  const move = (delta) => { const j = idx + delta; if (j < 0 || j >= list.length) return; pushHistory(); [list[idx], list[j]] = [list[j], list[idx]]; changed(); };
  const isGroup = ['sequential', 'parallel', 'race', 'deadline'].includes(cmd.type);
  let content;
  if (cmd.type === 'path') {
    const names = lists.paths.map((p) => p.nome);
    if (d.pathName && !names.includes(d.pathName)) names.unshift(d.pathName);
    content = selectInput(d.pathName, names.map((n) => [n, lists.paths.some((p) => p.nome === n) ? n : `${n} (não existe!)`]), edit((v) => { d.pathName = v; }), { sm: true });
  } else if (cmd.type === 'named') {
    content = textInput(d.name, edit((v) => { d.name = v.trim(); }), { sm: true, list: dlId });
  } else if (cmd.type === 'wait') {
    content = numInput(d.waitTime, edit((v) => { d.waitTime = Math.max(0, v); }), { step: 0.1, min: 0, sm: true, unit: 's' });
  } else {
    content = selectInput(cmd.type, Object.keys(GROUP_HINT).map((k) => [k, `${KIND_LABEL[k]} — ${GROUP_HINT[k]}`]), edit((v) => { cmd.type = v; }), { sm: true });
  }
  const kindCls = isGroup ? 'group' : cmd.type;
  const head = h('div', { class: 'cmd-head' },
    h('span', { class: 'kind ' + kindCls }, KIND_LABEL[cmd.type] || cmd.type),
    h('div', { class: 'grow' }, content),
    h('span', { class: 'ctl' },
      h('span', { class: 'tm' }, cmdTime(cmd)),
      btn('', () => move(-1), { cls: 'ghost sm', icon: 'up', title: 'Subir', disabled: idx === 0 }),
      btn('', () => move(1), { cls: 'ghost sm', icon: 'down', title: 'Descer', disabled: idx === list.length - 1 }),
      btn('', () => { pushHistory(); list.splice(idx, 1); changed(); }, { cls: 'ghost sm', icon: 'x', title: 'Remover' })));
  const box = h('div', { class: 'cmd' }, head);
  if (isGroup) {
    d.commands = d.commands || [];
    const kids = h('div', { class: 'cmd-kids' }, d.commands.map((c, i) => renderCmd(c, d.commands, i, [dlId])),
      btn('Adicionar no grupo', (e) => addMenu(e.currentTarget, d.commands), { cls: 'ghost sm', icon: 'plus' }));
    box.append(kids);
  }
  return box;
}

function renderAutoInspector() {
  const a = cur.data;
  const [dlId, dl] = commandDatalist();
  const rootList = a.command.data.commands = a.command.data.commands || [];
  const out = [dl];
  out.push(...section('Opções',
    checkInput('Reiniciar a odometria no início da primeira rota', a.resetOdom, edit((v) => { a.resetOdom = v; })),
    field('Pasta', textInput(a.folder || '', edit((v) => { a.folder = v.trim() || null; refreshListSoon(); }), { sm: true, placeholder: 'Sem pasta' }))));
  if (a.command.type !== 'sequential') out.push(h('div', { class: 'hint' }, `O grupo principal é "${KIND_LABEL[a.command.type]}".`));
  out.push(h('div', { class: 'section-title' }, 'Passos', h('span', { class: 'spacer' }), btn('Adicionar', (e) => addMenu(e.currentTarget, rootList), { cls: 'sm', icon: 'plus' })));
  out.push(rootList.length ? h('div', { class: 'cmd-tree' }, rootList.map((c, i) => renderCmd(c, rootList, i, [dlId]))) : h('div', { class: 'empty' }, 'Adicione rotas, comandos e esperas.'));

  if (timeline) {
    const limit = cfg.get('partida.auto', 20);
    const total = timeline.duration;
    const scale = Math.max(total, limit) * 1.04 || 1;
    const bar = h('div', { class: 'auto-bar' });
    let colorI = 0;
    const colors = new Map();
    for (const it of timeline.items) {
      if (it.end - it.start < 1e-3 || (it.depth > 1 && it.kind !== 'path')) continue;
      let bg = 'var(--panel-3)';
      if (it.kind === 'path') { if (!colors.has(it.name)) colors.set(it.name, PATH_COLORS[colorI++ % PATH_COLORS.length]); bg = colors.get(it.name); }
      if (it.kind === 'named') bg = 'var(--purple)';
      bar.append(h('div', { class: 'seg-b', title: `${it.name}: ${fmt(it.start, 2)}–${fmt(it.end, 2)} s`, style: { left: (it.start / scale) * 100 + '%', width: ((it.end - it.start) / scale) * 100 + '%', background: bg } }, it.kind === 'path' ? it.name : ''));
    }
    bar.append(h('div', { class: 'limit', title: `Fim do autônomo (${limit} s)`, style: { left: (limit / scale) * 100 + '%' } }));
    const ok = total <= limit;
    out.push(...section('Tempo',
      h('div', { class: 'stats' }, stat('Total estimado', fmt(total, 2), 's', ok ? 'ok' : 'bad'), stat('Sobra', fmt(limit - total, 2), 's', ok ? '' : 'bad')),
      bar,
      h('div', { class: 'hint', style: ok ? {} : { color: 'var(--red)' } }, ok ? `Cabe nos ${limit} s do autônomo.` : `Passa dos ${limit} s do autônomo!`),
      timeline.items.some((i) => i.missing) ? h('div', { class: 'hint', style: { color: 'var(--yellow)' } }, 'Alguma rota usada não existe na pasta.') : null));
    const named = [...new Set(timeline.items.filter((i) => i.kind === 'named').map((i) => i.name))];
    if (named.length) {
      const durs = cfg.get('duracoes', {}) || {};
      out.push(...section('Duração estimada dos comandos',
        h('div', { class: 'hint' }, 'Só para a estimativa de tempo (o robô decide a duração real).'),
        ...named.map((n) => h('div', { class: 'row' }, h('span', { class: 'grow', style: { fontSize: '13px' } }, n),
          h('div', { style: { width: '110px' } }, numInput(durs[n] ?? 0, (v) => { cfg.set('duracoes', { ...(cfg.get('duracoes', {}) || {}), [n]: Math.max(0, v) }); regenerate().then(renderInspector); }, { step: 0.1, min: 0, sm: true, unit: 's' }))))));
      out.push(...section('Código do robô (Java)',
        h('div', { class: 'hint' }, 'Registre os comandos antes de criar o AutoBuilder / os autônomos:'),
        codeBlock(named.map((n) => `NamedCommands.registerCommand("${n}", /* seu comando */ Commands.none());`).join('\n') +
          `\n\nCommand auto = AutoBuilder.buildAuto("${cur.name}");`)));
    }
  }
  clear(inspector, out);
}

function renderAll() {
  renderList();
  renderToolbar();
  renderInspector();
  updateTimeline();
  fv.redraw();
}

// ---------------------------------------------------------------------------------------
export default {
  id: 'autonomo', title: 'Autônomo', icon: 'autonomo',

  async mount(el) {
    root = el;
    searchInput = h('input', { class: 'input sm', placeholder: 'Buscar…' });
    searchInput.addEventListener('input', renderList);
    listEl = h('div', { class: 'list' });
    footEl = h('div', { class: 'side-foot' });
    const seg = h('div', { class: 'seg full' },
      h('button', { 'data-mode': 'paths', onclick: () => { mode = 'paths'; renderList(); } }, icon('autonomo'), h('span', {}, 'Rotas')),
      h('button', { 'data-mode': 'autos', onclick: () => { mode = 'autos'; renderList(); } }, icon('play'), h('span', {}, 'Autônomos')));
    const side = h('aside', { class: 'side' },
      h('div', { class: 'side-head' }, seg, h('div', { class: 'row' }, searchInput, btn('', newItem, { cls: 'primary sm icon', icon: 'plus', title: 'Novo' }))),
      h('div', { class: 'side-body' }, listEl), footEl);
    toolbarEl = h('div', { class: 'toolbar' });
    const wrap = h('div', { class: 'field-wrap' });
    inspector = h('div', { class: 'side-body', style: { paddingTop: '6px' } });
    const content = h('div', { class: 'content' }, toolbarEl, wrap, buildTimeline());
    el.append(side, content, h('aside', { class: 'side right' }, inspector));
    fv = new FieldView(wrap, { onDown, onMove, onUp, onHover, onClick, onDblClick });
    fv.layers.push((ctx) => {
      if (!cur) return;
      if (cur.kind === 'path') drawPathEditor(ctx); else drawAutoView(ctx);
    });
    document.addEventListener('keydown', (e) => {
      if (!root.classList.contains('active') || e.target.closest('input, textarea, select, .modal')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveSoon.flush(); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
      else if (e.key === 'Escape') { sel = null; tool = 'select'; renderToolbar(); renderInspector(); fv.redraw(); }
      else if (!mod && cur && cur.kind === 'path') {
        const k = e.key.toLowerCase();
        if (k === 'v') tool = 'select'; else if (k === 'a') tool = 'add'; else if (k === 'r' && holonomic()) tool = 'rot'; else if (k === 'm') tool = 'event';
        else if (sel && sel.type === 'anchor' && e.key.startsWith('Arrow')) {
          e.preventDefault();
          const step = e.shiftKey ? 0.1 : 0.01;
          const wp = cur.data.waypoints[sel.index];
          pushHistory();
          T.moveAnchor(wp, wp.anchor.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0), wp.anchor.y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0));
          changed();
          return;
        } else return;
        renderToolbar();
      }
    });
    cfg.onChange((path) => {
      if (path && (path.startsWith('restricoes') || path.startsWith('robo'))) {
        pathCache.clear();
        if (cur) regenerate().then(() => { renderToolbar(); renderInspector(); fv.redraw(); });
      }
      if (path === 'pathplanner') { pathCache.clear(); refreshLists(); }
    });
    await refreshLists();
    let last = null;
    try { last = JSON.parse(localStorage.getItem('copiloto.aberto') || 'null'); } catch (e) { last = null; }
    if (last && exists(last.kind, last.name)) await open(last.kind, last.name);
    else if (lists.autos.length) await open('auto', lists.autos[0].nome);
    else if (lists.paths.length) await open('path', lists.paths[0].nome);
    renderAll();
  },

  show() { if (root) refreshLists(); },

  frame(now) {
    if (play.playing) {
      play.t += ((now - play.last) / 1000) * play.speed;
      if (play.t >= duration()) { play.t = duration(); play.playing = false; }
      updateTimeline();
      fv.redraw();
    }
    play.last = now;
    fv.frame();
  },
};
