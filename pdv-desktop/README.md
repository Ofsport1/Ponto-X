# Ponto X - Delivery (Electron, Windows)

Aplicativo Windows que abre o painel `pontox.sistemaultrion.com.br/admin` numa janela maximizada, com **impressão direta** dos cupons na impressora padrão do Windows (sem a janela "Imprimir"). Não tem PDV.
É o mesmo mecanismo do app da Garatucaia: o painel (`admin.js`, `printDocument`) manda o HTML do cupom para `window.pdvDesktop.printHtml` (`preload.js`) e o `main.js` imprime com `webContents.print({ silent: true })` numa janela escondida. Se o app não conseguir, o painel cai na janela de impressão normal, então o cupom não se perde.

O app só carrega o site: nenhuma chave ou lógica fica nele. Atualizar o sistema = `npx wrangler deploy` na pasta principal; o app pega a versão nova ao reabrir. **Só é preciso gerar outro instalador se mudar o próprio app** (`main.js`, `telas.js`, ícone).

## Rodar em desenvolvimento
```
cd pdv-desktop
npm install
npm start
```

## Gerar o instalador (.exe)
```
npm run dist
```
Sai em `pdv-desktop/dist/Ponto X - Delivery Setup <versão>.exe` (NSIS, um clique, sem administrador). Cria o ícone na Área de Trabalho e no Menu Iniciar. Não é assinado: o Windows pode avisar "editor desconhecido".

## Configuração (opcional)
`%APPDATA%\ponto-x-delivery\config.json`: `{ "base": "https://pontox.sistemaultrion.com.br" }` (também vale a variável `PONTOX_BASE`).

## Impressão
Defina a impressora térmica como padrão do Windows e o papel (58/80 mm) em Loja > Impressora. A impressão automática de pedidos novos continua sendo do "computador da impressora" (`print_settings.station_id`): abra o app nesse computador. Não precisa do `painel-impressora.cmd`. **Ainda não testado numa impressora física**: conferir com a "Impressão teste".

Esta pasta está em `.assetsignore`: nunca publicar como asset do Worker.
