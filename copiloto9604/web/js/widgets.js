// Tipos de widget do painel. Cada um descreve suas opções (o formulário de
// configuração é gerado a partir delas) e cria o conteúdo dentro do widget.

import { cfg } from './config.js';
import { drawPolyline, drawRobot, FieldView, parseBotpose, parsePose, parsePoses } from './campo.js';
import { events } from './eventos.js';
import { MODE_LABEL, nt } from './nt.js';
import { clamp, cssVar, deg, fitCanvas, fmt, fmtTime, h, icon, rad } from './util.js';

const SERIES = ['--accent', '--cyan', '--purple', '--green'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const truthy = (v) => (typeof v === 'number' ? v !== 0 : !!v);

/** Ajuda: chama fn só quando a entrada do tópico mudar. */
function watcher(getTopic, fn) {
  let last = Symbol('nunca');
  return () => {
    const e = nt.entry(getTopic());
    if (e === last) return;
    last = e;
    fn(e ? e.value : undefined, e);
  };
}

function llName(w) { return w.cfg.limelight || (cfg.get('limelights', [])[0] || {}).nome || 'limelight'; }

export const WIDGETS = {
  numero: {
    nome: 'Número', icone: 'number', desc: 'Valor numérico grande', tam: [4, 3],
    opcoes: [
      { k: 'topico', label: 'Tópico', tipo: 'topico', filtro: 'number' },
      { k: 'unidade', label: 'Unidade', tipo: 'texto', ph: 'ex.: V, RPM, m' },
      { k: 'casas', label: 'Casas decimais', tipo: 'numero', padrao: 1 },
      { k: 'vermelhoAbaixo', label: 'Vermelho abaixo de', tipo: 'numero' },
      { k: 'amareloAbaixo', label: 'Amarelo abaixo de', tipo: 'numero' },
      { k: 'verdeAcima', label: 'Verde acima de', tipo: 'numero' },
    ],
    criar(body, w) {
      const v = h('span', { class: 'v' }, '—'), u = h('span', { class: 'u' }, w.cfg.unidade || '');
      body.append(h('div', { class: 'w-number' }, v, u));
      const c = w.cfg;
      return {
        update: watcher(() => c.topico, (val) => {
          v.textContent = isNum(val) ? val.toFixed(c.casas ?? 1) : val == null ? '—' : String(val);
          let color = '';
          if (isNum(val)) {
            if (c.vermelhoAbaixo != null && val < c.vermelhoAbaixo) color = 'var(--red)';
            else if (c.amareloAbaixo != null && val < c.amareloAbaixo) color = 'var(--yellow)';
            else if (c.verdeAcima != null && val > c.verdeAcima) color = 'var(--green)';
          }
          v.style.color = color;
        }),
      };
    },
  },

  booleano: {
    nome: 'Indicador', icone: 'bool', desc: 'Verdadeiro/falso com cor (ex.: tem peça)', tam: [3, 3],
    opcoes: [
      { k: 'topico', label: 'Tópico', tipo: 'topico', filtro: 'boolean' },
      { k: 'textoV', label: 'Texto quando verdadeiro', tipo: 'texto', padrao: 'SIM' },
      { k: 'textoF', label: 'Texto quando falso', tipo: 'texto', padrao: 'NÃO' },
      { k: 'corV', label: 'Cor verdadeiro', tipo: 'cor', padrao: '#22c55e' },
      { k: 'corF', label: 'Cor falso', tipo: 'cor', padrao: '#3a4352' },
      { k: 'piscar', label: 'Piscar quando verdadeiro', tipo: 'bool' },
      { k: 'inverter', label: 'Inverter (verdadeiro = falso)', tipo: 'bool' },
    ],
    criar(body, w) {
      const c = w.cfg;
      const tile = h('div', { class: 'w-bool' }, '—');
      body.append(tile);
      return {
        update: watcher(() => c.topico, (val) => {
          if (val === undefined) { tile.textContent = '—'; tile.style.background = 'var(--panel-3)'; tile.classList.remove('blink'); return; }
          let b = truthy(val);
          if (c.inverter) b = !b;
          tile.textContent = b ? (c.textoV ?? 'SIM') : (c.textoF ?? 'NÃO');
          const bg = b ? (c.corV || '#22c55e') : (c.corF || '#3a4352');
          tile.style.background = bg;
          tile.style.color = contrast(bg);
          tile.classList.toggle('blink', !!(b && c.piscar));
        }),
      };
    },
  },

  texto: {
    nome: 'Texto', icone: 'text', desc: 'Mostra um texto do robô', tam: [4, 2],
    opcoes: [{ k: 'topico', label: 'Tópico', tipo: 'topico', filtro: 'string' }],
    criar(body, w) {
      const t = h('div', { class: 'w-text' }, '—');
      body.append(t);
      return { update: watcher(() => w.cfg.topico, (val) => { t.textContent = val == null ? '—' : Array.isArray(val) ? val.join(', ') : String(val); }) };
    },
  },

  rotulo: {
    nome: 'Título', icone: 'text', desc: 'Texto fixo para organizar o painel', tam: [6, 1], semTitulo: true,
    opcoes: [
      { k: 'texto', label: 'Texto', tipo: 'texto', padrao: 'Título' },
      { k: 'cor', label: 'Cor', tipo: 'cor', padrao: '#e8edf4' },
      { k: 'tamanho', label: 'Tamanho da fonte', tipo: 'numero', padrao: 20 },
    ],
    criar(body, w) {
      body.append(h('div', { class: 'w-label', style: { color: w.cfg.cor || '', fontSize: (w.cfg.tamanho || 20) + 'px' } }, w.cfg.texto || ''));
      return { update() {} };
    },
  },

  grafico: {
    nome: 'Gráfico', icone: 'graph', desc: 'Linha do tempo de até 4 valores', tam: [8, 5],
    opcoes: [
      { k: 'topicos', label: 'Tópicos (um por linha, até 4)', tipo: 'topicos', filtro: 'number' },
      { k: 'janela', label: 'Janela de tempo (s)', tipo: 'numero', padrao: 10 },
      { k: 'min', label: 'Mínimo do eixo (vazio = automático)', tipo: 'numero' },
      { k: 'max', label: 'Máximo do eixo (vazio = automático)', tipo: 'numero' },
    ],
    criar(body, w) {
      const wrap = h('div', { class: 'w-canvas' });
      const canvas = h('canvas');
      wrap.append(canvas);
      body.append(wrap);
      const topics = (w.cfg.topicos || []).slice(0, 4);
      const data = topics.map(() => []);
      const lastT = topics.map(() => -1);
      return {
        update() {
          const now = nt.now();
          const win = w.cfg.janela || 10;
          topics.forEach((tp, i) => {
            const e = nt.entry(tp);
            if (e && e.t !== lastT[i] && isNum(e.value)) { data[i].push([e.t, e.value]); lastT[i] = e.t; }
            const arr = data[i];
            while (arr.length > 2 && arr[1][0] < now - win - 1) arr.shift();
          });
          drawGraph(canvas, topics, data, now, win, w.cfg.min, w.cfg.max);
        },
      };
    },
  },

  medidor: {
    nome: 'Medidor', icone: 'gauge', desc: 'Ponteiro entre mínimo e máximo', tam: [4, 4],
    opcoes: [
      { k: 'topico', label: 'Tópico', tipo: 'topico', filtro: 'number' },
      { k: 'min', label: 'Mínimo', tipo: 'numero', padrao: 0 },
      { k: 'max', label: 'Máximo', tipo: 'numero', padrao: 100 },
      { k: 'unidade', label: 'Unidade', tipo: 'texto' },
      { k: 'casas', label: 'Casas decimais', tipo: 'numero', padrao: 1 },
    ],
    criar(body, w) {
      const wrap = h('div', { class: 'w-canvas' }), canvas = h('canvas');
      wrap.append(canvas); body.append(wrap);
      let lastV = null, lastW = 0;
      return {
        update() {
          const v = nt.get(w.cfg.topico);
          const cw = canvas.clientWidth + canvas.clientHeight;
          if (v === lastV && cw === lastW) return;
          lastV = v; lastW = cw;
          drawGauge(canvas, v, w.cfg);
        },
      };
    },
  },

  barra: {
    nome: 'Barra', icone: 'bar', desc: 'Barra de progresso (ex.: elevador, escalador)', tam: [6, 2],
    opcoes: [
      { k: 'topico', label: 'Tópico', tipo: 'topico', filtro: 'number' },
      { k: 'min', label: 'Mínimo', tipo: 'numero', padrao: 0 },
      { k: 'max', label: 'Máximo', tipo: 'numero', padrao: 1 },
      { k: 'unidade', label: 'Unidade', tipo: 'texto' },
      { k: 'cor', label: 'Cor', tipo: 'cor' },
    ],
    criar(body, w) {
      const c = w.cfg;
      const fill = h('div', { class: 'fill', style: { background: c.cor || '' } });
      const val = h('b', {}, '—');
      body.append(h('div', { class: 'w-bar' }, h('div', { class: 'lab' }, h('span', {}, String(c.min ?? 0)), val, h('span', {}, String(c.max ?? 1))), h('div', { class: 'track' }, fill)));
      return {
        update: watcher(() => c.topico, (v) => {
          if (!isNum(v)) { val.textContent = '—'; fill.style.width = '0'; return; }
          const lo = c.min ?? 0, hi = c.max ?? 1;
          fill.style.width = clamp((v - lo) / (hi - lo || 1), 0, 1) * 100 + '%';
          val.textContent = v.toFixed(2) + (c.unidade ? ' ' + c.unidade : '');
        }),
      };
    },
  },

  botao: {
    nome: 'Botão', icone: 'button', desc: 'Envia verdadeiro/falso para o robô', tam: [4, 2], escrita: true,
    opcoes: [
      { k: 'topico', label: 'Tópico (boolean)', tipo: 'topico', filtro: 'boolean' },
      { k: 'texto', label: 'Texto do botão', tipo: 'texto', padrao: 'Ação' },
      { k: 'modo', label: 'Modo', tipo: 'select', padrao: 'pulso', op: [['pulso', 'Pulso (verdadeiro por 0,25 s)'], ['alternar', 'Alternar (liga/desliga)'], ['segurar', 'Segurar (verdadeiro enquanto pressionado)']] },
    ],
    semTitulo: true,
    criar(body, w) {
      const c = w.cfg;
      const b = h('button', { class: 'w-btn' }, c.texto || 'Ação');
      const send = (v) => c.topico && nt.write(c.topico, 'boolean', v);
      b.addEventListener('pointerdown', () => {
        if (c.modo === 'alternar') send(!truthy(nt.get(c.topico, false)));
        else if (c.modo === 'segurar') send(true);
        else { send(true); setTimeout(() => send(false), 250); }
      });
      const release = () => { if (c.modo === 'segurar') send(false); };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointerleave', release);
      body.append(b);
      return { update: watcher(() => c.topico, (v) => b.classList.toggle('on', truthy(v))) };
    },
  },

  deslizante: {
    nome: 'Controle deslizante', icone: 'slider', desc: 'Envia um número (ex.: ajuste fino)', tam: [5, 2], escrita: true,
    opcoes: [
      { k: 'topico', label: 'Tópico (double)', tipo: 'topico', filtro: 'number' },
      { k: 'min', label: 'Mínimo', tipo: 'numero', padrao: 0 },
      { k: 'max', label: 'Máximo', tipo: 'numero', padrao: 1 },
      { k: 'passo', label: 'Passo', tipo: 'numero', padrao: 0.01 },
    ],
    criar(body, w) {
      const c = w.cfg;
      const val = h('div', { class: 'v' }, '—');
      const r = h('input', { type: 'range', min: c.min ?? 0, max: c.max ?? 1, step: c.passo ?? 0.01 });
      let dragging = false, timer = null;
      r.addEventListener('pointerdown', () => { dragging = true; });
      r.addEventListener('pointerup', () => { dragging = false; });
      r.addEventListener('input', () => {
        val.textContent = (+r.value).toFixed(2);
        clearTimeout(timer);
        timer = setTimeout(() => c.topico && nt.write(c.topico, 'double', +r.value), 40);
      });
      body.append(h('div', { class: 'w-slider' }, val, r));
      return {
        update: watcher(() => c.topico, (v) => { if (!dragging && isNum(v)) { r.value = v; val.textContent = v.toFixed(2); } }),
      };
    },
  },

  seletor: {
    nome: 'Seletor (SendableChooser)', icone: 'list', desc: 'Escolha do autônomo e outros seletores', tam: [5, 3],
    opcoes: [{ k: 'tabela', label: 'Tabela do seletor', tipo: 'tabela', padrao: '/SmartDashboard/Auto', hint: 'Ex.: /SmartDashboard/Auto (onde o robô fez SmartDashboard.putData("Auto", chooser))' }],
    criar(body, w) {
      const t = () => w.cfg.tabela || cfg.get('topicos.seletorAuto');
      const sel = h('select', { class: 'input' });
      const act = h('div', { class: 'act' }, '');
      sel.addEventListener('change', () => nt.write(t() + '/selected', 'string', sel.value));
      body.append(h('div', { class: 'w-chooser' }, sel, act));
      let lastKey = '';
      return {
        update() {
          const opts = nt.get(t() + '/options', []) || [];
          const active = nt.get(t() + '/active');
          const selected = nt.get(t() + '/selected');
          const def = nt.get(t() + '/default');
          const cur = selected ?? active ?? def ?? '';
          const key = JSON.stringify([opts, active, cur]);
          if (key === lastKey) return;
          lastKey = key;
          if (sel.dataset.opts !== JSON.stringify(opts)) {
            sel.replaceChildren(...(opts.length ? opts : ['(sem opções)']).map((o) => h('option', { value: o }, o)));
            sel.dataset.opts = JSON.stringify(opts);
          }
          if (document.activeElement !== sel) sel.value = cur;
          if (active == null) { act.textContent = 'Robô não publicou o seletor'; act.className = 'act bad'; }
          else if (selected != null && selected !== active) { act.textContent = `Robô ainda usa: ${active}`; act.className = 'act bad'; }
          else { act.textContent = `✓ No robô: ${active}`; act.className = 'act ok'; }
        },
      };
    },
  },

  campo: {
    nome: 'Campo', icone: 'field', desc: 'Posição do robô no campo', tam: [9, 6],
    opcoes: [
      { k: 'topico', label: 'Pose do robô', tipo: 'topico', filtro: 'pose', padraoCfg: 'topicos.pose' },
      { k: 'rastro', label: 'Mostrar rastro', tipo: 'bool', padrao: true },
      { k: 'visao', label: 'Mostrar pose da Limelight (MegaTag2)', tipo: 'bool', padrao: true },
      { k: 'objetos', label: 'Mostrar outros objetos do Field2d', tipo: 'bool', padrao: true },
      { k: 'girar', label: 'Girar campo', tipo: 'select', padrao: 'alianca', op: [['alianca', 'Conforme a aliança (vermelho gira 180°)'], ['nunca', 'Nunca (azul à esquerda)'], ['sempre', 'Sempre girado']] },
    ],
    criar(body, w) {
      const wrap = h('div', { class: 'w-canvas field-wrap', style: { borderRadius: '7px' } });
      body.append(wrap);
      const fv = new FieldView(wrap, { interactive: false, zoom: false, padding: 6, labels: false });
      const trail = [];
      const topic = () => w.cfg.topico || cfg.get('topicos.pose');
      fv.layers.push((ctx) => {
        if (w.cfg.objetos !== false) {
          const table = topic().split('/').slice(0, -1).join('/');
          for (const sub of nt.children(table)) {
            if (sub.startsWith('.') || table + '/' + sub === topic() || sub.includes('/')) continue;
            const poses = parsePoses(nt.get(table + '/' + sub));
            if (poses.length > 1) drawPolyline(ctx, fv, poses, { color: cssVar('--cyan'), width: 2, alpha: 0.8 });
            else if (poses.length === 1) drawRobot(ctx, fv, poses[0], { ghost: true, color: cssVar('--cyan') });
          }
        }
        if (w.cfg.rastro !== false) drawPolyline(ctx, fv, trail, { color: cssVar('--accent'), width: 2, alpha: 0.45 });
        if (w.cfg.visao !== false) {
          const bp = parseBotpose(nt.get(`/${llName(w)}/botpose_orb_wpiblue`));
          if (bp && bp.pose) drawRobot(ctx, fv, bp.pose, { ghost: true, color: cssVar('--green') });
        }
        drawRobot(ctx, fv, parsePose(nt.get(topic()), topic()), {});
      });
      let last = null;
      return {
        update() {
          const st = nt.robotState();
          const flip = w.cfg.girar === 'sempre' || (w.cfg.girar !== 'nunca' && st.alliance === 'red');
          if (flip !== fv.flipped) { fv.flipped = flip; fv.redraw(); }
          const e = nt.entry(topic());
          if (e !== last) {
            last = e;
            const p = parsePose(e && e.value, topic());
            if (p) {
              const lp = trail[trail.length - 1];
              if (!lp || Math.hypot(lp.x - p.x, lp.y - p.y) > 0.03) trail.push(p);
              if (trail.length > 400) trail.shift();
            }
            fv.redraw();
          }
          fv.frame();
        },
        destroy() { fv.destroy(); },
      };
    },
  },

  camera: {
    nome: 'Câmera', icone: 'camera', desc: 'Vídeo MJPEG (Limelight, CameraServer)', tam: [7, 5],
    opcoes: [
      { k: 'url', label: 'Endereço do vídeo', tipo: 'texto', ph: 'http://10.96.4.11:5800/stream.mjpg', hint: 'Limelight: http://IP:5800/stream.mjpg · CameraServer: http://roborio-9604-frc.local:1181/?action=stream' },
    ],
    criar(body, w) {
      const url = w.cfg.url || `http://${(cfg.get('limelights', [])[0] || {}).host || 'limelight.local'}:5800/stream.mjpg`;
      const box = h('div', { class: 'w-cam' });
      const msg = h('div', { class: 'msg' }, 'Conectando à câmera…');
      const img = h('img', { alt: '' });
      let retry = null;
      img.onload = () => { msg.textContent = ''; };
      img.onerror = () => {
        msg.textContent = `Sem vídeo de ${url} — tentando de novo…`;
        clearTimeout(retry);
        retry = setTimeout(() => { img.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(); }, 3000);
      };
      img.src = url;
      box.append(img, msg);
      body.append(box);
      return { update() {}, destroy() { clearTimeout(retry); img.src = ''; } };
    },
  },

  cronometro: {
    nome: 'Tempo de partida', icone: 'timer', desc: 'Tempo restante e fase (auto/teleop/endgame)', tam: [5, 4], semTitulo: true,
    opcoes: [{ k: 'topico', label: 'Tópico do tempo', tipo: 'topico', filtro: 'number', padraoCfg: 'topicos.tempo' }],
    criar(body, w) {
      const v = h('div', { class: 'v' }, '—:——'), p = h('div', { class: 'p' }, '');
      const box = h('div', { class: 'w-timer' }, v, p);
      body.append(box);
      return {
        update() {
          const st = nt.robotState();
          const t = nt.get(w.cfg.topico || cfg.get('topicos.tempo'));
          const endgame = cfg.get('partida.endgame', 30);
          v.textContent = isNum(t) && t >= 0 ? fmtTime(t) : '—:——';
          let cls = '', label = MODE_LABEL[st.mode] || '';
          if (st.mode === 'auto') cls = 'auto';
          else if (st.mode === 'teleop') {
            if (isNum(t) && t >= 0 && t <= endgame) { cls = 'endgame'; label = 'Endgame'; }
            else cls = 'teleop';
          }
          box.className = 'w-timer ' + cls;
          p.textContent = label;
        },
      };
    },
  },

  alertas: {
    nome: 'Alertas', icone: 'bell', desc: 'Alertas do WPILib (classe Alert)', tam: [5, 6],
    opcoes: [{ k: 'tabela', label: 'Tabela de alertas', tipo: 'tabela', padraoCfg: 'topicos.alertas' }],
    criar(body, w) {
      const list = h('div', { class: 'w-alerts' });
      body.append(list);
      let lastKey = '';
      return {
        update() {
          const t = w.cfg.tabela || cfg.get('topicos.alertas');
          const rows = [];
          for (const [sub, kind, ic] of [['errors', 'error', 'error'], ['warnings', 'warning', 'warn'], ['infos', 'info', 'info']]) {
            for (const m of nt.get(`${t}/${sub}`, []) || []) rows.push([kind, ic, m]);
          }
          const key = JSON.stringify(rows);
          if (key === lastKey) return;
          lastKey = key;
          if (!rows.length) list.replaceChildren(h('div', { class: 'empty' }, nt.has(`${t}/.type`) ? 'Nenhum alerta ✓' : 'Robô não publica alertas'));
          else list.replaceChildren(...rows.map(([kind, ic, m]) => h('div', { class: 'alert-row ' + kind }, icon(ic), h('span', {}, m))));
        },
      };
    },
  },

  swerve: {
    nome: 'Swerve', icone: 'swerve', desc: 'Direção e velocidade dos 4 módulos', tam: [5, 5],
    opcoes: [
      { k: 'topico', label: 'Estados dos módulos', tipo: 'topico', hint: 'struct SwerveModuleState[] ou double[] [ângulo°, velocidade, …] na ordem FE, FD, TE, TD' },
      { k: 'vmax', label: 'Velocidade máxima (m/s)', tipo: 'numero', padrao: 4.5 },
    ],
    criar(body, w) {
      const wrap = h('div', { class: 'w-canvas' }), canvas = h('canvas');
      wrap.append(canvas); body.append(wrap);
      let last = null;
      return {
        update() {
          const e = nt.entry(w.cfg.topico);
          const sz = canvas.clientWidth * 1000 + canvas.clientHeight;
          if (e === last && sz === canvas._sz) return;
          last = e; canvas._sz = sz;
          drawSwerve(canvas, parseModules(e && e.value), w.cfg.vmax || 4.5);
        },
      };
    },
  },

  limelight: {
    nome: 'Mira Limelight', icone: 'crosshair', desc: 'Alvo (tx/ty) no campo de visão', tam: [5, 4],
    opcoes: [{ k: 'limelight', label: 'Nome da Limelight', tipo: 'texto', ph: 'limelight' }],
    criar(body, w) {
      const wrap = h('div', { class: 'w-canvas' }), canvas = h('canvas');
      wrap.append(canvas); body.append(wrap);
      return {
        update() {
          const n = llName(w);
          const ll = (cfg.get('limelights', []) || []).find((l) => l.nome === n) || {};
          drawTarget(canvas, { tv: nt.get(`/${n}/tv`), tx: nt.get(`/${n}/tx`), ty: nt.get(`/${n}/ty`), ta: nt.get(`/${n}/ta`), tid: nt.get(`/${n}/tid`) }, ll.fovH || 62.5, ll.fovV || 48.9);
        },
      };
    },
  },

  fms: {
    nome: 'Info da partida', icone: 'fms', desc: 'Aliança, estação, partida e modo (FMS)', tam: [5, 3],
    opcoes: [],
    criar(body) {
      const grid = h('div', { class: 'w-fms' });
      body.append(grid);
      let lastKey = '';
      return {
        update() {
          const st = nt.robotState();
          const key = JSON.stringify(st);
          if (key === lastKey) return;
          lastKey = key;
          const types = { 0: '', 1: 'Treino', 2: 'Qualificatória', 3: 'Eliminatória' };
          const stat = (k, v, cls = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'k' }, k), h('div', { class: 'v', style: { fontSize: '16px' } }, v ?? '—'));
          grid.replaceChildren(
            stat('Aliança', st.alliance ? `${st.alliance === 'red' ? 'Vermelha' : 'Azul'} ${st.station ?? ''}` : '—'),
            stat('Modo', MODE_LABEL[st.mode], st.mode === 'estop' ? 'bad' : st.enabled ? 'ok' : ''),
            stat('Partida', st.match ? `${types[st.matchType] || ''} ${st.match}` : '—'),
            stat('FMS', st.fms ? 'Conectado' : 'Não', st.fms ? 'ok' : ''),
          );
          const first = grid.firstChild;
          if (st.alliance) first.style.background = st.alliance === 'red' ? 'var(--red-soft)' : 'var(--blue-soft)';
        },
      };
    },
  },

  eventos: {
    nome: 'Linha do tempo', icone: 'events', desc: 'Tudo que aconteceu na partida', tam: [5, 6],
    opcoes: [{ k: 'vigiar', label: 'Tópicos para vigiar (um por linha)', tipo: 'topicos', hint: 'Cada mudança desses tópicos entra na linha do tempo' }],
    criar(body, w) {
      const list = h('div', { class: 'w-events' });
      body.append(list);
      const render = () => {
        if (!events.list.length) { list.replaceChildren(h('div', { class: 'empty' }, 'Nada ainda')); return; }
        list.replaceChildren(...events.list.slice(0, 80).map((ev) => h('div', { class: 'ev-row ' + ev.kind },
          h('span', { class: 't' }, ev.match != null ? fmtTime(ev.match) : ev.time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
          h('span', {}, ev.text))));
      };
      render();
      const off = events.onAdd(render);
      return { update() {}, destroy() { off(); } };
    },
  },

  checklist: {
    nome: 'Checklist', icone: 'checklist', desc: 'Lista de verificação antes da partida', tam: [5, 6],
    opcoes: [{ k: 'itens', label: 'Itens (um por linha)', tipo: 'lista', padrao: ['Bateria carregada (> 12,5 V)', 'Para-choques da cor certa', 'Autônomo selecionado', 'Limelight conectada', 'Robô na posição inicial', 'Controles conectados'] }],
    criar(body, w, ctx) {
      const list = h('div', { class: 'w-check' });
      const render = () => {
        const done = w.cfg.feitos || [];
        list.replaceChildren(...(w.cfg.itens || []).map((it, i) => {
          const cb = h('input', { type: 'checkbox', checked: !!done[i] });
          cb.addEventListener('change', () => { const d = [...(w.cfg.feitos || [])]; d[i] = cb.checked; w.cfg.feitos = d; ctx.save(); render(); });
          return h('label', { class: done[i] ? 'done' : '' }, cb, h('span', {}, it));
        }), h('button', { class: 'btn sm ghost', style: { alignSelf: 'flex-start', marginTop: '4px' }, onclick: () => { w.cfg.feitos = []; ctx.save(); render(); } }, 'Desmarcar tudo'));
      };
      render();
      body.append(list);
      return { update() {} };
    },
  },
};

