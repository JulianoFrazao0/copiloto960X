// Página "Configurações": conexão, robô, campo, PathPlanner, Limelights,
// tópicos, partida, aparência, backup e o código para colar no robô.

import { cfg } from '../config.js';
import { nt } from '../nt.js';
import { detectLimelights, hasLimelight } from '../visao.js';
import {
  api, btn, checkInput, codeBlock, downloadFile, field, h, icon, numInput, pickFile, selectInput, textInput, toast,
} from '../util.js';

let root, body, statusEl;
let llStatus = [];  // linhas de "recebendo dados?" de cada Limelight, atualizadas ao vivo

const FOV = [['59.6x49.7', 'Limelight 2/2+ (59,6° × 49,7°)'], ['62.5x48.9', 'Limelight 3 (62,5° × 48,9°)'], ['82x56.2', 'Limelight 3G / 4 (82° × 56,2°)']];

function card(title, ic, desc, ...children) {
  return h('div', { class: 'card' }, h('header', {}, icon(ic), h('h3', {}, title)), desc ? h('div', { class: 'desc' }, desc) : null, ...children);
}

const num = (path, opts = {}) => numInput(cfg.get(path), (v) => cfg.set(path, v), opts);
const txt = (path, opts = {}) => textInput(cfg.get(path, ''), (v) => cfg.set(path, v.trim()), opts);

function connectionCard() {
  const team = cfg.get('equipe', 9604);
  statusEl = h('div', { class: 'hint' });
  updateStatus();
  const status = statusEl;
  return card('Equipe e conexão', 'wifi', null,
    !cfg.ntcore ? h('div', { class: 'alert-row warning' }, icon('warn'), h('span', {}, 'O pyntcore não está instalado, então só o simulador funciona. No terminal: ', h('code', {}, 'pip install pyntcore'))) : null,
    h('div', { class: 'grid2' },
      field('Número da equipe', numInput(team, (v) => cfg.set('equipe', Math.round(v)), { step: 1, min: 1 })),
      field('Conectar em', selectInput(cfg.get('conexao.modo'), [['equipe', `Robô (10.${Math.floor(team / 100)}.${team % 100}.2)`], ['local', 'Simulação WPILib (127.0.0.1)'], ['ip', 'Endereço IP'], ['sim', 'Simulador interno do Copiloto']], (v) => { cfg.set('conexao.modo', v); render(); }))),
    cfg.get('conexao.modo') === 'ip' ? field('Endereço do robô', txt('conexao.endereco', { placeholder: '10.96.4.2' })) : null,
    status,
    h('div', { class: 'hint' }, 'No modo Robô, se o Driver Station estiver aberto, o Copiloto também pega o IP dele automaticamente.'));
}

function robotCard() {
  const s = cfg._ppSettings || {};
  const hasPP = s.robotWidth && s.robotLength;
  return card('Robô', 'robot', 'Medidas com para-choques; usadas para desenhar o robô no campo.',
    h('div', { class: 'grid3' },
      field('Tração', selectInput(cfg.get('robo.tipo'), [['swerve', 'Swerve'], ['mecanum', 'Mecanum'], ['diferencial', 'Diferencial (tank)']], (v) => cfg.set('robo.tipo', v))),
      field('Comprimento (frente-trás)', num('robo.comprimento', { step: 0.01, min: 0.3, unit: 'm' })),
      field('Largura', num('robo.largura', { step: 0.01, min: 0.3, unit: 'm' }))),
    hasPP ? btn(`Usar medidas do PathPlanner (${s.robotLength} × ${s.robotWidth} m)`, () => { cfg.set('robo.comprimento', s.robotLength); cfg.set('robo.largura', s.robotWidth); render(); }, { cls: 'sm', icon: 'download' }) : null);
}

function constraintsCard() {
  return card('Restrições padrão do autônomo', 'autonomo', 'Usadas nas rotas com "usar restrições padrão". Comece devagar e aumente depois de testar.',
    h('div', { class: 'grid2' },
      field('Velocidade máxima', num('restricoes.maxVelocity', { step: 0.1, min: 0.1, unit: 'm/s' })),
      field('Aceleração máxima', num('restricoes.maxAcceleration', { step: 0.1, min: 0.1, unit: 'm/s²' })),
      field('Velocidade angular máxima', num('restricoes.maxAngularVelocity', { step: 10, min: 1, unit: '°/s' })),
      field('Aceleração angular máxima', num('restricoes.maxAngularAcceleration', { step: 10, min: 1, unit: '°/s²' }))));
}

