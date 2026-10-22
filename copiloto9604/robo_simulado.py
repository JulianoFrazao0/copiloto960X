#!/usr/bin/env python3
"""Robô simulado de verdade na rede: sobe um servidor NetworkTables 4 em
127.0.0.1 publicando os mesmos tópicos do simulador interno.

Serve para testar o Copiloto (ou o Shuffleboard/AdvantageScope) pelo caminho
real da NetworkTables, sem robô. No Copiloto, escolha a conexão
"Simulação WPILib (127.0.0.1)".

    python robo_simulado.py
"""

import tempfile
import time
from pathlib import Path

try:
    import ntcore
except ImportError:
    raise SystemExit("Instale o pyntcore primeiro:  pip install pyntcore")

from servidor import structs
from servidor.app import DATA, Copiloto

WATCH = ["/SmartDashboard/Auto/selected", "/limelight/pipeline", "/limelight/ledMode",
         "/limelight/camMode", "/limelight/priorityid", "/Copiloto/ResetPose", "/Copiloto/Sim/Modo"]


def main():
    robot = Copiloto()._make_robot()
    inst = ntcore.NetworkTableInstance.getDefault()
    # o servidor NT guarda valores persistentes num arquivo; deixa fora da pasta do Copiloto
    inst.startServer(str(Path(tempfile.gettempdir()) / "copiloto-robo-simulado.json"))
    pubs = {}
    last = {}

    def publish(name, typ, value):
        if last.get(name) == value:
            return
        last[name] = value
        pub = pubs.get(name)
        if pub is None:
            pub = pubs[name] = inst.getTopic(name).genericPublish(typ)
        if typ.startswith("struct:"):
            pub.setRaw(structs.encode(typ, value))
        elif typ == "double":
            pub.setDouble(value)
        elif typ == "int":
            pub.setInteger(value)
        elif typ == "boolean":
            pub.setBoolean(value)
        elif typ == "string":
            pub.setString(value)
        elif typ == "double[]":
            pub.setDoubleArray(value)
        elif typ == "string[]":
            pub.setStringArray(value)

    poller = ntcore.NetworkTableListenerPoller(inst)
    subs = [ntcore.MultiSubscriber(inst, WATCH)]
    poller.addListener(subs[0], ntcore.EventFlags.kValueRemote)

    print("Robô simulado rodando: NetworkTables em 127.0.0.1 (Ctrl+C para sair)")
    print(f"Lendo rotas/autônomos de {DATA / 'pathplanner'} (ou da pasta configurada no Copiloto)")
    t_last = time.monotonic()
    try:
        while True:
            for ev in poller.readQueue():
                d = ev.data
                if isinstance(d, ntcore.ValueEventData):
                    v = d.value.value()
                    robot.on_write(d.topic.getName(), list(v) if isinstance(v, (list, tuple)) else v)
            now = time.monotonic()
            for name, typ, value in robot.step(max(1e-3, now - t_last)):
                publish(name, typ, value)
            t_last = now
            time.sleep(0.02)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
