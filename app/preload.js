const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  tools: () => ipcRenderer.invoke('tools:list'),
  checkTool: (id, profileId) => ipcRenderer.invoke('tool:check', id, profileId),
  installTool: (id, profileId) => ipcRenderer.invoke('tool:install', id, profileId),
  cancelInstall: (id, profileId) => ipcRenderer.invoke('tool:cancel-install', id, profileId),
  openToolFolder: (id, kind, profileId) => ipcRenderer.invoke('tool:open-folder', id, kind, profileId),
  profiles: (toolId) => ipcRenderer.invoke('profiles:list', toolId),
  createProfile: (toolId, name) => ipcRenderer.invoke('profiles:create', toolId, name),
  renameProfile: (toolId, profileId, name) => ipcRenderer.invoke('profiles:rename', toolId, profileId, name),
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
  terminalStart: (id, profileId, cols, rows, pixelWidth, pixelHeight) => ipcRenderer.invoke('terminal:start', id, profileId, cols, rows, pixelWidth, pixelHeight),
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
  clipboardReadText: () => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (value) => ipcRenderer.invoke('clipboard:write-text', value),
  openToolWindow: (toolId, profileId) => ipcRenderer.invoke('window:open-tool', toolId, profileId),
  windowBounds: () => ipcRenderer.invoke('win:get-bounds'),
  setWindowBounds: (bounds) => ipcRenderer.send('win:set-bounds', bounds),
  closeWindow: () => ipcRenderer.send('win:close'),
  getInitialContext: () => ipcRenderer.invoke('window:get-initial-context')
})
