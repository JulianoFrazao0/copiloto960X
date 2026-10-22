// Ponto de entrada: monta a barra superior, as páginas e o laço de desenho.

import { cfg } from './config.js';
import { startEvents } from './eventos.js';
import { MODE_LABEL, nt } from './nt.js';
import { api, btn, clear, fmtTime, h, icon, popupMenu, promptDialog, toast } from './util.js';
import partida from './paginas/partida.js';
import autonomo from './paginas/autonomo.js';
import odometria from './paginas/odometria.js';
import limelight from './paginas/limelight.js';
import topicos from './paginas/topicos.js';
import gravacoes from './paginas/gravacoes.js';
import configuracoes from './paginas/configuracoes.js';

const PAGES = [partida, autonomo, odometria, limelight, topicos, gravacoes, configuracoes];
const mounted = new Map();
let current = null;

async function boot() {
  try {
    await cfg.load();
  } catch (e) {
    document.getElementById('main').append(h('div', { class: 'empty', style: { paddingTop: '80px' } },
      'Não consegui falar com o programa Python do Copiloto. Ele está aberto? ', h('br'), e.message));
    return;
  }
  nt.start();
  startEvents();
  buildTabs();
  buildStatus();
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.altKey && /^[1-7]$/.test(e.key)) { location.hash = PAGES[+e.key - 1].id; e.preventDefault(); }
  });
  nt.onStatus((s) => {
    if (s.erro && s.erro !== lastError) toast(s.erro, 'warn', 6000);
    lastError = s.erro;
    renderReplayBar();
  });
  await route();
  requestAnimationFrame(loop);
  setTimeout(() => PAGES.forEach((p) => ensureMounted(p)), 600);
}

let lastError = null;

function buildTabs() {
  const nav = document.getElementById('tabs');
  PAGES.forEach((p, i) => {
    nav.append(h('button', { class: 'tab', 'data-id': p.id, title: `${p.title} (Alt+${i + 1})`, onclick: () => { location.hash = p.id; } },
      icon(p.icon), h('span', {}, p.title)));
  });
}

async function route() {
  const id = (location.hash || '#partida').slice(1).split('?')[0];
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  if (current === page) return;
  if (current) {
    mounted.get(current.id).classList.remove('active');
    current.hide && current.hide();
  }
  current = page;
  const el = await ensureMounted(page, true);
  if (current !== page) return;
  el.classList.add('active');
  page.show && page.show();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === page.id));
}

const mounting = new Map();

/** Monta a página uma vez (as outras são montadas em segundo plano para já gravarem dados). */
function ensureMounted(page, visible = false) {
  if (mounting.has(page.id)) return mounting.get(page.id);
  const el = h('section', { class: 'page' + (visible ? ' active' : ''), id: 'page-' + page.id });
  document.getElementById('main').append(el);
  mounted.set(page.id, el);
  const pr = Promise.resolve()
    .then(() => page.mount(el))
    .catch((e) => { console.error(e); el.append(h('div', { class: 'empty' }, 'Erro ao abrir a página: ' + e.message)); })
    .then(() => el);
  mounting.set(page.id, pr);
  return pr;
}

function loop(now) {
  if (current && current.frame && mounted.get(current.id)?.classList.contains('active')) {
    try { current.frame(now); } catch (e) { console.error(e); }
  }
  if (now - lastStatus > 100) { lastStatus = now; updateStatus(); }
  requestAnimationFrame(loop);
}
let lastStatus = 0;

// ---- barra de status ----------------------------------------------------------
const S = {};

function buildStatus() {
  const box = document.getElementById('status');
  S.rec = h('button', { class: 'chip rec hidden', title: 'Gravando a partida — clique para parar', onclick: stopRec }, h('span', { class: 'dot' }), h('span', {}, 'REC'));
  S.batt = h('span', { class: 'chip opt num', title: 'Bateria' }, '— V');
  S.ally = h('span', { class: 'chip opt hidden' }, '');
  S.mode = h('span', { class: 'chip' }, '—');
  S.timer = h('span', { class: 'chip timer-chip', title: 'Tempo da partida' }, '—:——');
  S.connDot = h('span', { class: 'dot' });
  S.connText = h('span', {}, 'Conectando…');
  S.conn = h('button', { class: 'chip', title: 'Trocar conexão', onclick: connMenu }, S.connDot, S.connText);
  box.append(S.rec, S.batt, S.ally, S.mode, S.timer, S.conn);
}

