// Página "Odometria": pose do robô ao vivo, comparação com a visão,
// rastro, definir a pose clicando no campo e assistentes de calibração.

import { cfg } from '../config.js';
import { drawPolyline, drawRobot, FieldView, parseBotpose, parsePose, parsePoses, poseLikeTopics } from '../campo.js';
import { nt } from '../nt.js';
import { btn, clamp, codeBlock, cssVar, deg, field, fmt, h, icon, numInput, textInput, toast, wrapAngle } from '../util.js';

let root, fv, readout, layersEl, driftCanvas;
let trail = [];
let driftHist = [];
let lastPoseEntry = null;
let lastPose = null, lastT = null, speed = 0, travelled = 0;
let unwrapped = 0, lastRot = null;
let settingPose = null;      // { start: {x,y}, end: {x,y} } enquanto arrasta para definir pose
let poseTool = false;
const show = { trail: true, vision: true, mt1: false, target: true, active: true, objects: true };

const llName = () => (cfg.get('limelights', [])[0] || {}).nome || 'limelight';
const poseTopic = () => cfg.get('topicos.pose', '/SmartDashboard/Field/Robot');

function currentPose() {
  return parsePose(nt.get(poseTopic()), poseTopic());
}

function visionPose(key = 'botpose_orb_wpiblue') {
  const bp = parseBotpose(nt.get(`/${llName()}/${key}`));
  return bp && bp.pose ? bp : null;
}

// ---- desenho -----------------------------------------------------------------------------
function draw(ctx) {
  const p = currentPose();
  if (show.objects) {
    const table = poseTopic().split('/').slice(0, -1).join('/');
    for (const sub of nt.children(table)) {
      if (sub.startsWith('.') || sub.includes('/') || table + '/' + sub === poseTopic()) continue;
      const poses = parsePoses(nt.get(table + '/' + sub));
      if (poses.length > 1) drawPolyline(ctx, fv, poses, { color: cssVar('--cyan'), width: 2, alpha: 0.75 });
      else if (poses.length === 1) drawRobot(ctx, fv, poses[0], { ghost: true, color: cssVar('--cyan'), label: sub });
    }
  }
  if (show.active) {
    const path = parsePoses(nt.get('/PathPlanner/activePath'));
    if (path.length > 1) drawPolyline(ctx, fv, path, { color: '#f472b6', width: 3, alpha: 0.8 });
  }
  if (show.trail && trail.length > 1) drawPolyline(ctx, fv, trail, { color: cssVar('--accent'), width: 2.5, alpha: 0.55 });
  if (show.target) {
    const t = parsePose(nt.get('/PathPlanner/targetPose'));
    if (t && nt.robotState().auto) drawRobot(ctx, fv, t, { ghost: true, color: '#f472b6', label: 'Alvo' });
  }
  const seen = new Set();
  if (show.vision) {
    const v = visionPose();
    if (v) {
      drawRobot(ctx, fv, v.pose, { ghost: true, color: '#22c55e', label: 'MegaTag2' });
      // linhas até as tags vistas
      for (const f of v.fiducials) {
        seen.add(f.id);
        const tag = cfg.field.tags.find((t) => t.id === f.id);
        if (!tag) continue;
        drawPolyline(ctx, fv, [v.pose, tag], { color: '#22c55e', width: 1.2, alpha: 0.6, dash: [4, 4] });
      }
    }
  }
  if (show.mt1) {
    const v = visionPose('botpose_wpiblue');
    if (v) drawRobot(ctx, fv, v.pose, { ghost: true, color: '#eab308', label: 'MegaTag1' });
  }
  fv.highlightTags = seen;
  if (p) drawRobot(ctx, fv, p, { label: 'Odometria' });
  if (settingPose) {
    const { start, end } = settingPose;
    const a = Math.atan2(end.y - start.y, end.x - start.x);
    drawRobot(ctx, fv, { x: start.x, y: start.y, rot: Math.hypot(end.x - start.x, end.y - start.y) > 0.05 ? a : 0 }, { color: '#a78bfa', fillAlpha: 0.2, label: 'Nova pose' });
  }
}

