@echo off
REM Copiloto 9604 - inicia no Windows (clique duas vezes)
REM Na primeira vez cria a pasta .venv e instala o pyntcore (precisa de internet).
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto rodar

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m venv .venv
) else (
    python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
    echo.
    echo Nao encontrei o Python. Instale o Python 3.10 ou mais novo em https://www.python.org
    echo e marque a opcao "Add python.exe to PATH" durante a instalacao.
    pause
    exit /b 1
)
echo Instalando o pyntcore (so na primeira vez)...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt

:rodar
".venv\Scripts\python.exe" copiloto.py %*
pause
