const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  tools: () => ipcRenderer.invoke('tools:list'),
  checkTool: (id) => ipcRenderer.invoke('tool:check', id),
  installTool: (id) => ipcRenderer.invoke('tool:install', id),
  cancelInstall: (id) => ipcRenderer.invoke('tool:cancel-install', id),
  openToolFolder: (id, kind) => ipcRenderer.invoke('tool:open-folder', id, kind),
  onInstallProgress: (cb) => {
    const handler = (e, d) => cb(d)
    ipcRenderer.on('install:progress', handler)
    return () => ipcRenderer.removeListener('install:progress', handler)
  },
  onInstallDone: (cb) => {
    const handler = (e, d) => cb(d)
    ipcRenderer.on('install:done', handler)
    return () => ipcRenderer.removeListener('install:done', handler)
  },
  terminalStart: (id, cols, rows, pixelWidth, pixelHeight) => ipcRenderer.invoke('terminal:start', id, cols, rows, pixelWidth, pixelHeight),
  terminalStop: () => ipcRenderer.invoke('terminal:stop'),
  onPtyData: (cb) => {
    const handler = (e, d) => cb(d)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onPtyExit: (cb) => {
    const handler = (e, d) => cb(d)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows, pixelWidth, pixelHeight) => ipcRenderer.send('pty:resize', cols, rows, pixelWidth, pixelHeight),
  openToolWindow: (toolId) => ipcRenderer.invoke('window:open-tool', toolId),
  closeWindow: () => ipcRenderer.send('win:close'),
  getInitialTool: () => ipcRenderer.invoke('window:get-initial-tool')
})