// ---- desenhos -------------------------------------------------------------------
function contrast(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150 ? '#111' : '#fff';
}

function drawGraph(canvas, topics, data, now, win, fixedMin, fixedMax) {
  const { ctx, w, h: H } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, H);
  if (!topics.length) { emptyMsg(ctx, w, H, 'Configure os tópicos'); return; }
  const padL = 44, padR = 8, padT = 22, padB = 18;
  let lo = Infinity, hi = -Infinity;
  for (const arr of data) for (const [t, v] of arr) if (t >= now - win) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (fixedMin != null) lo = fixedMin;
  if (fixedMax != null) hi = fixedMax;
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const span = hi - lo;
  if (fixedMin == null) lo -= span * 0.08;
  if (fixedMax == null) hi += span * 0.08;
  const X = (t) => padL + ((t - (now - win)) / win) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  ctx.strokeStyle = cssVar('--line');
  ctx.fillStyle = cssVar('--faint');
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(Math.abs(hi - lo) < 5 ? 2 : 1), padL - 5, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let s = 0; s <= win; s += Math.max(1, Math.round(win / 5))) ctx.fillText(`-${s}s`, X(now - s), H - padB + 4);
  ctx.save();
  ctx.beginPath(); ctx.rect(padL, padT - 2, w - padL - padR, H - padT - padB + 4); ctx.clip();
  data.forEach((arr, i) => {
    if (arr.length < 1) return;
    ctx.strokeStyle = cssVar(SERIES[i]);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    arr.forEach(([t, v], k) => { if (k === 0) ctx.moveTo(X(t), Y(v)); else ctx.lineTo(X(t), Y(v)); });
    ctx.lineTo(X(now), Y(arr[arr.length - 1][1]));
    ctx.stroke();
  });
  ctx.restore();
  // legenda com valor atual
  let x = padL;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 11px system-ui';
  topics.forEach((tp, i) => {
    const arr = data[i];
    const v = arr.length ? arr[arr.length - 1][1] : null;
    const label = `${tp.split('/').pop()}: ${v == null ? '—' : fmt(v, Math.abs(v) >= 100 ? 0 : 2)}`;
    ctx.fillStyle = cssVar(SERIES[i]);
    ctx.fillRect(x, 8, 10, 3);
    ctx.fillStyle = cssVar('--text');
    ctx.fillText(label, x + 14, 10);
    x += ctx.measureText(label).width + 28;
  });
}

