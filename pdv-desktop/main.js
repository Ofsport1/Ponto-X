'use strict';
const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveTela } = require('./telas');

// O app roda numa pasta de dados própria (%APPDATA%ponto-x-delivery). A configuração opcional fica em config.json:
// { "base": "https://pontox.sistemaultrion.com.br" }.
const DATA_ROOT = path.join(app.getPath('appData'), 'ponto-x-delivery');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const config = loadConfig();
const T = resolveTela(process.argv, config, process.env);
app.setPath('userData', path.join(DATA_ROOT, T.tela));

// Impressão silenciosa: o cupom sai direto na impressora padrão do Windows, sem janela de confirmação.
// O --kiosk-printing é do Chrome e não vale no Electron, então o site manda o HTML do cupom (preload: printHtml) e
// o app imprime com webContents.print({ silent: true }) numa janela escondida, sem JavaScript.
// Se algo falhar, o site volta para o jeito antigo (com janela).
if (T.silentPrint) app.commandLine.appendSwitch('kiosk-printing');

const PRINT_MAX_HTML = 3 * 1024 * 1024;

ipcMain.handle('print-html', async (event, html) => {
  if (!T.silentPrint) return { ok: false, reason: 'tela sem impressão direta' };
  // Só a página da própria loja (a que o app abriu) pode mandar imprimir.
  const from = event.senderFrame?.url || '';
  if (!from.startsWith(T.origin)) return { ok: false, reason: 'origem não permitida' };
  if (typeof html !== 'string' || !html || html.length > PRINT_MAX_HTML) return { ok: false, reason: 'cupom inválido' };

  const printer = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });

  try {
    await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    return await new Promise(resolve => {
      printer.webContents.print(
        { silent: true, printBackground: true, margins: { marginType: 'none' } },
        (ok, reason) => resolve({ ok, reason: ok ? '' : String(reason || 'falhou') }),
      );
    });
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    if (!printer.isDestroyed()) printer.destroy();
  }
});

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: T.kiosk,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    title: T.title,
    icon: path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build'), 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  if (!T.kiosk) win.maximize();
  // Mantém o nome do app na barra de tarefas, em vez do <title> da página.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadURL(T.url);

  // Sem internet: mostra tela de aviso e tenta de novo sozinho.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: T.url } });
  });

  // Só o domínio da loja abre dentro do app; qualquer outro link vai para o navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(T.origin)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(T.origin) && !url.startsWith('file:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Atalhos: F11 tela cheia, F5 recarregar, Ctrl+Shift+I só fora do modo kiosk.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F5') {
      // Na tela de "sem conexão" volta ao endereço da tela; nas demais só recarrega a página em que se está.
      if (win.webContents.getURL().startsWith('file:')) win.loadURL(T.url);
      else win.webContents.reload();
      e.preventDefault();
    } else if (!T.kiosk && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
    }
  });
}

// Uma instância por tela: abrir de novo o mesmo ícone traz a janela existente para frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
