"""Leitura e escrita de arquivos: configuração, layouts do painel, rotas e
autônomos no formato do PathPlanner, gravações de partida."""

import copy
import json
import re
import shutil
import threading
import time
from pathlib import Path

PP_VERSION = "2025.0"

DEFAULT_CONFIG = {
    "equipe": 9604,
    "conexao": {"modo": "equipe", "endereco": "10.96.4.2"},
    "pathplanner": {"pasta": ""},
    "campo": {"preset": "rebuilt-2026", "comprimento": 16.541, "largura": 8.069, "imagem": None,
              "simetria": "rotacional"},
    "robo": {"largura": 0.86, "comprimento": 0.86, "tipo": "swerve"},
    "restricoes": {"maxVelocity": 3.0, "maxAcceleration": 3.0, "maxAngularVelocity": 540.0,
                   "maxAngularAcceleration": 720.0},
    "topicos": {
        "pose": "/SmartDashboard/Field/Robot",
        "tempo": "/SmartDashboard/Match Time",
        "bateria": "/SmartDashboard/Bateria",
        "resetPose": "/Copiloto/ResetPose",
        "seletorAuto": "/SmartDashboard/Auto",
        "alertas": "/SmartDashboard/Alerts",
    },
    "limelights": [{"nome": "limelight", "host": "10.96.4.11", "fovH": 62.5, "fovV": 48.9}],
    "partida": {"auto": 20, "teleop": 140, "endgame": 30},
    "gravacao": {"automatica": True},
    "aparencia": {"cor": "#f5a524", "tema": "escuro"},
    "comandos": ["Atirar", "Coletar", "Parar Coleta", "Mirar"],
}

_NAME_RE = re.compile(r'^[^/\\:*?"<>|]{1,80}$')


def deep_merge(base, extra):
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def valid_name(name):
    return isinstance(name, str) and bool(_NAME_RE.match(name)) and name.strip() == name and name not in (".", "..")


def write_json(path, data, indent=2):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=indent, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


