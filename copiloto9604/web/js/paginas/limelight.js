// Página "Limelight": estado, vídeo, controles (pipeline, LED, modo), pose
// MegaTag no campo, calculadora de distância e pose da câmera no robô.

import { cfg } from '../config.js';
import { drawPolyline, drawRobot, FieldView, parseBotpose, parsePose } from '../campo.js';
import { nt } from '../nt.js';
import { btn, codeBlock, deg, field, fmt, fmtValue, h, icon, numInput, rad, selectInput, toast } from '../util.js';
import { drawTarget } from '../widgets.js';

let root, body, fv, camImg, camMsg, camOverlay, statsEl, rawEl, distOut, selEl;
let llIndex = 0;
let hbLast = null, hbChanged = 0;
let streaming = false;
let retryTimer = null;

const lls = () => cfg.get('limelights', []) || [];
const ll = () => lls()[llIndex] || { nome: 'limelight', host: '10.96.4.11' };
const T = (k) => `/${ll().nome}/${k}`;
const get = (k) => nt.get(T(k));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function connected() {
  const hb = get('hb');
  const now = performance.now();
  if (hb !== hbLast) { hbLast = hb; hbChanged = now; }
  return hb !== undefined && now - hbChanged < 1500;
}

function write(key, value) {
  if (nt.status.fonte === 'replay') { toast('Na reprodução não dá para enviar comandos', 'warn'); return; }
  nt.write(T(key), Array.isArray(value) ? 'double[]' : 'double', value);
}

// ---- vídeo ---------------------------------------------------------------------------------
function streamUrl() { return `http://${ll().host || 'limelight.local'}:5800/stream.mjpg`; }

function setStreaming(on) {
  streaming = on;
  clearTimeout(retryTimer);
  if (!on) { camImg.removeAttribute('src'); camMsg.textContent = 'Vídeo pausado (economiza banda do rádio).'; camMsg.classList.remove('hidden'); return; }
  camMsg.textContent = `Conectando a ${streamUrl()}…`;
  camMsg.classList.remove('hidden');
  camImg.src = streamUrl() + '?t=' + Date.now();
}

// ---- controles ------------------------------------------------------------------------------
function segButtons(key, options, current) {
  return h('div', { class: 'seg full' }, options.map(([v, label]) => h('button', {
    class: current === v ? 'on' : '', onclick: () => { write(key, v); setTimeout(renderControls, 80); },
  }, label)));
}

let controlsEl;
function renderControls() {
  if (!controlsEl) return;
  const pipe = get('getpipe');
  const led = nt.get(T('ledMode'));
  const cam = nt.get(T('camMode'));
  const stream = nt.get(T('stream'));
  controlsEl.replaceChildren(
    field('Pipeline', h('div', { class: 'pipes' }, [...Array(10).keys()].map((i) => btn(String(i), () => { write('pipeline', i); setTimeout(renderControls, 150); }, { cls: 'sm' + (pipe === i ? ' primary' : '') }))), 'Pipeline ativa no momento: ' + (isNum(pipe) ? pipe : '—')),
    field('LEDs', segButtons('ledMode', [[0, 'Da pipeline'], [1, 'Desligado'], [2, 'Piscar'], [3, 'Ligado']], led ?? 0)),
    field('Modo da câmera', segButtons('camMode', [[0, 'Visão'], [1, 'Motorista']], cam ?? 0), 'Motorista: aumenta a exposição e para o processamento'),
    field('Imagem do vídeo', segButtons('stream', [[0, 'Lado a lado'], [1, 'PiP principal'], [2, 'PiP secundária']], stream ?? 0), 'Só faz diferença com câmera USB extra'),
    h('div', { class: 'grid2' },
      field('Tag prioritária (priorityid)', numInput(nt.get(T('priorityid')) ?? -1, (v) => write('priorityid', Math.round(v)), { step: 1, sm: true }), '-1 = nenhuma; tx/ty mira nela'),
      field('Modo do IMU (só LL4)', selectInput(nt.get(T('imumode_set')) ?? 0, [[0, '0 — IMU do robô'], [1, '1 — robô, semeia interno'], [2, '2 — IMU interno'], [3, '3 — interno + MT1'], [4, '4 — interno + robô']], (v) => write('imumode_set', +v), { sm: true }))));
}

