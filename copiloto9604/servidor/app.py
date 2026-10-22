"""Servidor HTTP do Copiloto: entrega a interface web, transmite os valores da
NetworkTables em tempo real (Server-Sent Events) e salva arquivos.

Só usa a biblioteca padrão do Python; o pyntcore é opcional (sem ele, só o
simulador interno e a reprodução de gravações funcionam).
"""

import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import nt_ponte
from .arquivos import Files
from .estado import Recorder, Store
from .reproducao import ReplayBackend
from .simulador import FakeRobot, SimBackend

VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "dados"

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jsonl": "application/x-ndjson",
    ".woff2": "font/woff2",
}


class Copiloto:
    def __init__(self, force_sim=False):
        self.files = Files(DATA)
        self.store = Store()
        self.backend = None
        self.recorder = None
        self.force_sim = force_sim
        self.stopping = False
        self._lock = threading.RLock()
        self._disabled_since = None
        self._robot = None

    # ---- fonte de dados -----------------------------------------------
    def _make_robot(self):
        def autos():
            return [a["nome"] for a in self.files.pp_list()["autos"]]

        def load(kind):
            def fn(name):
                try:
                    return self.files.pp_read(kind, name)
                except (OSError, ValueError):
                    return None
            return fn
        return FakeRobot(DATA, autos, load("auto"), load("path"))

    def connect(self, mode=None):
        cfg = self.files.load_config()
        conn = cfg["conexao"]
        mode = mode or conn.get("modo", "equipe")
        if self.force_sim:
            mode, self.force_sim = "sim", False
        if mode != "sim" and not nt_ponte.available():
            mode = "sim"
            erro = "pyntcore não instalado: usando o simulador interno (pip install pyntcore)"
        else:
            erro = None
        with self._lock:
            self._stop_backend()
            self.store.clear()
            self.store.reset_status(replay=None)
            if mode == "sim":
                if self._robot is None:
                    self._robot = self._make_robot()
                backend = SimBackend(self.store, self._robot)
            else:
                backend = nt_ponte.NTBackend(self.store, mode, cfg.get("equipe", 9604), conn.get("endereco", ""))
            try:
                backend.start()
            except Exception as e:  # noqa: BLE001 - mostramos o erro na interface
                erro = str(e)
                backend = SimBackend(self.store, self._robot or self._make_robot())
                backend.start()
            self.backend = backend
            self.store.set_status(modo=mode, erro=erro, gravando=self._rec_info())

    def open_replay(self, name):
        path = self.files.recording_path(name)
        if not path.exists():
            raise FileNotFoundError("Gravação não encontrada")
        with self._lock:
            self.stop_recording()
            self._stop_backend()
            self.store.clear()
            backend = ReplayBackend(self.store, path)
            backend.start()
            self.backend = backend
            self.store.set_status(modo="replay", erro=None)

    def _stop_backend(self):
        if self.backend is not None:
            try:
                self.backend.stop()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            self.backend = None

    def write(self, name, typ, value):
        with self._lock:
            if self.backend is None:
                raise RuntimeError("Sem conexão")
            self.backend.write(name, typ, value)

    # ---- gravação de partidas ----------------------------------------
    def _rec_info(self):
        return None if self.recorder is None else {"arquivo": self.recorder.path.name,
                                                  "inicio": self.recorder.t_start}

    def start_recording(self, label=""):
        with self._lock:
            if self.recorder is not None or (self.backend and self.backend.kind == "replay"):
                return
            rec = Recorder(self.store, self.files.recordings, label)
            self.recorder = rec
            self.store.recorder = rec
            self.store.set_status(gravando=self._rec_info())

    def stop_recording(self):
        with self._lock:
            rec = self.recorder
            if rec is None:
                return None
            self.store.recorder = None
            self.recorder = None
            rec.close()
            self.store.set_status(gravando=None)
            return rec.path.name

    def tick(self):
        """Roda a cada 0,5 s: grava automaticamente quando o robô é habilitado."""
        while not self.stopping:
            time.sleep(0.5)
            try:
                backend = self.backend
                if backend is None or backend.kind != "nt":
                    continue
                cfg = self.files.load_config()
                ctrl = self.store.get("/FMSInfo/FMSControlData", 0) or 0
                enabled = bool(int(ctrl) & 0x01)
                if enabled:
                    self._disabled_since = None
                    if self.recorder is None and cfg["gravacao"].get("automatica", True):
                        self.start_recording(self._match_label(int(ctrl)))
                elif self.recorder is not None and self.recorder.store is self.store:
                    if self._disabled_since is None:
                        self._disabled_since = time.monotonic()
                    elif time.monotonic() - self._disabled_since > 8:
                        self.stop_recording()
                        self._disabled_since = None
            except Exception:  # noqa: BLE001
                traceback.print_exc()

    def _match_label(self, ctrl):
        if not ctrl & 0x10:
            return "treino"
        types = {1: "Treino", 2: "Q", 3: "Elim"}
        mtype = types.get(self.store.get("/FMSInfo/MatchType", 0), "")
        num = self.store.get("/FMSInfo/MatchNumber", 0)
        event = self.store.get("/FMSInfo/EventName", "")
        return f"{event}_{mtype}{num}".strip("_")


# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    app: Copiloto = None
    server_version = "Copiloto9604/" + VERSION

    def log_message(self, fmt, *args):  # silencioso: só erros aparecem no terminal
        pass

    # ---- utilidades ---------------------------------------------------
    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg, status=400):
        self._json({"erro": msg}, status)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _body_json(self):
        raw = self._body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _file(self, path, base):
        try:
            path = path.resolve()
            path.relative_to(base.resolve())
        except (ValueError, OSError):
            return self._error("Caminho inválido", 403)
        if not path.is_file():
            return self._error("Não encontrado", 404)
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        if path.suffix == ".jsonl":
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.end_headers()
        self.wfile.write(data)

    # ---- GET ------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        p = unquote(url.path)
        app = self.app
        try:
            if p == "/api/stream":
                return self._stream()
            if p == "/api/config":
                return self._json({"config": app.files.load_config(), "ntcore": nt_ponte.available(),
                                   "versao": VERSION, "pathplanner": app.files.pp_info(),
                                   "campos": app.files.fields()})
            if p == "/api/layouts":
                return self._json({"layouts": app.files.load_layouts()})
            if p == "/api/pp/lista":
                data = app.files.pp_list()
                data["comandos"] = app.files.pp_command_names()
                return self._json(data)
            if p in ("/api/pp/path", "/api/pp/auto"):
                return self._json({"dados": app.files.pp_read(p.rsplit("/", 1)[1], q.get("nome", ""))})
            if p == "/api/gravacoes":
                return self._json({"gravacoes": app.files.list_recordings(), "atual": app._rec_info()})
            if p.startswith("/dados/"):
                return self._file(DATA / p[len("/dados/"):], DATA)
            if p == "/":
                p = "/index.html"
            return self._file(WEB / p.lstrip("/"), WEB)
        except FileNotFoundError as e:
            return self._error(str(e), 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._error(str(e), 500)

    def _stream(self):
        store = self.app.store
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        epoch, seq, sseq = None, 0, -1
        last_ping = time.monotonic()

        def send(event, data):
            payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
            self.wfile.write(f"event: {event}\ndata: {payload}\n\n".encode("utf-8"))

        try:
            while not self.app.stopping:
                if store.epoch != epoch:
                    topics, seq, epoch = store.snapshot()
                    send("snapshot", {"t": store.now(), "topicos": topics})
                else:
                    changed, removed, new_seq, ep = store.changes_since(seq)
                    if ep == epoch:
                        seq = new_seq
                        if changed or removed:
                            send("update", {"t": store.now(), "m": changed, "r": removed})
                if store.status_seq != sseq:
                    status, sseq = store.get_status()
                    status["t"] = store.now()
                    send("status", status)
                now = time.monotonic()
                if now - last_ping > 3:
                    last_ping = now
                    send("ping", {"t": store.now()})
                self.wfile.flush()
                time.sleep(0.04)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    # ---- POST ---------------------------------------------------------
    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        p = url.path
        app = self.app
        try:
            if p == "/api/upload":
                return self._json({"url": app.files.save_upload(q.get("nome", ""), self._body())})
            body = self._body_json()
            if p == "/api/write":
                items = body if isinstance(body, list) else [body]
                for it in items:
                    app.write(it["topico"], it.get("tipo", "double"), it.get("valor"))
                return self._json({"ok": True})
            if p == "/api/config":
                old = app.files.load_config()
                app.files.save_config(body["config"])
                new = app.files.load_config()
                if (old["conexao"] != new["conexao"] or old["equipe"] != new["equipe"]) and \
                        (app.backend is None or app.backend.kind != "replay"):
                    app.connect()
                return self._json({"config": new, "pathplanner": app.files.pp_info()})
            if p == "/api/conectar":
                cfg = app.files.load_config()
                if body.get("modo"):
                    cfg["conexao"]["modo"] = body["modo"]
                if body.get("endereco"):
                    cfg["conexao"]["endereco"] = body["endereco"]
                if body.get("equipe"):
                    cfg["equipe"] = int(body["equipe"])
                app.files.save_config(cfg)
                app.connect()
                return self._json({"ok": True})
            if p == "/api/layouts":
                app.files.save_layouts(body["layouts"])
                return self._json({"ok": True})
            if p == "/api/pp/salvar":
                where = app.files.pp_save(body["tipo"], body["nome"], body["dados"])
                return self._json({"ok": True, "arquivo": where})
            if p == "/api/pp/renomear":
                changed = app.files.pp_rename(body["tipo"], body["nome"], body["novo"])
                return self._json({"ok": True, "autosAtualizados": changed})
            if p == "/api/pp/excluir":
                app.files.pp_delete(body["tipo"], body["nome"])
                return self._json({"ok": True})
            if p == "/api/gravacao/iniciar":
                app.start_recording(body.get("rotulo", "manual"))
                return self._json({"ok": True, "atual": app._rec_info()})
            if p == "/api/gravacao/parar":
                return self._json({"ok": True, "arquivo": app.stop_recording()})
            if p == "/api/gravacao/excluir":
                app.files.delete_recording(body["arquivo"])
                return self._json({"ok": True})
            if p == "/api/reproducao/abrir":
                app.open_replay(body["arquivo"])
                return self._json({"ok": True})
            if p == "/api/reproducao/controle":
                if app.backend is None or app.backend.kind != "replay":
                    return self._error("Nenhuma reprodução aberta")
                app.backend.control(body)
                return self._json({"ok": True})
            if p == "/api/reproducao/fechar":
                app.connect()
                return self._json({"ok": True})
            return self._error("Rota desconhecida", 404)
        except (KeyError, ValueError, TypeError) as e:
            return self._error(f"Pedido inválido: {e}")
        except FileNotFoundError as e:
            return self._error(str(e), 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._error(str(e), 500)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # no Windows, SO_REUSEADDR deixaria abrir dois Copilotos na mesma porta
    allow_reuse_address = os.name != "nt"


def run(host="127.0.0.1", port=9604, force_sim=False, on_ready=None):
    app = Copiloto(force_sim=force_sim)
    Handler.app = app
    httpd = Server((host, port), Handler)  # falha aqui se a porta já estiver em uso
    app.connect()
    threading.Thread(target=app.tick, name="tick", daemon=True).start()
    if on_ready:
        on_ready()
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        app.stopping = True
        app.stop_recording()
        app._stop_backend()
        httpd.server_close()
