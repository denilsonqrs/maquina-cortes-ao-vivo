@echo off
rem Modo ao vivo da maquina de cortes. Exemplo:
rem   ao-vivo.bat https://www.twitch.tv/canal --crop 1500,780,420,300
cd /d "%~dp0engine"
node scripts\ao-vivo.mjs %*
pause
