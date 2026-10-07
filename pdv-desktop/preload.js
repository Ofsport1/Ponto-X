'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura entre o PDV (site) e o aplicativo: o site só pede para imprimir um HTML de cupom e identifica o app.
// Gaveta e balança entram aqui depois, sempre via ipcRenderer.invoke, sem expor Node ao site.
contextBridge.exposeInMainWorld('pdvDesktop', {
  isDesktop: true,
  version: '1.0.0',
  // Imprime direto na impressora padrão do Windows, sem janela. Resolve { ok, reason }.
  printHtml: html => ipcRenderer.invoke('print-html', String(html || '')),
});