// ---- atualização ------------------------------------------------------------------------
function track() {
  const e = nt.entry(poseTopic());
  if (e === lastPoseEntry) return false;
  lastPoseEntry = e;
  const p = parsePose(e && e.value, poseTopic());
  if (!p) return true;
  const t = e.t;
  if (lastPose && lastT != null && t > lastT) {
    const d = Math.hypot(p.x - lastPose.x, p.y - lastPose.y);
    const dt = t - lastT;
    if (d < 1) {
      speed = speed * 0.7 + (d / dt) * 0.3;
      travelled += d;
    } else trail = [];  // pulo grande = a pose foi redefinida: começa um rastro novo
  }
  if (lastRot != null) unwrapped += wrapAngle(p.rot - lastRot);
  lastRot = p.rot;
  lastPose = p; lastT = t;
  const lp = trail[trail.length - 1];
  if (!lp || Math.hypot(lp.x - p.x, lp.y - p.y) > 0.02) trail.push(p);
  if (trail.length > 1500) trail.shift();
  const v = visionPose();
  if (v) {
    driftHist.push([t, Math.hypot(v.pose.x - p.x, v.pose.y - p.y)]);
    while (driftHist.length && driftHist[0][0] < t - 30) driftHist.shift();
  }
  return true;
}

function statEl(k, v, unit, cls = '') {
  return h('div', { class: 'stat ' + cls }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', {}, unit) : null));
}

function renderReadout() {
  const p = currentPose();
  const v = visionPose();
  const items = [
    statEl('X', p ? fmt(p.x, 2) : '—', 'm'),
    statEl('Y', p ? fmt(p.y, 2) : '—', 'm'),
    statEl('Rotação', p ? fmt(deg(p.rot), 1) : '—', '°'),
    statEl('Velocidade', fmt(speed, 2), 'm/s'),
    statEl('Percorrido', fmt(travelled, 1), 'm'),
  ];
  if (v && p) {
    const err = Math.hypot(v.pose.x - p.x, v.pose.y - p.y);
    const erot = Math.abs(deg(wrapAngle(v.pose.rot - p.rot)));
    items.push(statEl('Erro p/ visão', fmt(err * 100, 0), 'cm', err > 0.3 ? 'bad' : err > 0.1 ? 'warn' : 'ok'));
    items.push(statEl('Erro ângulo', fmt(erot, 1), '°', erot > 5 ? 'bad' : erot > 2 ? 'warn' : 'ok'));
    items.push(statEl('Tags vistas', String(v.tagCount), ''));
  } else items.push(statEl('Visão', 'sem tags', ''));
  readout.replaceChildren(...items);
  drawDrift();
}

function drawDrift() {
  if (!driftCanvas) return;
  const c = driftCanvas;
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  c.width = r.width * dpr; c.height = r.height * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, H = r.height;
  ctx.clearRect(0, 0, w, H);
  const now = nt.now();
  const max = Math.max(0.2, ...driftHist.map((d) => d[1]));
  ctx.strokeStyle = cssVar('--line');
  ctx.fillStyle = cssVar('--faint');
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  for (const f of [0, 0.5, 1]) {
    const y = H - 4 - f * (H - 16);
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(`${Math.round(max * f * 100)}`, 0, y + 3);
  }
  ctx.fillText('cm', 0, 9);
  if (driftHist.length < 2) return;
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  driftHist.forEach(([t, d], i) => {
    const x = 30 + ((t - (now - 30)) / 30) * (w - 30);
    const y = H - 4 - (d / max) * (H - 16);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

// ---- definir pose -------------------------------------------------------------------------
async function sendPose(x, y, rotDeg) {
  const topic = cfg.get('topicos.resetPose', '/Copiloto/ResetPose');
  const seq = (nt.get(topic, [0, 0, 0, 0])[3] || 0) + 1;
  await nt.write(topic, 'double[]', [x, y, rotDeg, seq]);
  toast(`Pose enviada: (${x.toFixed(2)}, ${y.toFixed(2)}) ${rotDeg.toFixed(0)}°`, 'ok');
  trail = [];
}

// ---- calibração --------------------------------------------------------------------------
const calib = { dist: { start: null }, rot: { start: null } };

function calibrationCards() {
  // distância
  const distOut = h('div', { class: 'col' });
  const real = { v: 3.0 }, wheel = { v: cfg.get('calibracao.roda', 4.0) };
  const distState = h('div', { class: 'hint' }, 'Marque o início, empurre/dirija o robô em linha reta por uma distância medida com trena e marque o fim.');
  const renderDist = () => {
    const c = calib.dist;
    if (!c.start || !c.end) { distOut.replaceChildren(); return; }
    const odo = Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y);
    const factor = real.v / (odo || 1);
    distOut.replaceChildren(
      h('div', { class: 'stats' }, statEl('Odometria', fmt(odo, 3), 'm'), statEl('Real', fmt(real.v, 3), 'm'),
        statEl('Erro', fmt(((odo - real.v) / real.v) * 100, 1), '%', Math.abs(odo - real.v) / real.v > 0.03 ? 'warn' : 'ok')),
      h('div', { class: 'stats' }, statEl('Fator de correção', fmt(factor, 4), ''), statEl('Diâmetro corrigido', fmt(wheel.v * factor, 4), 'pol')),
      h('div', { class: 'hint' }, 'Multiplique o fator de conversão da roda (metros por rotação) pelo fator de correção — ou use o diâmetro corrigido. Repita 3 vezes e use a média.'),
      codeBlock(`// Diâmetro efetivo da roda medido no Copiloto\npublic static final double kWheelDiameterInches = ${(wheel.v * factor).toFixed(4)};\npublic static final double kWheelDiameterMeters = Units.inchesToMeters(kWheelDiameterInches);`));
  };
  const distCard = h('div', { class: 'card' },
    h('header', {}, icon('odometria'), h('h3', {}, 'Calibrar distância (rodas)')),
    distState,
    h('div', { class: 'grid2' },
      field('Distância real medida', numInput(real.v, (v) => { real.v = v; renderDist(); }, { step: 0.01, min: 0.1, unit: 'm' })),
      field('Diâmetro da roda no código', numInput(wheel.v, (v) => { wheel.v = v; cfg.set('calibracao.roda', v); renderDist(); }, { step: 0.001, min: 0.5, unit: 'pol' }))),
    h('div', { class: 'row' },
      btn('Marcar início', () => { const p = currentPose(); if (!p) return toast('Sem pose do robô', 'bad'); calib.dist = { start: p, end: null }; distState.textContent = `Início: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}). Agora mova o robô e marque o fim.`; renderDist(); }, { icon: 'flag' }),
      btn('Marcar fim', () => { const p = currentPose(); if (!p || !calib.dist.start) return toast('Marque o início primeiro', 'warn'); calib.dist.end = p; distState.textContent = 'Pronto! Confira o resultado:'; renderDist(); }, { icon: 'check', cls: 'primary' })),
    distOut);

  // rotação
  const turns = { v: 5 };
  const rotOut = h('div', { class: 'col' });
  const rotState = h('div', { class: 'hint' }, 'Marque o início, gire o robô no lugar algumas voltas completas (pare na mesma direção) e marque o fim.');
  const renderRot = () => {
    const c = calib.rot;
    if (c.start == null || c.end == null) { rotOut.replaceChildren(); return; }
    const measured = deg(c.end - c.start);
    const expected = 360 * turns.v * Math.sign(measured || 1);
    const factor = expected / (measured || 1);
    rotOut.replaceChildren(
      h('div', { class: 'stats' }, statEl('Medido', fmt(measured, 1), '°'), statEl('Esperado', fmt(expected, 0), '°'),
        statEl('Erro', fmt(measured - expected, 1), '°', Math.abs(measured - expected) > 3 ? 'warn' : 'ok')),
      h('div', { class: 'stats' }, statEl('Fator de escala', fmt(factor, 5), '')),
      h('div', { class: 'hint' }, 'Pigeon2/NavX: um erro grande indica giroscópio mal calibrado ou montado inclinado. Erro pequeno (< 1°) é normal.'));
  };
  const rotCard = h('div', { class: 'card' },
    h('header', {}, icon('rotate'), h('h3', {}, 'Calibrar rotação (giroscópio)')),
    rotState,
    field('Voltas completas', numInput(turns.v, (v) => { turns.v = Math.max(1, Math.round(v)); renderRot(); }, { step: 1, min: 1 })),
    h('div', { class: 'row' },
      btn('Marcar início', () => { if (lastRot == null) return toast('Sem pose do robô', 'bad'); calib.rot = { start: unwrapped, end: null }; rotState.textContent = 'Gire o robô e marque o fim.'; renderRot(); }, { icon: 'flag' }),
      btn('Marcar fim', () => { if (calib.rot.start == null) return toast('Marque o início primeiro', 'warn'); calib.rot.end = unwrapped; rotState.textContent = 'Pronto!'; renderRot(); }, { icon: 'check', cls: 'primary' })),
    rotOut);

  // código para o reset de pose
  const resetTopic = cfg.get('topicos.resetPose', '/Copiloto/ResetPose');
  const codeCard = h('div', { class: 'card' },
    h('header', {}, icon('send'), h('h3', {}, 'Código do robô: receber "Definir pose"')),
    h('div', { class: 'desc' }, 'Para o botão "Definir pose" funcionar, o robô precisa ouvir o tópico. Cole no seu subsistema de drive:'),
    codeBlock(`// Campos\nprivate final DoubleArraySubscriber resetPoseSub = NetworkTableInstance.getDefault()\n    .getDoubleArrayTopic("${resetTopic}").subscribe(new double[] {});\n\n// No periodic()\nfor (var v : resetPoseSub.readQueue()) {\n  if (v.value.length >= 3) {\n    resetPose(new Pose2d(v.value[0], v.value[1], Rotation2d.fromDegrees(v.value[2])));\n  }\n}`),
    h('div', { class: 'desc' }, 'E para o Copiloto ver o robô no campo (Field2d):'),
    codeBlock(`private final Field2d field = new Field2d();\n// no construtor:\nSmartDashboard.putData("Field", field);\n// no periodic():\nfield.setRobotPose(getPose());`));
  return h('div', { class: 'cards', style: { padding: '0 14px 14px' } }, distCard, rotCard, codeCard);
}

function sourcesCard() {
  const dlId = 'odo-topics';
  const dl = h('datalist', { id: dlId });
  const refreshDl = () => dl.replaceChildren(...poseLikeTopics(nt).map((n) => h('option', { value: n })));
  refreshDl();
  return h('div', { class: 'col' },
    field('Tópico da pose do robô', h('div', {}, textInput(poseTopic(), (v) => { cfg.set('topicos.pose', v.trim()); trail = []; lastPoseEntry = null; }, { sm: true, list: dlId }), dl),
      'Field2d (/SmartDashboard/Field/Robot), struct Pose2d ou double[] [x, y, graus]'),
    field('Tópico para "Definir pose"', textInput(cfg.get('topicos.resetPose'), (v) => cfg.set('topicos.resetPose', v.trim()), { sm: true })));
}

// ---------------------------------------------------------------------------------------
export default {
  id: 'odometria', title: 'Odometria', icon: 'odometria',

  mount(el) {
    root = el;
    const wrap = h('div', { class: 'field-wrap' });
    readout = h('div', { class: 'stats' });
    const poseBtn = btn('Definir pose', () => {
      poseTool = !poseTool;
      poseBtn.classList.toggle('on', poseTool);
      fv.canvas.style.cursor = poseTool ? 'crosshair' : 'default';
      if (poseTool) toast('Clique onde o robô está e arraste para a frente dele', '', 4000);
    }, { icon: 'target', title: 'Clique e arraste no campo para mandar a pose ao robô' });
    layersEl = h('div', { class: 'legend' },
      ...[['trail', 'Rastro', 'var(--accent)'], ['vision', 'Visão MegaTag2', '#22c55e'], ['mt1', 'Visão MegaTag1', '#eab308'], ['target', 'Alvo do PathPlanner', '#f472b6'], ['active', 'Rota ativa', '#f472b6'], ['objects', 'Outros objetos do Field2d', 'var(--cyan)']]
        .map(([k, label, color]) => {
          const cb = h('input', { type: 'checkbox', checked: show[k] });
          cb.addEventListener('change', () => { show[k] = cb.checked; fv.redraw(); });
          return h('label', {}, cb, h('i', { style: { background: color } }), label);
        }));
    const toolbar = h('div', { class: 'toolbar' },
      poseBtn,
      btn('Limpar rastro', () => { trail = []; travelled = 0; fv.redraw(); }, { icon: 'trash', cls: 'ghost' }),
      btn('', () => { fv.flipped = !fv.flipped; fv.redraw(); }, { icon: 'mirror', cls: 'ghost', title: 'Girar o campo 180° (visão da aliança vermelha)' }),
      btn('', () => fv.resetView(), { icon: 'fit', cls: 'ghost', title: 'Enquadrar' }),
      h('div', { class: 'spacer' }),
      h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Roda do mouse: zoom · arrastar: mover'));
    wrap.append(h('div', { class: 'overlay tr glass' }, layersEl));
    driftCanvas = h('canvas', { style: { width: '100%', height: '90px', display: 'block' } });
    const side = h('aside', { class: 'side right' }, h('div', { class: 'side-body', style: { paddingTop: '12px' } },
      h('div', { class: 'section-title' }, 'Pose atual'), readout,
      h('div', { class: 'section-title' }, 'Diferença odometria × visão (30 s)'), driftCanvas,
      h('div', { class: 'hint' }, 'Se a diferença cresce quando o robô anda e só cai quando ele vê tags, a odometria está escorregando: confira o diâmetro da roda, a relação de redução e a corrente das rodas.'),
      h('div', { class: 'section-title' }, 'Fontes'), sourcesCard()));
    const content = h('div', { class: 'content' }, toolbar, wrap);
    const calibWrap = h('div', { style: { overflowY: 'auto', maxHeight: '45%', borderTop: '1px solid var(--line)', background: 'var(--bg-2)' } },
      h('div', { class: 'section-title', style: { padding: '0 14px' } }, 'Calibração'), calibrationCards());
    content.append(calibWrap);
    el.append(content, side);

    fv = new FieldView(wrap, {
      onDown: (p) => {
        if (!poseTool) return false;
        settingPose = { start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y } };
        fv.redraw();
        return true;
      },
      onMove: (p) => { if (settingPose) { settingPose.end = { x: p.x, y: p.y }; fv.redraw(); } },
      onUp: () => {
        if (!settingPose) return;
        const { start, end } = settingPose;
        const moved = Math.hypot(end.x - start.x, end.y - start.y) > 0.05;
        const cur = currentPose();
        const rotDeg = moved ? deg(Math.atan2(end.y - start.y, end.x - start.x)) : cur ? deg(cur.rot) : 0;
        settingPose = null;
        poseTool = false;
        poseBtn.classList.remove('on');
        fv.canvas.style.cursor = 'default';
        sendPose(clamp(start.x, 0, cfg.field.length), clamp(start.y, 0, cfg.field.width), rotDeg);
        fv.redraw();
      },
    });
    fv.layers.push(draw);
    // o rastro e o histórico continuam sendo gravados mesmo com outra aba aberta
    nt.onUpdate((changed, removed, snapshot) => {
      if (snapshot) { trail = []; driftHist = []; lastPose = null; lastRot = null; }
      if (changed.has(poseTopic()) && track()) fv.redraw();
    });
  },

  frame(now) {
    if (!this._last || now - this._last > 150) { this._last = now; renderReadout(); fv.redraw(); }
    fv.frame();
  },
};