// ---- estado -------------------------------------------------------------------------------
function stat(k, v, unit = '', cls = '') {
  return h('div', { class: 'stat ' + cls }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', {}, unit) : null));
}

function renderStats() {
  const conn = connected();
  const tv = get('tv');
  const bp = parseBotpose(get('botpose_orb_wpiblue')) || parseBotpose(get('botpose_wpiblue'));
  const lat = (get('tl') || 0) + (get('cl') || 0);
  statsEl.replaceChildren(
    stat('Status', conn ? 'Online' : get('hb') === undefined ? 'Não encontrada' : 'Travada', '', conn ? 'ok' : 'bad'),
    stat('Pipeline', isNum(get('getpipe')) ? String(get('getpipe')) : '—'),
    stat('Latência', isNum(get('tl')) ? fmt(lat, 0) : '—', 'ms', lat > 60 ? 'warn' : ''),
    stat('Alvo', tv === 1 || tv === true ? 'SIM' : 'não', '', tv === 1 || tv === true ? 'ok' : ''),
    stat('Tag (tid)', isNum(get('tid')) && get('tid') >= 0 ? String(get('tid')) : '—'),
    stat('tx', isNum(get('tx')) ? fmt(get('tx'), 2) : '—', '°'),
    stat('ty', isNum(get('ty')) ? fmt(get('ty'), 2) : '—', '°'),
    stat('ta', isNum(get('ta')) ? fmt(get('ta'), 2) : '—', '%'),
    stat('Tags na imagem', bp ? String(bp.tagCount) : '0'),
    stat('Dist. média', bp && bp.avgDist ? fmt(bp.avgDist, 2) : '—', 'm'),
  );
  // câmera: caixas das tags sobre o vídeo
  const ctx = camOverlay.getContext('2d');
  const r = camOverlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  camOverlay.width = r.width * dpr; camOverlay.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  if (bp && streaming) {
    const fovH = ll().fovH || 62.5, fovV = ll().fovV || 48.9;
    for (const f of bp.fiducials) {
      const x = r.width / 2 + (f.txnc / (fovH / 2)) * (r.width / 2);
      const y = r.height / 2 - (f.tync / (fovV / 2)) * (r.height / 2);
      const s = Math.max(10, Math.sqrt(f.ta || 0.1) * r.width * 0.05);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - s, y - s, s * 2, s * 2);
      ctx.fillStyle = '#22c55e';
      ctx.font = '700 12px ui-monospace, monospace';
      ctx.fillText(`#${f.id} ${fmt(f.distCam, 2)}m`, x - s, y - s - 4);
    }
  }
}

