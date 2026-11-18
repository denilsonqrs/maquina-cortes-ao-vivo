@echo off
rem Editor dos cortes brutos: escolhe o clipe, o trecho e ele monta o vertical com legenda.
cd /d "%~dp0engine"
node scripts\editar.mjs %*
pause