function emptyMsg(ctx, w, H, text) {
  ctx.fillStyle = cssVar('--faint');
  ctx.font = '12px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, H / 2);
}

function drawGauge(canvas, v, c) {
  const { ctx, w, h: H } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, H);
  const lo = c.min ?? 0, hi = c.max ?? 100;
  const r = Math.max(10, Math.min(w / 2 - 8, H * 0.72));
  const cx = w / 2, cy = Math.min(H - 10, H * 0.5 + r * 0.45);
  const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(6, r * 0.14);
  ctx.strokeStyle = cssVar('--panel-3');
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  if (isNum(v)) {
    const f = clamp((v - lo) / (hi - lo || 1), 0, 1);
    ctx.strokeStyle = cssVar('--accent');
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * f); ctx.stroke();
  }
  ctx.fillStyle = cssVar('--text');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `750 ${Math.max(12, r * 0.42)}px ui-monospace, monospace`;
  ctx.fillText(isNum(v) ? v.toFixed(c.casas ?? 1) : '—', cx, cy - r * 0.05);
  ctx.font = `600 ${Math.max(10, r * 0.17)}px system-ui`;
  ctx.fillStyle = cssVar('--muted');
  if (c.unidade) ctx.fillText(c.unidade, cx, cy + r * 0.36);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(String(lo), cx + Math.cos(a0) * r, cy + Math.sin(a0) * r + 16);
  ctx.fillText(String(hi), cx + Math.cos(a1) * r, cy + Math.sin(a1) * r + 16);
}

