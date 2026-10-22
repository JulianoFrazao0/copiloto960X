"""Armazena o último valor de cada tópico e entrega as mudanças para o navegador.

Cada atualização recebe um número de sequência. Cada conexão do navegador
lembra até qual número já recebeu e pede só o que mudou depois disso.
"""

import json
import math
import threading
import time
from datetime import datetime
from pathlib import Path


def sanitize(value):
    """JSON não aceita NaN/Infinito; troca por None."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [sanitize(v) for v in value]
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    return value


class Store:
    def __init__(self):
        self._lock = threading.Lock()
        self._topics = {}      # nome -> [tipo, valor, seq, t]
        self._removed = {}     # nome -> seq em que foi removido
        self._seq = 0
        self.epoch = 0         # muda quando a fonte de dados é trocada
        self.t0 = time.monotonic()
        self.status = {}
        self.status_seq = 0
        self.recorder = None

    def now(self):
        return round(time.monotonic() - self.t0, 4)

    # ---- escrita -------------------------------------------------------
    def update(self, name, typ, value, t=None):
        value = sanitize(value)
        t = self.now() if t is None else t
        with self._lock:
            self._seq += 1
            self._topics[name] = [typ, value, self._seq, t]
            self._removed.pop(name, None)
            rec = self.recorder
        if rec is not None:
            rec.write(t, name, typ, value)

    def remove(self, name):
        with self._lock:
            if self._topics.pop(name, None) is not None:
                self._seq += 1
                self._removed[name] = self._seq

    def clear(self):
        with self._lock:
            self._topics.clear()
            self._removed.clear()
            self._seq += 1
            self.epoch += 1

    def set_status(self, **kw):
        with self._lock:
            self.status.update(kw)
            self.status_seq += 1

    def reset_status(self, **kw):
        with self._lock:
            self.status = dict(kw)
            self.status_seq += 1

    def get_status(self):
        with self._lock:
            return dict(self.status), self.status_seq

    # ---- leitura -------------------------------------------------------
    def get(self, name, default=None):
        with self._lock:
            item = self._topics.get(name)
            return default if item is None else item[1]

    def snapshot(self):
        with self._lock:
            topics = {k: [v[0], v[1], v[3]] for k, v in self._topics.items()}
            return topics, self._seq, self.epoch

    def changes_since(self, seq):
        with self._lock:
            changed = {k: [v[0], v[1], v[3]] for k, v in self._topics.items() if v[2] > seq}
            removed = [k for k, s in self._removed.items() if s > seq]
            return changed, removed, self._seq, self.epoch

    def items(self):
        with self._lock:
            return [(k, v[0], v[1]) for k, v in self._topics.items()]


class Recorder:
    """Grava todas as mudanças de tópicos em um arquivo .jsonl (uma linha por valor)."""

    def __init__(self, store, folder, label=""):
        self.store = store
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        safe = "".join(c for c in label if c.isalnum() or c in "-_ ").strip().replace(" ", "_")
        self.path = folder / (f"{stamp}_{safe}.jsonl" if safe else f"{stamp}.jsonl")
        self._lock = threading.Lock()
        self._f = open(self.path, "w", encoding="utf-8")
        self.t_start = store.now()
        self.count = 0
        header = {"copiloto": 1, "inicio": datetime.now().isoformat(timespec="seconds"), "rotulo": label}
        self._f.write(json.dumps(header) + "\n")
        # valores atuais no instante zero, para a reprodução começar completa
        for name, typ, value in store.items():
            self.write(self.t_start, name, typ, value)

    def write(self, t, name, typ, value):
        line = json.dumps([round(t - self.t_start, 4), name, typ, value], separators=(",", ":"))
        with self._lock:
            if self._f is None:
                return
            self._f.write(line + "\n")
            self.count += 1

    def close(self):
        with self._lock:
            if self._f is not None:
                self._f.close()
                self._f = None

    def info(self):
        return {"arquivo": self.path.name, "duracao": round(self.store.now() - self.t_start, 1),
                "valores": self.count}
