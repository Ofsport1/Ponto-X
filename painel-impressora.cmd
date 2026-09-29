@echo off
rem Abre o painel no Chrome imprimindo DIRETO na impressora padrao (sem a janela "Imprimir").
rem Usa um perfil separado do Chrome so para o painel: funciona mesmo com outro Chrome aberto.
set URL=https://pontox.sistemaultrion.com.br/admin.html
set PERFIL=%LOCALAPPDATA%\PontoXPainelImpressora
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
  echo Nao achei o Google Chrome neste computador. Instale o Chrome e tente de novo.
  pause
  exit /b 1
)
start "" "%CHROME%" --kiosk-printing --user-data-dir="%PERFIL%" --no-first-run --app=%URL%
