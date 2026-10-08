@echo off
rem Inicia o serviço do WhatsApp da Ponto X lendo o arquivo .env desta pasta.
rem Rodar por tarefa agendada "ao iniciar o Windows" (veja docs/whatsapp-pc-loja.md).
cd /d "%~dp0"
if not exist ".env" (
  echo Falta o arquivo .env nesta pasta. Copie .env.example para .env e preencha.
  pause
  exit /b 1
)
:inicio
node --env-file=.env index.js
echo Servico parou. Reiniciando em 10 segundos...
timeout /t 10 /nobreak >nul
goto inicio