function fieldCard() {
  const preset = cfg.get('campo.preset', 'rebuilt-2026');
  const opts = cfg.campos.map((c) => [c.id, `${c.nome} (${c.comprimento} × ${c.largura} m, ${c.tags} tags)`]);
  opts.push(['personalizado', 'Personalizado']);
  const img = cfg.get('campo.imagem');
  return card('Campo', 'field', 'As AprilTags vêm do layout oficial do WPILib (campo soldado).',
    field('Jogo', selectInput(preset, opts, (v) => { cfg.set('campo.preset', v); render(); })),
    preset === 'personalizado' ? h('div', { class: 'grid2' },
      field('Comprimento', num('campo.comprimento', { step: 0.001, unit: 'm' })),
      field('Largura', num('campo.largura', { step: 0.001, unit: 'm' }))) : null,
    field('Simetria entre alianças', selectInput(cfg.get('campo.simetria', 'rotacional'), [['rotacional', 'Rotacional (2025, 2026)'], ['espelhada', 'Espelhada (2024 e antes)']], (v) => cfg.set('campo.simetria', v)),
      'Usada para "mostrar como fica no vermelho" e "duplicar espelhado"'),
    field('Imagem do campo (opcional)', h('div', { class: 'row' },
      btn(img ? 'Trocar imagem' : 'Escolher imagem…', async () => {
        const f = await pickFile('image/png,image/jpeg,image/webp,image/svg+xml');
        if (!f) return;
        try {
          const ext = (f.name.split('.').pop() || 'png').toLowerCase();
          const r = await fetch('/api/upload?nome=campo.' + ext, { method: 'POST', body: f });
          const d = await r.json();
          if (!r.ok) throw new Error(d.erro);
          cfg.set('campo.imagem', d.url);
          toast('Imagem do campo salva', 'ok');
          render();
        } catch (e) { toast('Erro ao enviar: ' + e.message, 'bad'); }
      }, { cls: 'sm', icon: 'upload' }),
      img ? btn('Remover', () => { cfg.set('campo.imagem', null); render(); }, { cls: 'sm ghost', icon: 'x' }) : null),
      'Use uma imagem recortada exatamente na borda do campo, com a aliança azul à esquerda (ex.: a do PathPlanner ou AdvantageScope).'));
}

function ppCard() {
  const info = cfg.pathplanner || {};
  const input = textInput(cfg.get('pathplanner.pasta', ''), () => {}, { placeholder: 'Ex.: C:\\Users\\equipe\\robo2026  ou  /Users/equipe/robo2026' });
  return card('PathPlanner (rotas do autônomo)', 'folder', 'Aponte para a pasta do projeto do robô. O Copiloto lê e salva em src/main/deploy/pathplanner, onde o PathPlannerLib procura.',
    field('Pasta do projeto do robô', h('div', { class: 'row' }, input,
      btn('Usar', async () => { cfg.set('pathplanner.pasta', input.value.trim(), { save: false }); await cfg.saveNow(); toast('Pasta atualizada', 'ok'); render(); }, { cls: 'primary sm' }))),
    h('div', { class: 'kv' }, h('dt', {}, 'Pasta usada'), h('dd', { style: { wordBreak: 'break-all', textAlign: 'left' } }, info.pasta || '—'),
      h('dt', {}, 'Tipo'), h('dd', { style: { textAlign: 'left' } }, info.descricao || '—'),
      h('dt', {}, 'Existe?'), h('dd', { style: { textAlign: 'left' } }, info.existe ? '✓ sim' : '✗ ainda não (será criada ao salvar)')),
    cfg.get('pathplanner.pasta') ? btn('Voltar para a pasta de exemplo', async () => { cfg.set('pathplanner.pasta', '', { save: false }); await cfg.saveNow(); render(); }, { cls: 'sm ghost' }) : null,
    h('div', { class: 'hint' }, 'Depois de mudar rotas, faça o deploy do código (./gradlew deploy) para elas irem para o robô. O PathPlanner pode continuar sendo usado junto: os arquivos são os mesmos.'));
}