function parseModules(v) {
  if (!Array.isArray(v)) return null;
  if (v.length && typeof v[0] === 'object') return v.map((m) => ({ speed: m.speed, angle: m.angle }));
  const out = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push({ angle: rad(v[i]), speed: v[i + 1] });
  return out;
}

function drawSwerve(canvas, mods, vmax) {
  const { ctx, w, h: H } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, H);
  if (!mods || !mods.length) { emptyMsg(ctx, w, H, 'Sem estados dos módulos'); return; }
  const s = Math.min(w, H) * 0.62;
  const cx = w / 2, cy = H / 2;
  ctx.strokeStyle = cssVar('--line-2');
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
  ctx.fillStyle = cssVar('--accent');
  ctx.beginPath(); ctx.moveTo(cx, cy - s / 2 - 8); ctx.lineTo(cx - 6, cy - s / 2 + 2); ctx.lineTo(cx + 6, cy - s / 2 + 2); ctx.fill();
  // frente do robô para cima: FE, FD, TE, TD
  const pos = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  mods.slice(0, 4).forEach((m, i) => {
    const [px, py] = [cx + (pos[i][0] * s) / 2, cy + (pos[i][1] * s) / 2];
    // velocidade negativa = roda girando para trás: mostra a seta invertida
    const sp = m.speed || 0;
    const a = -(m.angle || 0) - Math.PI / 2 + (sp < 0 ? Math.PI : 0); // 0 rad = frente
    const len = Math.max(6, clamp(Math.abs(sp) / vmax, 0, 1) * s * 0.42);
    ctx.fillStyle = cssVar('--panel-3');
    ctx.beginPath(); ctx.arc(px, py, s * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cssVar('--cyan');
    ctx.lineWidth = 3;
    const ex = px + Math.cos(a) * len, ey = py + Math.sin(a) * len;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = cssVar('--cyan');
    ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${(m.speed || 0).toFixed(1)}`, px, py + (pos[i][1] > 0 ? s * 0.2 : -s * 0.16));
  });
}

export function drawTarget(canvas, d, fovH, fovV) {
  const { ctx, w, h: H } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, H);
  const ar = fovH / fovV;
  let bw = w - 8, bh = bw / ar;
  if (bh > H - 8) { bh = H - 8; bw = bh * ar; }
  const x0 = (w - bw) / 2, y0 = (H - bh) / 2;
  ctx.fillStyle = cssVar('--bg');
  ctx.fillRect(x0, y0, bw, bh);
  ctx.strokeStyle = cssVar('--line-2');
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, bw, bh);
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x0 + bw / 2, y0); ctx.lineTo(x0 + bw / 2, y0 + bh);
  ctx.moveTo(x0, y0 + bh / 2); ctx.lineTo(x0 + bw, y0 + bh / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const has = truthy(d.tv);
  if (has && isNum(d.tx) && isNum(d.ty)) {
    const px = x0 + bw / 2 + (d.tx / (fovH / 2)) * (bw / 2);
    const py = y0 + bh / 2 - (d.ty / (fovV / 2)) * (bh / 2);
    const r = clamp(Math.sqrt(Math.max(0, d.ta || 0)) * bw * 0.04, 5, bw * 0.2);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.strokeRect(px - r, py - r, r * 2, r * 2);
    ctx.beginPath(); ctx.moveTo(x0 + bw / 2, y0 + bh / 2); ctx.lineTo(px, py); ctx.stroke();
    ctx.fillStyle = '#22c55e';
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${isNum(d.tid) && d.tid >= 0 ? 'tag ' + d.tid + '  ' : ''}tx ${d.tx.toFixed(1)}°  ty ${d.ty.toFixed(1)}°`, x0 + 6, y0 + 14);
  } else {
    ctx.fillStyle = cssVar('--faint');
    ctx.font = '600 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(d.tv === undefined ? 'Limelight não encontrada' : 'Sem alvo', w / 2, y0 + bh / 2 - 10);
  }
}

export { deg };
