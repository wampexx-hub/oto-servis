const { contextBridge, ipcRenderer } = require('electron');

// Renderer tarafına güvenli, sınırlı bir yerel köprü sunar.
contextBridge.exposeInMainWorld('otoNative', {
  isDesktop: true,
  platform: process.platform,
  getPaths: () => ipcRenderer.invoke('oto:get-paths'),
  openDataFolder: () => ipcRenderer.invoke('oto:open-data-folder'),
  openBackupsFolder: () => ipcRenderer.invoke('oto:open-backups-folder')
});
