@echo off
REM Launch Lantern and open it in your browser. The Windows twin of ./lantern.
REM
REM UNTESTED ON WINDOWS. Written by mirroring the bash launcher; nobody has run
REM it on a Windows machine. See "Windows and Linux" in README.md.
setlocal
cd /d "%~dp0"

REM Keep one history rather than a second copy under .\data, mirroring the way
REM the macOS launcher points at Application Support.
if "%LANTERN_DATA%"=="" set "LANTERN_DATA=%APPDATA%\Lantern"

if "%OLLAMA_HOST%"=="" set "OLLAMA_HOST=http://127.0.0.1:11434"

if exist "%LANTERN_DATA%\settings.json" (
  findstr /c:"backend" "%LANTERN_DATA%\settings.json" | findstr /c:"openai" >nul
  if not errorlevel 1 goto run
)

where ollama >nul 2>&1
if errorlevel 1 (
  echo Ollama isn't installed. Get it from https://ollama.com/download 1>&2
  exit /b 1
)

REM Start ollama only if nothing is answering yet. curl ships with Windows 10
REM 1803 and later; if it is missing, start Ollama yourself first.
where curl >nul 2>&1
if errorlevel 1 goto run
curl -sf --max-time 2 "%OLLAMA_HOST%/api/tags" >nul 2>&1
if not errorlevel 1 goto run
echo Starting ollama serve...
start "" /b ollama serve >nul 2>&1
for /l %%i in (1,1,20) do (
  curl -sf --max-time 2 "%OLLAMA_HOST%/api/tags" >nul 2>&1
  if not errorlevel 1 goto run
  ping -n 1 -w 400 127.0.0.1 >nul
)

:run
REM `py` is the launcher installed with python.org builds; fall back to python.
where py >nul 2>&1
if errorlevel 1 (
  python server.py --open %*
) else (
  py -3 server.py --open %*
)
