@echo off
rem Instala tudo que a maquina precisa (rode uma vez, de dentro da pasta do projeto)
cd /d "%~dp0"
if not exist config.json copy config.exemplo.json config.json
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements
winget install --id Streamlink.Streamlink -e --accept-source-agreements --accept-package-agreements
cd engine
call npm install
node scripts\_install-whisper.mjs
echo.
echo Pronto! Edite o config.json com o seu @ e coloque sua logo.png nesta pasta (opcional).
pause