function llCard() {
  const list = cfg.get('limelights', []) || [];
  const save = () => { cfg.set('limelights', list); };
  llStatus = [];
  const dl = h('datalist', { id: 'll-detectadas' }, detectLimelights().map((t) => h('option', { value: t })));
  const rows = list.map((l, i) => {
    const status = h('div', { class: 'row wrap', style: { gap: '6px', fontSize: '12px' } });
    llStatus.push({ el: status, key: '', name: () => l.nome, use: (t) => { l.nome = t; save(); render(); } });
    return h('div', { class: 'mini-item' },
      h('div', { class: 'grid3' },
        field('Nome na NetworkTables', textInput(l.nome, (v) => { l.nome = v.trim() || 'limelight'; save(); updateLlStatus(); }, { sm: true, list: 'll-detectadas' })),
        field('IP / host', textInput(l.host, (v) => { l.host = v.trim(); save(); }, { sm: true, placeholder: '10.96.4.11' })),
        field('Modelo (campo de visão)', selectInput(`${l.fovH}x${l.fovV}`, FOV, (v) => { const [a, b] = v.split('x').map(Number); l.fovH = a; l.fovV = b; save(); }, { sm: true }))),
      status,
      list.length > 1 ? btn('Remover', () => { list.splice(i, 1); save(); render(); }, { cls: 'sm ghost danger', icon: 'trash' }) : null);
  });
  updateLlStatus();
  return card('Limelights', 'limelight', 'O nome é o que aparece na interface da Limelight (padrão "limelight"; com várias, algo como "limelight-frente"). Não é o modelo: o modelo vai no campo "Modelo".',
    dl,
    ...rows,
    btn('Adicionar Limelight', () => { list.push({ nome: `limelight-${list.length + 1}`, host: `10.${Math.floor(cfg.get('equipe') / 100)}.${cfg.get('equipe') % 100}.${11 + list.length}`, fovH: 62.5, fovV: 48.9 }); save(); render(); }, { cls: 'sm', icon: 'plus' }),
    h('div', { class: 'hint' }, `Dica: IP fixo recomendado pela Limelight: 10.${Math.floor(cfg.get('equipe') / 100)}.${cfg.get('equipe') % 100}.11 a .19.`));
}

/** Mostra, para cada Limelight configurada, se chegam dados com aquele nome. */
function updateLlStatus() {
  const detected = detectLimelights();
  for (const s of llStatus) {
    const name = s.name();
    const ok = hasLimelight(name);
    const others = detected.filter((t) => t !== name);
    const key = JSON.stringify([name, ok, others, nt.connected]);
    if (key === s.key) continue;
    s.key = key;
    if (ok) s.el.replaceChildren(h('span', { style: { color: 'var(--green)' } }, `✓ Recebendo dados de /${name}`));
    else if (others.length) {
      s.el.replaceChildren(h('span', { style: { color: 'var(--yellow)' } }, `✗ Nenhuma Limelight publica como "${name}". Na rede:`),
        ...others.map((t) => btn(`usar "${t}"`, () => s.use(t), { cls: 'sm' })));
    } else {
      s.el.replaceChildren(h('span', { class: 'faint' }, nt.connected ? 'Nenhuma Limelight publicando agora (ela está ligada e na rede do robô?)' : 'Sem conexão com o robô agora.'));
    }
  }
}

function topicsCard() {
  const t = (k, label, hint) => field(label, txt('topicos.' + k, { sm: true }), hint);
  return card('Tópicos do robô', 'topicos', 'Onde o Copiloto procura cada informação. Mude se o código de vocês usa outros nomes.',
    t('pose', 'Pose do robô', 'Field2d ou struct Pose2d'),
    t('tempo', 'Tempo da partida', 'DriverStation.getMatchTime()'),
    t('bateria', 'Tensão da bateria', 'RobotController.getBatteryVoltage()'),
    t('seletorAuto', 'Seletor de autônomo', 'Tabela do SendableChooser'),
    t('alertas', 'Alertas', 'Grupo da classe Alert do WPILib'),
    t('resetPose', 'Definir pose (escrita)', 'O Copiloto escreve [x, y, graus, contador]'));
}

function matchCard() {
  return card('Partida', 'timer', null,
    h('div', { class: 'grid3' },
      field('Autônomo', num('partida.auto', { step: 1, min: 1, unit: 's' })),
      field('Teleoperado', num('partida.teleop', { step: 1, min: 1, unit: 's' })),
      field('Endgame (final)', num('partida.endgame', { step: 1, min: 0, unit: 's' }))),
    checkInput('Bipar quando começar o endgame', cfg.get('partida.bipe', false), (v) => cfg.set('partida.bipe', v)),
    h('div', { class: 'hint' }, 'Padrão REBUILT 2026: autônomo 20 s, teleoperado 140 s com endgame nos últimos 30 s.'));
}

function appearanceCard() {
  const color = h('input', { type: 'color', class: 'input', value: cfg.get('aparencia.cor', '#f5a524') });
  color.addEventListener('input', () => cfg.set('aparencia.cor', color.value));
  return card('Aparência', 'eye', null,
    h('div', { class: 'grid2' },
      field('Tema', selectInput(cfg.get('aparencia.tema', 'escuro'), [['escuro', 'Escuro'], ['claro', 'Claro']], (v) => cfg.set('aparencia.tema', v))),
      field('Cor da equipe', color)));
}

function commandsCard() {
  const ta = h('textarea', { class: 'input', rows: 5 });
  ta.value = (cfg.get('comandos', []) || []).join('\n');
  ta.addEventListener('change', () => cfg.set('comandos', ta.value.split('\n').map((s) => s.trim()).filter(Boolean)));
  return card('Comandos nomeados', 'flag', 'Aparecem como sugestão nos eventos e autônomos (os já usados nos arquivos aparecem sozinhos).', ta);
}

