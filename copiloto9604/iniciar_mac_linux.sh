#!/bin/sh
# Copiloto 9604 - inicia no macOS/Linux:  ./iniciar_mac_linux.sh
# Na primeira vez cria a pasta .venv e instala o pyntcore (precisa de internet).
cd "$(dirname "$0")" || exit 1

if [ ! -x .venv/bin/python ]; then
    if ! command -v python3 >/dev/null 2>&1; then
        echo "Não encontrei o python3. Instale o Python 3.10 ou mais novo (https://www.python.org)."
        exit 1
    fi
    python3 -m venv .venv || exit 1
    echo "Instalando o pyntcore (só na primeira vez)..."
    .venv/bin/python -m pip install --upgrade pip >/dev/null
    .venv/bin/python -m pip install -r requirements.txt
fi

exec .venv/bin/python copiloto.py "$@"
