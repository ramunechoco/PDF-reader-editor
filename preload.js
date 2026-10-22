const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('dialog:open'),
  readPdf: (filePath) => ipcRenderer.invoke('file:read', filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),
  savePdf: (filePath, bytes) => ipcRenderer.invoke('file:save', filePath, bytes),
  pickSavePath: (defaultName) => ipcRenderer.invoke('dialog:saveAs', defaultName),
  pickImage: () => ipcRenderer.invoke('dialog:openImage'),
  readFont: (name) => ipcRenderer.invoke('font:read', name),
  initialFile: () => ipcRenderer.invoke('app:initialFile'),
  setDirty: (value) => ipcRenderer.send('app:setDirty', value),
  closeNow: () => ipcRenderer.send('app:closeNow'),
  onMenu: (handler) => ipcRenderer.on('menu', (_e, name) => handler(name)),
});
