const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('signage', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  cacheMedia: (item) => ipcRenderer.invoke('cache-media', item),
  testServer: (url) => ipcRenderer.invoke('test-server', url),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  checkUpdate: () => ipcRenderer.invoke('check-update')
});