class Files:
    def __init__(self, data_dir):
        self.data = Path(data_dir)
        self.data.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.config_path = self.data / "config.json"
        self.layouts_path = self.data / "layouts.json"
        self.recordings = self.data / "gravacoes"
        self.uploads = self.data / "uploads"
        self.trash = self.data / "lixeira"

    # ---- configuração --------------------------------------------------
    def load_config(self):
        return deep_merge(DEFAULT_CONFIG, read_json(self.config_path, {}))

    def save_config(self, cfg):
        with self._lock:
            write_json(self.config_path, deep_merge(DEFAULT_CONFIG, cfg))

    def load_layouts(self):
        return read_json(self.layouts_path, None)

    def save_layouts(self, data):
        with self._lock:
            write_json(self.layouts_path, data)

    def fields(self):
        out = []
        for f in sorted((self.data / "campos").glob("*.json"), reverse=True):
            d = read_json(f, {})
            fd = d.get("field", {})
            out.append({"id": f.stem, "nome": d.get("nome", f.stem), "comprimento": fd.get("length"),
                        "largura": fd.get("width"), "tags": len(d.get("tags", []))})
        return out

    # ---- PathPlanner ---------------------------------------------------
    def pp_dir(self, cfg=None):
        """Descobre a pasta deploy/pathplanner a partir do que o usuário digitou.

        Aceita a pasta do projeto do robô, a pasta deploy ou a própria pasta pathplanner.
        """
        cfg = cfg or self.load_config()
        raw = (cfg.get("pathplanner") or {}).get("pasta") or ""
        if not raw.strip():
            return self.data / "pathplanner", "Pasta de exemplo do Copiloto (configure a do robô em Configurações)"
        p = Path(raw.strip()).expanduser()
        candidates = [p / "src" / "main" / "deploy" / "pathplanner", p / "deploy" / "pathplanner", p / "pathplanner"]
        if p.name == "pathplanner":
            return p, "Pasta pathplanner"
        for c in candidates:
            if c.exists():
                return c, "Projeto do robô"
        if (p / "src" / "main" / "deploy").exists() or (p / "build.gradle").exists():
            return candidates[0], "Projeto do robô (a pasta pathplanner será criada)"
        if p.name == "deploy":
            return p / "pathplanner", "Pasta deploy"
        return p, "Pasta personalizada"

    def pp_info(self):
        d, desc = self.pp_dir()
        exists = d.parent.exists() or d.exists()
        return {"pasta": str(d), "descricao": desc, "existe": exists}

    def pp_list(self):
        d, _ = self.pp_dir()
        def scan(sub, ext):
            items = []
            for f in sorted((d / sub).glob("*" + ext)):
                data = read_json(f, {}) or {}
                items.append({"nome": f.stem, "pasta": data.get("folder"), "mtime": f.stat().st_mtime})
            return items
        settings = read_json(d / "settings.json", {}) or {}
        return {"paths": scan("paths", ".path"), "autos": scan("autos", ".auto"), "settings": settings,
                "info": self.pp_info()}

    def _pp_file(self, kind, name):
        if kind not in ("path", "auto") or not valid_name(name):
            raise ValueError("Nome inválido")
        d, _ = self.pp_dir()
        return d / ("paths" if kind == "path" else "autos") / f"{name}.{kind}"

    def pp_read(self, kind, name):
        f = self._pp_file(kind, name)
        data = read_json(f, None)
        if data is None:
            raise FileNotFoundError(f"{name}.{kind} não encontrado")
        return data

    def pp_save(self, kind, name, data):
        f = self._pp_file(kind, name)
        data = dict(data)
        data.setdefault("version", PP_VERSION)
        with self._lock:
            write_json(f, data)
        return str(f)

    def pp_delete(self, kind, name):
        f = self._pp_file(kind, name)
        if f.exists():
            self.trash.mkdir(parents=True, exist_ok=True)
            dest = self.trash / f"{int(time.time())}_{f.name}"
            shutil.move(str(f), dest)

    def pp_rename(self, kind, name, new):
        src, dst = self._pp_file(kind, name), self._pp_file(kind, new)
        if dst.exists():
            raise ValueError(f"Já existe {new}.{kind}")
        src.rename(dst)
        changed = []
        if kind == "path":
            # o PathPlanner também atualiza os autônomos que usam a rota
            d, _ = self.pp_dir()
            for af in (d / "autos").glob("*.auto"):
                data = read_json(af, None)
                if data and _rename_path_refs(data.get("command"), name, new):
                    write_json(af, data)
                    changed.append(af.stem)
        return changed

    def pp_command_names(self):
        """Comandos nomeados usados em qualquer rota/autônomo (para autocompletar)."""
        names = set()
        d, _ = self.pp_dir()
        for f in (d / "paths").glob("*.path"):
            for m in (read_json(f, {}) or {}).get("eventMarkers", []):
                cmd = m.get("command") or {}
                _collect_named(cmd, names)
                if m.get("name"):
                    names.add(m["name"])
        for f in (d / "autos").glob("*.auto"):
            _collect_named((read_json(f, {}) or {}).get("command"), names)
        return sorted(names)

    # ---- uploads e gravações ------------------------------------------
    def save_upload(self, name, data):
        if not re.match(r"^[\w.-]{1,60}$", name) or Path(name).suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".svg"):
            raise ValueError("Arquivo inválido (use png, jpg, webp ou svg)")
        self.uploads.mkdir(parents=True, exist_ok=True)
        dest = self.uploads / name
        dest.write_bytes(data)
        return f"/dados/uploads/{name}?v={int(time.time())}"

    def list_recordings(self):
        self.recordings.mkdir(parents=True, exist_ok=True)
        out = []
        for f in sorted(self.recordings.glob("*.jsonl"), reverse=True):
            st = f.stat()
            out.append({"arquivo": f.name, "tamanho": st.st_size, "mtime": st.st_mtime})
        return out

    def recording_path(self, name):
        if not re.match(r"^[\w .-]{1,120}\.jsonl$", name or ""):
            raise ValueError("Nome de gravação inválido")
        return self.recordings / name

    def delete_recording(self, name):
        f = self.recording_path(name)
        if f.exists():
            self.trash.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), self.trash / f.name)


def _rename_path_refs(cmd, old, new):
    if not isinstance(cmd, dict):
        return False
    changed = False
    data = cmd.get("data") or {}
    if cmd.get("type") == "path" and data.get("pathName") == old:
        data["pathName"] = new
        changed = True
    for c in data.get("commands", []) or []:
        changed = _rename_path_refs(c, old, new) or changed
    return changed


def _collect_named(cmd, names):
    if not isinstance(cmd, dict):
        return
    data = cmd.get("data") or {}
    if cmd.get("type") == "named" and data.get("name"):
        names.add(data["name"])
    for c in data.get("commands", []) or []:
        _collect_named(c, names)
