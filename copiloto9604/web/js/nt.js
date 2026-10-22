// Cliente da NetworkTables no navegador: recebe os valores do servidor Python
// por Server-Sent Events e envia escritas por POST.

import { api, toast } from './util.js';

class NTClient {
  constructor() {
    this.topics = new Map();      // nome -> { type, value, t }
    this.status = {};
    this.online = false;          // conexão navegador <-> programa Python
    this.serverT = 0;
    this.serverTLocal = performance.now();
    this._listeners = new Set();
    this._statusListeners = new Set();
    this._lastWriteError = 0;
  }

  start() {
    const es = new EventSource('/api/stream');
    this.es = es;
    es.onopen = () => { this.online = true; this._emitStatus(); };
    es.onerror = () => { this.online = false; this._emitStatus(); };
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      this._time(d.t);
      const removed = [...this.topics.keys()];
      this.topics.clear();
      const changed = new Set();
      for (const [name, [type, value, t]] of Object.entries(d.topicos)) {
        this.topics.set(name, { type, value, t });
        changed.add(name);
      }
      this._emit(changed, removed.filter((n) => !changed.has(n)), true);
    });
    es.addEventListener('update', (e) => {
      const d = JSON.parse(e.data);
      this._time(d.t);
      const changed = new Set();
      for (const [name, [type, value, t]] of Object.entries(d.m)) {
        this.topics.set(name, { type, value, t });
        changed.add(name);
      }
      for (const name of d.r) this.topics.delete(name);
      this._emit(changed, d.r, false);
    });
    es.addEventListener('status', (e) => {
      const d = JSON.parse(e.data);
      this._time(d.t);
      this.status = d;
      this._emitStatus();
    });
    es.addEventListener('ping', (e) => this._time(JSON.parse(e.data).t));
  }

  _time(t) {
    this.serverT = t;
    this.serverTLocal = performance.now();
  }

  /** Tempo atual estimado no relógio do servidor (segundos). */
  now() {
    return this.serverT + (performance.now() - this.serverTLocal) / 1000;
  }

  _emit(changed, removed, snapshot) {
    for (const fn of this._listeners) {
      try { fn(changed, removed, snapshot); } catch (err) { console.error(err); }
    }
  }

  _emitStatus() {
    for (const fn of this._statusListeners) {
      try { fn(this.status); } catch (err) { console.error(err); }
    }
  }

  onUpdate(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  onStatus(fn) { this._statusListeners.add(fn); fn(this.status); return () => this._statusListeners.delete(fn); }

  get(name, fallback = undefined) {
    const e = this.topics.get(name);
    return e === undefined ? fallback : e.value;
  }
  entry(name) { return this.topics.get(name); }
  has(name) { return this.topics.has(name); }
  type(name) { const e = this.topics.get(name); return e ? e.type : null; }
  names() { return [...this.topics.keys()].sort((a, b) => a.localeCompare(b)); }

  /** Idade do valor em segundos (no relógio do servidor). */
  age(name) {
    const e = this.topics.get(name);
    return e ? this.now() - e.t : Infinity;
  }

  /** Subtabelas diretas de um prefixo, ex.: children('/SmartDashboard/Auto') */
  children(prefix) {
    const p = prefix.endsWith('/') ? prefix : prefix + '/';
    const out = [];
    for (const name of this.topics.keys()) if (name.startsWith(p)) out.push(name.slice(p.length));
    return out;
  }

  get connected() {
    return this.online && !!this.status.conectado;
  }

  async write(topic, type, value) {
    // mostra na hora; o servidor confirma depois
    const prev = this.topics.get(topic);
    this.topics.set(topic, { type: (prev && prev.type) || type, value, t: this.now() });
    this._emit(new Set([topic]), [], false);
    try {
      await api.post('/api/write', { topico: topic, tipo: type, valor: value });
    } catch (err) {
      if (performance.now() - this._lastWriteError > 2000) {
        this._lastWriteError = performance.now();
        toast('Não foi possível enviar: ' + err.message, 'bad');
      }
    }
  }

  // ---- estado do robô (FMSInfo) -----------------------------------------
  robotState() {
    const ctrl = this.get('/FMSInfo/FMSControlData');
    const has = typeof ctrl === 'number';
    const c = has ? ctrl : 0;
    const enabled = !!(c & 0x01), auto = !!(c & 0x02), test = !!(c & 0x04), estop = !!(c & 0x08);
    let mode = 'desconhecido';
    if (has) mode = estop ? 'estop' : !enabled ? 'disabled' : test ? 'test' : auto ? 'auto' : 'teleop';
    const red = this.get('/FMSInfo/IsRedAlliance');
    return {
      known: has, mode, enabled, auto, test, estop,
      fms: !!(c & 0x10), ds: !!(c & 0x20),
      alliance: red === true ? 'red' : red === false ? 'blue' : null,
      station: this.get('/FMSInfo/StationNumber'),
      match: this.get('/FMSInfo/MatchNumber'),
      matchType: this.get('/FMSInfo/MatchType'),
      event: this.get('/FMSInfo/EventName'),
    };
  }
}

export const nt = new NTClient();

export const MODE_LABEL = {
  disabled: 'Desabilitado', auto: 'Autônomo', teleop: 'Teleoperado', test: 'Teste', estop: 'E-STOP',
  desconhecido: 'Sem modo',
};

/** Escolhe o tipo NT a partir de um valor JS (para tópicos novos). */
export function guessType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'double';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'boolean')) return 'boolean[]';
    if (value.every((v) => typeof v === 'number')) return 'double[]';
    return 'string[]';
  }
  return 'string';
}