function renderRaw() {
  const prefix = `/${ll().nome}/`;
  const rows = nt.names().filter((n) => n.startsWith(prefix)).map((n) => h('tr', {},
    h('td', { class: 'mono', style: { fontSize: '12px' } }, n.slice(prefix.length)),
    h('td', { class: 'mono faint', style: { fontSize: '11px' } }, nt.type(n)),
    h('td', { class: 'mono', style: { fontSize: '12px', maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, fmtValue(nt.get(n)))));
  rawEl.replaceChildren(rows.length ? h('table', { class: 'tbl' }, h('tbody', {}, rows)) : h('div', { class: 'empty' }, `Nenhum tópico ${prefix}. Confira o nome da Limelight (Configurações > Limelights).`));
}

// ---- calculadora de distância -----------------------------------------------------------
const calc = () => cfg.get('limelightCalc', { hCam: 0.5, hAlvo: 1.124, angulo: 20 }) || {};

function renderDistance() {
  const c = calc();
  const ty = get('ty');
  const has = get('tv') === 1 && isNum(ty);
  const d = has ? (c.hAlvo - c.hCam) / Math.tan(rad(c.angulo + ty)) : null;
  distOut.replaceChildren(
    h('div', { class: 'stats' }, stat('Distância (ty)', d != null && d > 0 ? fmt(d, 2) : '—', 'm', d != null && d > 0 ? 'ok' : ''), stat('ty agora', has ? fmt(ty, 2) : '—', '°')));
}

function distanceCard() {
  const c = calc();
  const set = (k) => (v) => { cfg.set('limelightCalc', { ...calc(), [k]: v }); renderDistance(); };
  const realD = { v: 2.0 };
  const result = h('div', {});
  distOut = h('div', {});
  return h('div', { class: 'card' },
    h('header', {}, icon('crosshair'), h('h3', {}, 'Distância até o alvo (pelo ty)')),
    h('div', { class: 'desc' }, 'Para mirar sem MegaTag: distância = (altura do alvo − altura da câmera) / tan(ângulo da câmera + ty).'),
    h('div', { class: 'grid3' },
      field('Altura da câmera', numInput(c.hCam, set('hCam'), { step: 0.01, unit: 'm' })),
      field('Altura do alvo', numInput(c.hAlvo, set('hAlvo'), { step: 0.01, unit: 'm' })),
      field('Ângulo da câmera', numInput(c.angulo, set('angulo'), { step: 0.1, unit: '°' }))),
    distOut,
    h('div', { class: 'section-title' }, 'Descobrir o ângulo da câmera'),
    h('div', { class: 'desc' }, 'Coloque o robô a uma distância medida do alvo, com o alvo à vista, e clique em calcular.'),
    h('div', { class: 'row' }, h('div', { style: { width: '140px' } }, numInput(realD.v, (v) => { realD.v = v; }, { step: 0.01, min: 0.2, unit: 'm' })),
      btn('Calcular ângulo', () => {
        const ty = get('ty');
        if (!(get('tv') === 1 && isNum(ty))) return toast('A Limelight precisa estar vendo o alvo', 'warn');
        const cc = calc();
        const ang = deg(Math.atan((cc.hAlvo - cc.hCam) / realD.v)) - ty;
        cfg.set('limelightCalc', { ...cc, angulo: Math.round(ang * 100) / 100 });
        result.replaceChildren(h('div', { class: 'hint', style: { color: 'var(--green)' } }, `Ângulo calculado: ${ang.toFixed(2)}° (já salvo acima).`));
        renderBody();
      }, { cls: 'primary', icon: 'target' })),
    result,
    codeBlock(`// Constantes medidas no Copiloto\nstatic final double kCameraHeightM = ${c.hCam};\nstatic final double kTargetHeightM = ${c.hAlvo};\nstatic final double kCameraPitchDeg = ${c.angulo};\n\ndouble distanceToTarget() {\n  double ty = LimelightHelpers.getTY("${ll().nome}");\n  return (kTargetHeightM - kCameraHeightM) / Math.tan(Math.toRadians(kCameraPitchDeg + ty));\n}`));
}

// ---- pose da câmera no robô ---------------------------------------------------------------
function cameraPoseCard() {
  const cur = get('camerapose_robotspace');
  const v = Array.isArray(cur) && cur.length >= 6 ? [...cur.slice(0, 6)] : [0.3, 0, 0.5, 0, 20, 0];
  const labels = [['Frente', 'm'], ['Lado (esq. +)', 'm'], ['Altura', 'm'], ['Roll', '°'], ['Pitch', '°'], ['Yaw', '°']];
  const code = h('div');
  const renderCode = () => code.replaceChildren(codeBlock(`LimelightHelpers.setCameraPose_RobotSpace("${ll().nome}",\n    ${v.map((x) => (+x).toFixed(3)).join(', ')});\n// frente, lado, altura (m), roll, pitch, yaw (°)`));
  renderCode();
  return h('div', { class: 'card' },
    h('header', {}, icon('robot'), h('h3', {}, 'Posição da câmera no robô')),
    h('div', { class: 'desc' }, 'Essencial para o MegaTag: medida a partir do centro do robô, no chão. Pitch positivo = câmera olhando para cima.'),
    h('div', { class: 'grid3' }, labels.map(([l, u], i) => field(l, numInput(fmt(v[i], 3), (x) => { v[i] = x; renderCode(); }, { step: u === 'm' ? 0.01 : 0.5, unit: u })))),
    h('div', { class: 'row' },
      btn('Enviar para a Limelight', () => { write('camerapose_robotspace_set', v.map(Number)); toast('Pose da câmera enviada (não fica salva na Limelight ao reiniciar — use o código abaixo)', 'ok', 5000); }, { cls: 'primary', icon: 'send' }),
      btn('Ler da Limelight', () => renderBody(), { icon: 'download' })),
    code);
}

function megatagCard() {
  return h('div', { class: 'card' },
    h('header', {}, icon('field'), h('h3', {}, 'Código: odometria + MegaTag2')),
    h('div', { class: 'desc' }, 'MegaTag2 precisa receber a rotação do robô a cada ciclo. No periodic() do drive:'),
    codeBlock(`LimelightHelpers.SetRobotOrientation("${ll().nome}",\n    poseEstimator.getEstimatedPosition().getRotation().getDegrees(), 0, 0, 0, 0, 0);\nvar mt2 = LimelightHelpers.getBotPoseEstimate_wpiBlue_MegaTag2("${ll().nome}");\nboolean girandoRapido = Math.abs(gyro.getAngularVelocityZWorld().getValueAsDouble()) > 720;\nif (mt2 != null && mt2.tagCount > 0 && !girandoRapido) {\n  poseEstimator.setVisionMeasurementStdDevs(VecBuilder.fill(0.7, 0.7, 9999999));\n  poseEstimator.addVisionMeasurement(mt2.pose, mt2.timestampSeconds);\n}`));
}

// ---- montagem ------------------------------------------------------------------------------
function renderHeader() {
  const names = lls().map((l, i) => [i, l.nome]);
  selEl.replaceChildren(
    names.length > 1 ? selectInput(llIndex, names, (v) => { llIndex = +v; renderBody(); }, { sm: true }) : h('b', {}, ll().nome),
    h('span', { class: 'faint mono', style: { fontSize: '12px' } }, ll().host),
    h('a', { href: `http://${ll().host}:5801`, target: '_blank', class: 'btn sm ghost' }, icon('link'), 'Abrir interface da Limelight'),
    h('div', { class: 'spacer' }),
    h('a', { href: '#configuracoes', class: 'btn sm ghost' }, icon('gear'), 'Nomes e IPs'));
}

function renderBody() {
  renderHeader();
  const camBox = h('div', { class: 'll-cam' });
  camImg = h('img', { alt: '' });
  camMsg = h('div', { class: 'msg' });
  camOverlay = h('canvas');
  camImg.onload = () => camMsg.classList.add('hidden');
  camImg.onerror = () => {
    if (!streaming) return;
    camMsg.textContent = `Sem vídeo em ${streamUrl()}. A Limelight está ligada e na rede? Tentando de novo…`;
    camMsg.classList.remove('hidden');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => streaming && (camImg.src = streamUrl() + '?t=' + Date.now()), 3000);
  };
  camBox.append(camImg, camOverlay, camMsg);
  const streamBtn = btn(streaming ? 'Pausar vídeo' : 'Ver vídeo', () => { setStreaming(!streaming); streamBtn.lastChild.textContent = streaming ? 'Pausar vídeo' : 'Ver vídeo'; }, { cls: 'sm', icon: 'camera' });
  statsEl = h('div', { class: 'stats' });
  controlsEl = h('div', { class: 'col', style: { gap: '12px' } });
  rawEl = h('div', { style: { maxHeight: '320px', overflowY: 'auto' } });
  const mini = h('div', { class: 'field-wrap', style: { height: '260px', flex: 'none', borderRadius: '8px' } });
  const targetCanvas = h('canvas', { style: { width: '100%', height: '150px', display: 'block' } });
  const left = h('div', { class: 'col', style: { gap: '14px' } },
    h('div', { class: 'card' }, h('header', {}, icon('camera'), h('h3', {}, 'Câmera'), streamBtn), camBox,
      h('div', { class: 'hint' }, 'O vídeo usa banda do rádio (limite de banda no campo). Pause quando não precisar.')),
    h('div', { class: 'card' }, h('header', {}, icon('gear'), h('h3', {}, 'Controles')), controlsEl),
    distanceCard(),
    cameraPoseCard());
  const right = h('div', { class: 'col', style: { gap: '14px' } },
    h('div', { class: 'card' }, h('header', {}, icon('info'), h('h3', {}, 'Estado')), statsEl, targetCanvas),
    h('div', { class: 'card' }, h('header', {}, icon('field'), h('h3', {}, 'Pose pela visão'), h('span', { class: 'legend', style: { flexDirection: 'row', gap: '10px' } },
      h('label', {}, h('i', { style: { background: 'var(--accent)' } }), 'Odometria'), h('label', {}, h('i', { style: { background: '#22c55e' } }), 'MT2'), h('label', {}, h('i', { style: { background: '#eab308' } }), 'MT1'))), mini),
    megatagCard(),
    h('div', { class: 'card' }, h('header', {}, icon('topicos'), h('h3', {}, 'Todos os valores')), rawEl));
  body.replaceChildren(left, right);
  if (fv) fv.destroy();
  fv = new FieldView(mini, { padding: 8, labels: false });
  fv.layers.push((ctx) => {
    const mt2 = parseBotpose(get('botpose_orb_wpiblue'));
    const mt1 = parseBotpose(get('botpose_wpiblue'));
    const odo = parsePose(nt.get(cfg.get('topicos.pose')), cfg.get('topicos.pose'));
    const seen = new Set();
    if (mt1 && mt1.pose) drawRobot(ctx, fv, mt1.pose, { ghost: true, color: '#eab308' });
    if (mt2 && mt2.pose) {
      drawRobot(ctx, fv, mt2.pose, { ghost: true, color: '#22c55e' });
      for (const f of mt2.fiducials) {
        seen.add(f.id);
        const tag = cfg.field.tags.find((t) => t.id === f.id);
        if (tag) drawPolyline(ctx, fv, [mt2.pose, tag], { color: '#22c55e', width: 1.2, alpha: 0.6, dash: [4, 4] });
      }
    }
    fv.highlightTags = seen;
    if (odo) drawRobot(ctx, fv, odo, {});
  });
  root._target = targetCanvas;
  renderControls();
  renderRaw();
  renderDistance();
  if (streaming) setStreaming(true); else setStreaming(false);
}

export default {
  id: 'limelight', title: 'Limelight', icon: 'limelight',

  mount(el) {
    root = el;
    selEl = h('div', { class: 'toolbar' });
    body = h('div', { class: 'll-grid' });
    el.append(h('div', { class: 'content' }, selEl, body));
    renderBody();
    cfg.onChange((p) => { if (p && p.startsWith('limelights')) { llIndex = Math.min(llIndex, Math.max(0, lls().length - 1)); renderBody(); } });
  },

  hide() { if (streaming) setStreaming(false); },

  frame(now) {
    if (!this._t || now - this._t > 120) {
      this._t = now;
      renderStats();
      drawTarget(root._target, { tv: get('tv'), tx: get('tx'), ty: get('ty'), ta: get('ta'), tid: get('tid') }, ll().fovH || 62.5, ll().fovV || 48.9);
      renderDistance();
      fv.redraw();
    }
    if (!this._raw || now - this._raw > 500) { this._raw = now; renderRaw(); if (document.activeElement?.closest?.('#page-limelight .pipes, #page-limelight .seg') == null) renderControlsSoft(); }
    fv.frame();
  },
};

let lastCtlKey = '';
function renderControlsSoft() {
  const key = JSON.stringify([get('getpipe'), nt.get(T('ledMode')), nt.get(T('camMode')), nt.get(T('stream'))]);
  if (key !== lastCtlKey && !(controlsEl && controlsEl.contains(document.activeElement))) { lastCtlKey = key; renderControls(); }
}

