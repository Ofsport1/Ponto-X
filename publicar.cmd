@echo off
chcp 65001 >nul
rem Publica o site: confere o PC, baixa o que esta no GitHub e faz o deploy.
rem Para (sem publicar nada) se o PC tiver alteracoes que nao estao no GitHub.
cd /d "%~dp0"
set BRANCH=main

echo.
echo === 1/3 Conferindo se o PC tem alteracoes fora do GitHub ===
git diff --quiet
if errorlevel 1 goto sujo
git diff --cached --quiet
if errorlevel 1 goto sujo

echo === 2/3 Baixando a versao nova do GitHub ===
git checkout %BRANCH%
if errorlevel 1 goto erro
git pull --ff-only origin %BRANCH%
if errorlevel 1 goto erro

echo === 3/3 Publicando o site ===
call npx.cmd wrangler deploy
if errorlevel 1 goto erro

echo.
echo ============================================
echo   PRONTO! Site publicado.
echo ============================================
pause
exit /b 0

:sujo
echo.
echo ATENCAO: este PC tem alteracoes que NAO estao no GitHub:
git status --short
echo.
echo Nada foi publicado. Tire uma foto desta tela e mande para o Claude.
pause
exit /b 1

:erro
echo.
echo Deu erro (veja a mensagem acima). Nada foi publicado.
echo Tire uma foto desta tela e mande para o Claude.
pause
exit /b 1