function updateStatus() {
  const st = nt.robotState();
  const s = nt.status;
  // conexão
  let dot = 'bad', text = 'Copiloto desligado';
  if (nt.online) {
    if (s.fonte === 'sim') { dot = 'sim'; text = 'Simulador'; }
    else if (s.fonte === 'replay') { dot = 'rep'; text = 'Reprodução'; }
    else if (s.conectado) { dot = 'ok'; text = `Robô ${s.ip || ''}`.trim(); }
    else { dot = 'bad'; text = `Procurando robô…`; }
  }
  S.connDot.className = 'dot ' + dot;
  S.connText.textContent = text;
  S.conn.title = (s.servidor || '') + ' — clique para trocar a conexão';
  // modo
  S.mode.textContent = MODE_LABEL[st.mode] || '—';
  S.mode.className = 'chip ' + ({ auto: 'mode-auto', teleop: 'mode-teleop', test: 'mode-test', estop: 'mode-estop' }[st.mode] || '');
  // aliança
  S.ally.classList.toggle('hidden', !st.alliance);
  if (st.alliance) {
    S.ally.textContent = `${st.alliance === 'red' ? 'Vermelha' : 'Azul'} ${st.station ?? ''}`;
    S.ally.className = 'chip opt ally-' + st.alliance;
  }
  // tempo
  const t = nt.get(cfg.get('topicos.tempo'));
  const endgame = cfg.get('partida.endgame', 30);
  S.timer.textContent = typeof t === 'number' && t >= 0 ? fmtTime(t) : '—:——';
  S.timer.className = 'chip timer-chip' + (st.mode === 'auto' ? ' auto' : st.mode === 'teleop' && typeof t === 'number' && t >= 0 && t <= endgame ? ' endgame' : '');
  // bateria
  const v = nt.get(cfg.get('topicos.bateria'));
  S.batt.textContent = typeof v === 'number' ? `${v.toFixed(1)} V` : '— V';
  S.batt.className = 'chip opt num' + (typeof v === 'number' ? (v < 11 ? ' batt-low' : v < 12 ? ' batt-mid' : '') : '');
  // gravação
  const rec = s.gravando;
  S.rec.classList.toggle('hidden', !rec);
  if (rec) S.rec.lastChild.textContent = `REC ${fmtTime(Math.max(0, nt.now() - rec.inicio)).replace('—:——', '0:00')}`;
}

async function stopRec() {
  try {
    const r = await api.post('/api/gravacao/parar');
    if (r.arquivo) toast(`Gravação salva: ${r.arquivo}`, 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

function connMenu(e) {
  const team = cfg.get('equipe', 9604);
  const go = (body) => api.post('/api/conectar', body).then(() => toast('Conectando…')).catch((err) => toast(err.message, 'bad'));
  const items = [
    { label: `Robô da equipe ${team} (10.${Math.floor(team / 100)}.${team % 100}.2)`, icon: 'wifi', onClick: () => go({ modo: 'equipe' }) },
    { label: 'Simulação WPILib (127.0.0.1)', icon: 'robot', onClick: () => go({ modo: 'local' }) },
    { label: 'Endereço IP…', icon: 'link', onClick: async () => {
      const ip = await promptDialog('Conectar por endereço', 'IP ou nome do robô', cfg.get('conexao.endereco', '10.96.4.2'));
      if (ip) go({ modo: 'ip', endereco: ip });
    } },
    '-',
    { label: 'Simulador interno do Copiloto', icon: 'play', onClick: () => go({ modo: 'sim' }) },
  ];
  if (!cfg.ntcore) items.splice(0, 3, { label: 'pyntcore não instalado — rode: pip install pyntcore', icon: 'warn', onClick: () => {} });
  if (nt.status.fonte === 'sim') {
    const sim = (m) => () => nt.write('/Copiloto/Sim/Modo', 'string', m);
    items.push('-',
      { label: 'Simulador: começar o autônomo agora', icon: 'play', onClick: sim('auto') },
      { label: 'Simulador: ir para o teleoperado', icon: 'partida', onClick: sim('teleop') },
      { label: 'Simulador: desabilitar', icon: 'stop', onClick: sim('disabled') });
  }
  popupMenu(e.currentTarget, items);
}

// ---- barra de reprodução --------------------------------------------------------
let replayEls = null;

function renderReplayBar() {
  const box = document.getElementById('replay');
  const r = nt.status.fonte === 'replay' ? nt.status.replay : null;
  document.getElementById('main').classList.toggle('with-replay', !!r);
  if (!r) { clear(box); replayEls = null; return; }
  const ctl = (body) => api.post('/api/reproducao/controle', body).catch((e) => toast(e.message, 'bad'));
  if (!replayEls) {
    const range = h('input', { type: 'range', min: 0, max: r.duracao, step: 0.05, value: r.pos });
    let scrubbing = false;
    range.addEventListener('input', () => { scrubbing = true; replayEls.time.textContent = `${fmtTime(+range.value)} / ${fmtTime(r.duracao)}`; });
    range.addEventListener('change', () => { ctl({ seek: +range.value }); setTimeout(() => { scrubbing = false; }, 300); });
    const play = btn('', () => ctl({ tocando: !nt.status.replay.tocando }), { cls: 'primary', icon: 'play', title: 'Tocar/pausar' });
    const speed = h('select', { class: 'input', style: { width: '86px' } }, [0.25, 0.5, 1, 2, 4].map((v) => h('option', { value: v, selected: v === 1 }, `${v}×`)));
    speed.addEventListener('change', () => ctl({ velocidade: +speed.value }));
    replayEls = { range, play, speed, time: h('span', { class: 'time' }), name: h('span', { class: 'name' }), get scrubbing() { return scrubbing; } };
    clear(box, h('div', { class: 'replay-bar' },
      icon('gravacoes'), replayEls.name, play,
      btn('', () => ctl({ seek: Math.max(0, nt.status.replay.pos - 5) }), { icon: 'undo', title: 'Voltar 5 s' }),
      range, replayEls.time, speed,
      btn('Voltar ao vivo', () => api.post('/api/reproducao/fechar').catch((e) => toast(e.message, 'bad')), { icon: 'x' })));
  }
  replayEls.name.textContent = r.arquivo;
  if (document.activeElement !== replayEls.speed) replayEls.speed.value = String(r.velocidade);
  replayEls.range.max = r.duracao;
  if (!replayEls.scrubbing) {
    replayEls.range.value = r.pos;
    replayEls.time.textContent = `${fmtTime(r.pos)} / ${fmtTime(r.duracao)}`;
  }
  replayEls.play.replaceChildren(icon(r.tocando ? 'pause' : 'play'));
}

boot();
