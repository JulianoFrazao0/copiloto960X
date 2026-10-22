// Página "Gravações": grava todos os valores da partida e reproduz depois
// (o painel inteiro, o campo e os gráficos mostram a gravação).

import { cfg } from '../config.js';
import { nt } from '../nt.js';
import { api, btn, checkInput, confirmDialog, h, icon, textInput, toast } from '../util.js';

let root, listEl, recBox, label = '';
let lastRec = undefined;

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function niceName(file) {
  // 2026-10-21_18-30-05_BRSP_Q12.jsonl -> 21/10 18:30 · BRSP_Q12
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_?(.*)\.jsonl$/.exec(file);
  if (!m) return [file, ''];
  return [m[7] ? m[7].replace(/_/g, ' ') : 'Gravação', `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`];
}

async function refresh() {
  let r;
  try { r = await api.get('/api/gravacoes'); } catch (e) { listEl.replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
  const replaying = nt.status.fonte === 'replay' ? nt.status.replay?.arquivo : null;
  if (!r.gravacoes.length) {
    listEl.replaceChildren(h('div', { class: 'empty' }, 'Nenhuma gravação ainda. Elas aparecem aqui depois de cada partida (ou quando você grava manualmente).'));
    return;
  }
  listEl.replaceChildren(h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Partida'), h('th', {}, 'Quando'), h('th', {}, 'Tamanho'), h('th', {}, ''))),
    h('tbody', {}, r.gravacoes.map((g) => {
      const [name, when] = niceName(g.arquivo);
      const isCurrent = r.atual && r.atual.arquivo === g.arquivo;
      return h('tr', {},
        h('td', {}, h('b', {}, name), isCurrent ? h('span', { class: 'badge bad', style: { marginLeft: '8px' } }, 'gravando') : null,
          replaying === g.arquivo ? h('span', { class: 'badge accent', style: { marginLeft: '8px' } }, 'reproduzindo') : null,
          h('div', { class: 'faint mono', style: { fontSize: '11px' } }, g.arquivo)),
        h('td', { class: 'mono' }, when),
        h('td', { class: 'mono' }, fmtSize(g.tamanho)),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          btn('Reproduzir', () => openReplay(g.arquivo), { cls: 'sm primary', icon: 'play', disabled: isCurrent }),
          ' ',
          h('a', { class: 'btn sm', href: `/dados/gravacoes/${encodeURIComponent(g.arquivo)}`, download: g.arquivo, title: 'Baixar' }, icon('download')),
          ' ',
          btn('', () => remove(g.arquivo), { cls: 'sm danger icon', icon: 'trash', title: 'Excluir', disabled: isCurrent })));
    }))));
}

async function openReplay(file) {
  try {
    await api.post('/api/reproducao/abrir', { arquivo: file });
    toast('Reproduzindo — use a barra embaixo. Vá para Partida/Odometria para ver.', 'ok', 4500);
    setTimeout(refresh, 300);
  } catch (e) { toast(e.message, 'bad'); }
}

async function remove(file) {
  if (!(await confirmDialog(`Excluir a gravação ${file}? (vai para dados/lixeira)`, { ok: 'Excluir', danger: true }))) return;
  try { await api.post('/api/gravacao/excluir', { arquivo: file }); refresh(); } catch (e) { toast(e.message, 'bad'); }
}

function renderRec() {
  const rec = nt.status.gravando;
  const replay = nt.status.fonte === 'replay';
  recBox.replaceChildren(
    h('header', {}, icon('record'), h('h3', {}, rec ? 'Gravando agora' : 'Gravar')),
    rec
      ? h('div', { class: 'row' }, h('span', { class: 'dot bad' }), h('span', { class: 'mono' }, rec.arquivo), h('span', { class: 'spacer' }),
        btn('Parar e salvar', async () => { const r = await api.post('/api/gravacao/parar'); toast(`Salvo: ${r.arquivo}`, 'ok'); refresh(); }, { cls: 'danger', icon: 'stop' }))
      : h('div', { class: 'row' }, textInput(label, (v) => { label = v; }, { placeholder: 'Nome (opcional), ex.: teste shooter', live: true }),
        btn('Iniciar gravação', async () => {
          try { await api.post('/api/gravacao/iniciar', { rotulo: label || 'manual' }); refresh(); } catch (e) { toast(e.message, 'bad'); }
        }, { cls: 'primary', icon: 'record', disabled: replay })),
    checkInput('Gravar automaticamente sempre que o robô for habilitado (conectado ao robô)', cfg.get('gravacao.automatica', true), (v) => cfg.set('gravacao.automatica', v)),
    h('div', { class: 'hint' }, 'Grava todos os tópicos da NetworkTables. Para de gravar 8 s depois que o robô é desabilitado. Os arquivos ficam em dados/gravacoes (.jsonl).'));
}

export default {
  id: 'gravacoes', title: 'Gravações', icon: 'gravacoes',

  mount(el) {
    root = el;
    recBox = h('div', { class: 'card' });
    listEl = h('div', {});
    el.append(h('div', { class: 'scroll-page' }, h('div', { class: 'inner' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Gravações de partidas'), btn('Atualizar', refresh, { cls: 'ghost sm', icon: 'undo' })),
      recBox,
      h('div', { class: 'card' }, h('header', {}, icon('list'), h('h3', {}, 'Gravações salvas')), listEl),
      h('div', { class: 'card' }, h('header', {}, icon('info'), h('h3', {}, 'Como usar depois da partida')),
        h('ol', { style: { margin: 0, paddingLeft: '20px', lineHeight: 1.7, color: 'var(--muted)' } },
          h('li', {}, 'Clique em Reproduzir na partida que quer analisar.'),
          h('li', {}, 'Vá para Partida, Odometria ou Limelight: tudo mostra a gravação, como se o robô estivesse ligado.'),
          h('li', {}, 'Use a barra de baixo para pausar, voltar e mudar a velocidade.'),
          h('li', {}, 'Clique em "Voltar ao vivo" para reconectar no robô.'))))));
    renderRec();
    refresh();
    nt.onStatus((s) => {
      const key = JSON.stringify([s.gravando && s.gravando.arquivo, s.fonte]);
      if (key !== lastRec) { lastRec = key; renderRec(); if (root.classList.contains('active')) refresh(); }
    });
  },

  show() { if (root) { refresh(); renderRec(); } },
};

