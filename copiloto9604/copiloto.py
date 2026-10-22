#!/usr/bin/env python3
"""Copiloto 9604 — painel de partida, autônomo, odometria e Limelight.

Uso:
    python copiloto.py              # conecta no robô (equipe configurada)
    python copiloto.py --sim        # começa no simulador interno
    python copiloto.py --rede       # deixa tablets/celulares da rede abrirem o painel
    python copiloto.py --porta 9604 --sem-navegador
"""

import argparse
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser

if sys.version_info < (3, 9):
    sys.exit("O Copiloto precisa do Python 3.9 ou mais novo.")

from servidor import app, nt_ponte  # noqa: E402


def open_window(url):
    """Abre em modo aplicativo (janela sem abas) no Chrome/Edge; senão no navegador padrão."""
    system = platform.system()
    candidates = []
    if system == "Windows":
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
                candidates.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    elif system == "Darwin":
        candidates += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                       "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    else:
        candidates += [shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")]
    for exe in candidates:
        if exe and os.path.exists(exe):
            try:
                subprocess.Popen([exe, f"--app={url}", "--window-size=1500,900"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                pass
    webbrowser.open(url)


def local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def main():
    ap = argparse.ArgumentParser(description="Copiloto 9604")
    ap.add_argument("--porta", type=int, default=9604)
    ap.add_argument("--sim", action="store_true", help="começa no simulador interno")
    ap.add_argument("--rede", action="store_true", help="aceita conexões de outros aparelhos da rede")
    ap.add_argument("--sem-navegador", action="store_true", help="não abre a janela automaticamente")
    args = ap.parse_args()

    host = "0.0.0.0" if args.rede else "127.0.0.1"
    url = f"http://localhost:{args.porta}/"

    def ready():
        print("=" * 56)
        print("  Copiloto 9604 rodando em", url)
        if args.rede:
            for ip in local_ips():
                print(f"  Na rede: http://{ip}:{args.porta}/")
        if not nt_ponte.available():
            print("  Aviso: pyntcore não instalado — só o simulador funciona.")
            print("         Instale com:  pip install pyntcore")
        print("  Para fechar: Ctrl+C")
        print("=" * 56)
        if not args.sem_navegador:
            threading.Thread(target=lambda: (time.sleep(0.6), open_window(url)), daemon=True).start()

    try:
        app.run(host, args.porta, force_sim=args.sim, on_ready=ready)
    except OSError as e:
        if e.errno in (48, 98, 10048):
            print(f"A porta {args.porta} já está em uso — o Copiloto já está aberto? Abra {url}")
            if not args.sem_navegador:
                open_window(url)
        else:
            raise


if __name__ == "__main__":
    main()
