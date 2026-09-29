@echo off
chcp 65001 >nul
rem Cadastra (ou troca) a senha de suporte da Ultrion na Cloudflare (secret ULTRION_PASSWORD).
rem A senha fica so na Cloudflare: nunca vai para o GitHub nem para o site.
cd /d "%~dp0"
echo.
echo Senha de suporte da Ultrion (entra como administrador em QUALQUER loja).
echo Quando aparecer "Enter a secret value", cole a senha e aperte Enter.
echo Enquanto digita ou cola, NADA aparece na tela: e normal.
echo.
call npx.cmd wrangler secret put ULTRION_PASSWORD
echo.
pause
