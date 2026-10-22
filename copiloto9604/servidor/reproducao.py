"""Reprodução de partidas gravadas (.jsonl): o painel inteiro mostra os dados
como se o robô estivesse ligado, com pausa, velocidade e linha do tempo."""

import bisect
import json
import threading
import time


def read_recording(path):
    header = {}
    entries = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except ValueError:
                continue  # linha cortada (gravação interrompida)
            if i == 0 and isinstance(item, dict):
                header = item
            elif isinstance(item, list) and len(item) == 4:
                entries.append(item)
    entries.sort(key=lambda e: e[0])
    return header, entries


class ReplayBackend:
    kind = "replay"

    def __init__(self, store, path):
        self.store = store
        self.path = path
        self.header, self.entries = read_recording(path)
        self.times = [e[0] for e in self.entries]
        self.duration = self.times[-1] if self.times else 0.0
        self.pos = 0.0
        self.index = 0
        self.playing = True
        self.speed = 1.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    def describe(self):
        return f"Reprodução: {self.path.name}"

    def _publish_status(self):
        self.store.set_status(replay={
            "arquivo": self.path.name, "duracao": round(self.duration, 2), "pos": round(self.pos, 2),
            "tocando": self.playing, "velocidade": self.speed,
        })

    def start(self):
        self.store.set_status(fonte="replay", servidor=self.describe(), conectado=True, ip=None, erro=None)
        self.seek(0.0)
        self._thread = threading.Thread(target=self._loop, name="reproducao", daemon=True)
        self._thread.start()

    def _apply_until(self, t):
        while self.index < len(self.entries) and self.entries[self.index][0] <= t:
            et, name, typ, value = self.entries[self.index]
            self.store.update(name, typ, value)
            self.index += 1

    def _loop(self):
        last = time.monotonic()
        last_status = 0.0
        while not self._stop.is_set():
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if self.playing:
                    self.pos = min(self.duration, self.pos + dt * self.speed)
                    self._apply_until(self.pos)
                    if self.pos >= self.duration:
                        self.playing = False
                if now - last_status > 0.2:
                    last_status = now
                    self._publish_status()
            time.sleep(0.02)

    def seek(self, t):
        with self._lock:
            t = max(0.0, min(float(t), self.duration))
            self.store.clear()
            # aplica só o último valor de cada tópico até o instante t
            end = bisect.bisect_right(self.times, t)
            latest = {}
            for et, name, typ, value in self.entries[:end]:
                latest[name] = (typ, value)
            for name, (typ, value) in latest.items():
                self.store.update(name, typ, value)
            self.index = end
            self.pos = t
            self._publish_status()

    def control(self, cmd):
        if "seek" in cmd:
            self.seek(cmd["seek"])
        with self._lock:
            if "tocando" in cmd:
                self.playing = bool(cmd["tocando"])
                if self.playing and self.pos >= self.duration:
                    self.playing = False
            if "velocidade" in cmd:
                self.speed = max(0.1, min(8.0, float(cmd["velocidade"])))
            self._publish_status()

    def write(self, name, typ, value):
        raise RuntimeError("A reprodução é só leitura — conecte no robô ou no simulador para enviar valores")

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
