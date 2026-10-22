"""Ponte entre a NetworkTables 4 do robô (via pyntcore) e o navegador."""

import json
import threading
import time

from . import structs

try:
    import ntcore
except ImportError:  # sem pyntcore só o simulador interno funciona
    ntcore = None

CLIENT_NAME = "Copiloto9604"


def available():
    return ntcore is not None


def convert(type_str, raw):
    """Converte o valor do ntcore para algo que vira JSON."""
    if isinstance(raw, (bytes, bytearray)):
        decoded = structs.decode(type_str, bytes(raw))
        if decoded is not None:
            return decoded
        if type_str == "json":
            try:
                return json.loads(raw.decode("utf-8"))
            except ValueError:
                pass
        return {"bytes": len(raw)}
    if type_str == "json" and isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return raw
    if isinstance(raw, tuple):
        return list(raw)
    return raw


class NTBackend:
    kind = "nt"

    def __init__(self, store, mode="equipe", team=9604, address="127.0.0.1"):
        self.store = store
        self.mode = mode
        self.team = int(team)
        self.address = address
        self.inst = None
        self._publishers = {}
        self._stop = threading.Event()
        self._thread = None

    def describe(self):
        if self.mode == "equipe":
            return f"Equipe {self.team} (10.{self.team // 100}.{self.team % 100}.2)"
        if self.mode == "local":
            return "Simulação WPILib (127.0.0.1)"
        return self.address

    def start(self):
        if ntcore is None:
            raise RuntimeError("pyntcore não está instalado (pip install pyntcore)")
        inst = ntcore.NetworkTableInstance.create()
        inst.startClient4(CLIENT_NAME)
        if self.mode == "equipe":
            inst.setServerTeam(self.team)
            inst.startDSClient()  # se o Driver Station estiver aberto, ele informa o IP do robô
        elif self.mode == "local":
            inst.setServer("127.0.0.1")
        else:
            inst.setServer(self.address)
        self.inst = inst
        # 20 atualizações por segundo: suave nos gráficos sem pesar na banda do campo
        self._msub = ntcore.MultiSubscriber(inst, [""], ntcore.PubSubOptions(periodic=0.05))
        self._poller = ntcore.NetworkTableListenerPoller(inst)
        flags = ntcore.EventFlags
        self._poller.addListener(self._msub, flags.kTopic | flags.kValueAll | flags.kImmediate)
        self.store.set_status(fonte="nt", servidor=self.describe(), conectado=False, erro=None)
        self._thread = threading.Thread(target=self._loop, name="nt-ponte", daemon=True)
        self._thread.start()

    def _loop(self):
        flags = ntcore.EventFlags
        last_conn_check = 0.0
        connected = False
        while not self._stop.is_set():
            for ev in self._poller.readQueue():
                data = ev.data
                if isinstance(data, ntcore.ValueEventData):
                    topic = data.topic
                    type_str = topic.getTypeString()
                    self.store.update(topic.getName(), type_str, convert(type_str, data.value.value()))
                elif isinstance(data, ntcore.TopicInfo) and ev.is_(flags.kUnpublish):
                    self.store.remove(data.name)
            now = time.monotonic()
            if now - last_conn_check > 0.25:
                last_conn_check = now
                is_conn = self.inst.isConnected()
                if is_conn != connected:
                    connected = is_conn
                    conns = self.inst.getConnections() if is_conn else []
                    ip = conns[0].remote_ip if conns else None
                    self.store.set_status(conectado=is_conn, ip=ip)
            time.sleep(0.005)

    def write(self, name, typ, value):
        topic = self.inst.getTopic(name)
        existing = topic.getTypeString()
        typ = existing or typ
        pub = self._publishers.get(name)
        if pub is None or pub[0] != typ:
            pub = (typ, topic.genericPublish(typ))
            self._publishers[name] = pub
        p = pub[1]
        setters = {
            "boolean": lambda v: p.setBoolean(bool(v)),
            "double": lambda v: p.setDouble(float(v)),
            "float": lambda v: p.setFloat(float(v)),
            "int": lambda v: p.setInteger(int(v)),
            "string": lambda v: p.setString(str(v)),
            "boolean[]": lambda v: p.setBooleanArray([bool(x) for x in v]),
            "double[]": lambda v: p.setDoubleArray([float(x) for x in v]),
            "float[]": lambda v: p.setFloatArray([float(x) for x in v]),
            "int[]": lambda v: p.setIntegerArray([int(x) for x in v]),
            "string[]": lambda v: p.setStringArray([str(x) for x in v]),
            "json": lambda v: p.setString(json.dumps(v)),
        }
        setter = setters.get(typ)
        if setter is None:
            raise ValueError(f"Não sei escrever o tipo {typ}")
        setter(value)
        # mostra o valor na hora, sem esperar o eco do robô
        self.store.update(name, typ, value)

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
        if self.inst is not None:
            self._publishers.clear()
            self.inst.stopDSClient()
            self.inst.stopClient()
            ntcore.NetworkTableInstance.destroy(self.inst)
            self.inst = None
