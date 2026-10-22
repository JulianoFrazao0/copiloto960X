// Linha do tempo da partida: registra o que acontece (modo do robô, conexão,
// alertas, endgame, tópicos vigiados) para os widgets "Linha do tempo".

import { cfg } from './config.js';
import { MODE_LABEL, nt } from './nt.js';

const MAX = 300;
const listeners = new Set();
const watched = new Map();   // widgetId -> Set de tópicos
const lastBool = new Map();

export const events = {
  list: [],

  add(text, kind = '') {
    const st = nt.robotState();
    const mt = nt.get(cfg.get('topicos.tempo'));
    const ev = { text, kind, time: new Date(), match: st.enabled && typeof mt === 'number' && mt >= 0 ? mt : null };
    this.list.unshift(ev);
    if (this.list.length > MAX) this.list.length = MAX;
    for (const fn of listeners) fn(ev);
  },

  onAdd(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  clearWatched() { watched.clear(); },

  setWatched(id, topics) {
    if (!topics || !topics.length) watched.delete(id);
    else watched.set(id, new Set(topics));
  },
};

let lastMode = null, lastConn = null, lastAlerts = new Set(), endgameFired = false, brownout = false;
const alertLogged = new Map();  // alerta -> quando entrou na linha do tempo (evita repetir o que fica piscando)

function check(changed) {
  const st = nt.robotState();
  if (st.known && st.mode !== lastMode) {
    if (lastMode !== null) {
      const kind = st.mode === 'estop' ? 'bad' : st.mode === 'disabled' ? '' : 'good';
      events.add(`Robô ${MODE_LABEL[st.mode].toLowerCase()}`, kind);
    }
    lastMode = st.mode;
    if (st.mode !== 'teleop') endgameFired = false;
  }
  const mt = nt.get(cfg.get('topicos.tempo'));
  const endgame = cfg.get('partida.endgame', 30);
  if (st.mode === 'teleop' && typeof mt === 'number' && mt > 0 && mt <= endgame && !endgameFired) {
    endgameFired = true;
    events.add(`Endgame! ${Math.round(mt)} s restantes`, 'warn');
    if (cfg.get('partida.bipe')) beep();
  }
  const batt = nt.get(cfg.get('topicos.bateria'));
  if (typeof batt === 'number' && batt > 0) {
    if (batt < 7 && !brownout) { brownout = true; events.add(`Queda de tensão: ${batt.toFixed(1)} V (risco de brownout)`, 'bad'); }
    else if (batt > 9) brownout = false;
  }
  const at = cfg.get('topicos.alertas');
  if (at && (changed.has(at + '/errors') || changed.has(at + '/warnings'))) {
    const now = new Set();
    for (const [sub, kind] of [['errors', 'bad'], ['warnings', 'warn']]) {
      for (const msg of nt.get(`${at}/${sub}`, []) || []) {
        const key = sub + ':' + msg;
        now.add(key);
        const key2 = sub + ':' + msg.replace(/[\d.,]+/g, '#');
        if (!lastAlerts.has(key) && performance.now() - (alertLogged.get(key2) || -1e9) > 30000) {
          alertLogged.set(key2, performance.now());
          events.add(msg, kind);
        }
      }
    }
    lastAlerts = now;
  }
  for (const set of watched.values()) {
    for (const topic of set) {
      if (!changed.has(topic)) continue;
      const v = nt.get(topic);
      const b = typeof v === 'number' ? v !== 0 : v;
      if (lastBool.has(topic) && lastBool.get(topic) !== b) {
        const name = topic.split('/').pop();
        events.add(typeof b === 'boolean' ? `${name}: ${b ? 'SIM' : 'não'}` : `${name} = ${v}`, b === true ? 'good' : '');
      }
      lastBool.set(topic, b);
    }
  }
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.25, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.6);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.6);
  } catch (e) { /* sem áudio */ }
}

export function startEvents() {
  nt.onUpdate((changed) => check(changed));
  nt.onStatus((s) => {
    const conn = nt.online && !!s.conectado;
    if (lastConn !== null && conn !== lastConn) {
      events.add(conn ? 'Conectado ao robô' : 'Conexão com o robô perdida', conn ? 'good' : 'bad');
    }
    lastConn = conn;
  });
}