function backupCard() {
  return card('Backup', 'save', 'Leve as configurações e o painel para outro computador.',
    h('div', { class: 'row wrap' },
      btn('Exportar tudo', async () => {
        const layouts = (await api.get('/api/layouts')).layouts;
        downloadFile(`copiloto-${cfg.get('equipe')}-backup.json`, JSON.stringify({ copiloto: 1, config: cfg.data, layouts }, null, 2));
      }, { icon: 'download' }),
      btn('Importar…', async () => {
        const f = await pickFile('.json,application/json');
        if (!f) return;
        try {
          const d = JSON.parse(await f.text());
          if (!d.config) throw new Error('arquivo não é um backup do Copiloto');
          await api.post('/api/config', { config: d.config });
          if (d.layouts) await api.post('/api/layouts', { layouts: d.layouts });
          toast('Backup importado — recarregando…', 'ok');
          setTimeout(() => location.reload(), 800);
        } catch (e) { toast('Erro: ' + e.message, 'bad'); }
      }, { icon: 'upload' })));
}

function codeCard() {
  const t = cfg.get('topicos');
  return card('Código para o robô (Java)', 'robot', 'O mínimo para o Copiloto mostrar tudo. Coloque no RobotContainer / Robot.java.',
    h('div', { class: 'section-title' }, 'Campo (Field2d) e informações da partida'),
    codeBlock(`private final Field2d field = new Field2d();\n\npublic RobotContainer() {\n  SmartDashboard.putData("Field", field);\n}\n\n// Robot.robotPeriodic():\nfield.setRobotPose(drive.getPose());\nSmartDashboard.putNumber("Match Time", DriverStation.getMatchTime());\nSmartDashboard.putNumber("Bateria", RobotController.getBatteryVoltage());`),
    h('div', { class: 'section-title' }, 'Seletor de autônomo (PathPlannerLib)'),
    codeBlock(`// Registre os comandos nomeados ANTES de criar o seletor\nNamedCommands.registerCommand("Atirar", shooter.atirar());\nNamedCommands.registerCommand("Coletar", intake.coletar());\n\nautoChooser = AutoBuilder.buildAutoChooser();\nSmartDashboard.putData("Auto", autoChooser);\n\npublic Command getAutonomousCommand() {\n  return autoChooser.getSelected();\n}`),
    h('div', { class: 'section-title' }, 'Alertas (aparecem no widget Alertas)'),
    codeBlock(`private final Alert semAuto = new Alert("Nenhum autônomo selecionado", AlertType.kWarning);\n// no periodic:\nsemAuto.set(autoChooser.getSelected() == null);`),
    h('div', { class: 'hint' }, `Tópicos configurados: pose ${t.pose}, tempo ${t.tempo}, bateria ${t.bateria}.`));
}

function aboutCard() {
  return card('Sobre', 'info', null,
    h('div', { class: 'kv' },
      h('dt', {}, 'Versão'), h('dd', {}, cfg.versao),
      h('dt', {}, 'pyntcore'), h('dd', {}, cfg.ntcore ? 'instalado ✓' : 'não instalado'),
      h('dt', {}, 'Atalhos'), h('dd', {}, 'Alt+1…7 abas · E editar painel · Espaço prévia')));
}

function updateStatus() {
  if (!statusEl) return;
  const s = nt.status;
  statusEl.textContent = !nt.online ? 'Programa Python desconectado.' : s.fonte === 'sim' ? 'Usando o simulador interno.' : s.fonte === 'replay' ? 'Reproduzindo uma gravação.' : s.conectado ? `Conectado: ${s.servidor} (${s.ip || ''})` : `Procurando: ${s.servidor}…`;
}

async function render() {
  try { cfg._ppSettings = (await api.get('/api/pp/lista')).settings; } catch (e) { cfg._ppSettings = {}; }
  body.replaceChildren(
    h('h2', {}, 'Configurações'),
    h('div', { class: 'cards masonry' }, connectionCard(), robotCard(), ppCard(), fieldCard(), constraintsCard(), llCard(), topicsCard(), matchCard(), appearanceCard(), commandsCard(), backupCard(), aboutCard()),
    codeCard());
}

export default {
  id: 'configuracoes', title: 'Configurações', icon: 'config',
  mount(el) {
    root = el;
    body = h('div', { class: 'inner' });
    el.append(h('div', { class: 'scroll-page' }, body));
    nt.onStatus(updateStatus);
    render();
  },
  show() { if (root) render(); },
  frame(now) {
    if (!this._ll || now - this._ll > 1000) { this._ll = now; updateLlStatus(); }
  },
};
