const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen, shell, webContents } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')

if (app.isPackaged && !process.env.OMNISHELL_SYSTEM_ROOT) {
  process.env.OMNISHELL_SYSTEM_ROOT = path.join(app.getPath('userData'), 'system')
}

const {
  SYSTEM_ROOT,
  TOOLS,
  createInstallEnvironment,
  createInstallPlan,
  createIsolatedEnvironment,
  findTool,
  prepareAllTools,
  prepareToolDirectories,
  resolveLocalExecutable,
  toolDir
} = require('./lib/tooling')
const { PtyRegistry } = require('./lib/pty-registry')
const { collectTerminalResponses } = require('./lib/terminal-queries')
const { createInstallReporter, findLatestInstallLogs, terminateProcessTree } = require('./lib/install-runtime')

const windows = new Set()
const ptyRegistry = new PtyRegistry()
const windowInitialTools = new Map()
const installJobs = new Map()
const installHistory = new Map()
const sendTargets = new Map()
const visualTestMode = process.env.OMNISHELL_VISUAL_TEST === '1'

let tray = null
let installHistoryLoaded = false

app.setName('OmniShell')
app.setAppUserModelId('OmniShell')

function safeSend(senderId, channel, payload) {
  const target = sendTargets.get(senderId) || webContents.fromId(senderId)
  if (target && !target.isDestroyed()) target.send(channel, payload)
}

function broadcastInstall(job, channel, payload) {
  for (const senderId of job.subscribers) safeSend(senderId, channel, payload)
}

function loadInstallHistory() {
  if (installHistoryLoaded) return
  installHistoryLoaded = true
  for (const [toolId, logPath] of findLatestInstallLogs(SYSTEM_ROOT)) installHistory.set(toolId, logPath)
}

function flushInstallProgress(job) {
  clearTimeout(job.progressTimer)
  job.progressTimer = null
  if (!job.pendingProgress || job.settled) return
  const payload = job.pendingProgress
  job.pendingProgress = null
  const signature = `${payload.percent}:\u0000${payload.line}`
  if (signature === job.lastProgressSignature) return
  job.lastProgressSignature = signature
  broadcastInstall(job, 'install:progress', payload)
}

function queueInstallProgress(job, toolId, immediate = false) {
  job.pendingProgress = {
    toolId,
    line: job.lastLine,
    percent: job.percent,
    logAvailable: true
  }
  if (immediate) {
    flushInstallProgress(job)
    return
  }
  if (!job.progressTimer) {
    job.progressTimer = setTimeout(() => flushInstallProgress(job), 24)
    job.progressTimer.unref?.()
  }
}

function inferInstallPercent(tool, line, current) {
  if (tool.installer?.type !== 'npm') return current
  if (/added\s+\d+|changed\s+\d+|removed\s+\d+|up to date/i.test(line)) return Math.max(current, 88)
  if (/npm warn|npm http|fetch|tarball|extract|reify/i.test(line)) return Math.max(current, 36)
  return current
}

function flushPtyOutput(senderId, session) {
  clearTimeout(session.outputTimer)
  session.outputTimer = null
  if (!session.outputBuffer || ptyRegistry.get(senderId) !== session) return
  const data = session.outputBuffer
  session.outputBuffer = ''
  safeSend(senderId, 'pty:data', { sessionId: session.id, data })
}

function queuePtyOutput(senderId, session, data) {
  session.outputBuffer += data
  if (session.outputBuffer.length >= 64 * 1024) {
    flushPtyOutput(senderId, session)
    return
  }
  if (!session.outputTimer) {
    session.outputTimer = setTimeout(() => flushPtyOutput(senderId, session), 8)
    session.outputTimer.unref?.()
  }
}

function createWindow(initialToolId = null) {
  const parent = BrowserWindow.getFocusedWindow()
  let position = {}
  if (parent && !parent.isDestroyed()) {
    const parentBounds = parent.getBounds()
    const display = screen.getDisplayMatching(parentBounds)
    const workArea = display.workArea
    position = {
      x: Math.min(workArea.x + workArea.width - 480, parentBounds.x + 28),
      y: Math.min(workArea.y + workArea.height - 340, parentBounds.y + 28)
    }
  }

  const newWin = new BrowserWindow({
    title: 'OmniShell',
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 340,
    center: !parent,
    ...position,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'assets', 'omnishell.ico'),
    resizable: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  const webContentsId = newWin.webContents.id
  sendTargets.set(webContentsId, newWin.webContents)
  if (initialToolId) {
    windowInitialTools.set(webContentsId, initialToolId)
  }

  windows.add(newWin)

  newWin.webContents.on('did-fail-load', (e, code, desc) => {
    console.error(`[DID FAIL LOAD] ${code}: ${desc}`)
  })

  newWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  newWin.webContents.on('will-navigate', (event, url) => {
    const expected = new URL(`file://${path.join(__dirname, 'renderer', 'index.html').replace(/\\/g, '/')}`).href
    if (url !== expected) event.preventDefault()
  })

  newWin.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  newWin.once('ready-to-show', () => {
    if (visualTestMode) {
      newWin.setIgnoreMouseEvents(true)
      newWin.showInactive()
    } else {
      newWin.show()
    }
    const display = screen.getDisplayMatching(newWin.getBounds())
    newWin.setBounds(display.bounds)
    if (!newWin.isFullScreen()) newWin.setFullScreen(true)
    if (!visualTestMode) newWin.focus()
  })

  newWin.on('closed', () => {
    killPtyForSender(webContentsId)
    for (const job of installJobs.values()) job.subscribers.delete(webContentsId)
    windows.delete(newWin)
    sendTargets.delete(webContentsId)
    windowInitialTools.delete(webContentsId)
  })

  return newWin
}

function killPtyForSender(senderId) {
  ptyRegistry.kill(senderId)
}

function killAllPtys() {
  ptyRegistry.killAll()
}

function createTray() {
  if (tray) return
  tray = new Tray(path.join(__dirname, 'assets', 'omnishell-tray.png'))
  tray.setToolTip('OmniShell')

  const ctxMenu = Menu.buildFromTemplate([
    { label: 'Open OmniShell', click: () => { createWindow() } },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() }
  ])

  tray.setContextMenu(ctxMenu)
  tray.on('click', () => {
    if (windows.size === 0) {
      createWindow()
    } else {
      for (const w of windows) {
        if (!w.isDestroyed()) {
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
        }
      }
    }
  })
}

ipcMain.handle('tools:list', (event) => {
  loadInstallHistory()
  for (const job of installJobs.values()) job.subscribers.add(event.sender.id)
  return TOOLS.map((tool) => {
    const job = installJobs.get(tool.id)
    return {
    id: tool.id,
    name: tool.name,
    sigil: tool.sigil,
    accent: tool.accent,
    summary: tool.summary,
    category: tool.category,
    installable: Boolean(tool.installer),
    hint: tool.hint || '',
    notice: tool.notice || '',
    installed: Boolean(resolveLocalExecutable(tool)),
    installing: Boolean(job),
    installPercent: job?.percent || 0,
    hasLog: Boolean(installHistory.get(tool.id)),
    source: tool.installer?.package || tool.installer?.url || tool.installer?.repo || 'manual setup',
    profile: toolDir(tool)
  }})
})

ipcMain.handle('window:get-initial-tool', (event) => {
  return windowInitialTools.get(event.sender.id) || null
})

ipcMain.handle('window:open-tool', (event, toolId) => {
  if (toolId === null || toolId === undefined) {
    createWindow()
    return { ok: true }
  }
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  createWindow(toolId)
  return { ok: true }
})

ipcMain.on('win:close', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender)
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.close()
  }
})

ipcMain.handle('tool:open-folder', async (event, id, kind = 'profile') => {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }
  loadInstallHistory()
  const logPath = installHistory.get(id)
  if (kind === 'log' && !logPath) return { ok: false, error: 'No installation log is available in this session' }
  const target = kind === 'log' ? path.dirname(logPath) : prepareToolDirectories(tool)
  if (!fs.existsSync(target)) return { ok: false, error: 'Folder not found' }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('tool:check', (event, id) => {
  const tool = findTool(id)
  if (!tool) return { installed: false, error: 'Tool not found' }

  const executable = resolveLocalExecutable(tool)
  return {
    installed: Boolean(executable),
    isLocal: Boolean(executable),
    installable: Boolean(tool.installer),
    hint: tool.hint || ''
  }
})

ipcMain.handle('tool:install', (event, id) => {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }

  if (!tool.installer) {
    safeSend(event.sender.id, 'install:done', {
      toolId: tool.id,
      ok: false,
      manual: true,
      hint: tool.hint || 'This tool requires manual installation.'
    })
    return { ok: false, manual: true }
  }

  const existingJob = installJobs.get(tool.id)
  if (existingJob) {
    existingJob.subscribers.add(event.sender.id)
    safeSend(event.sender.id, 'install:progress', {
      toolId: tool.id,
      line: existingJob.lastLine || `Installing ${tool.name}...`,
      percent: existingJob.percent,
      logAvailable: true
    })
    return { ok: true, joined: true }
  }

  const plan = createInstallPlan(tool, __dirname)
  if (!plan) return { ok: false, error: 'No installer is configured for this tool' }

  let reporter
  try {
    reporter = createInstallReporter(tool, SYSTEM_ROOT)
    installHistory.set(tool.id, reporter.logPath)
  } catch (error) {
    return { ok: false, error: `Installer log could not be created: ${error.message}` }
  }

  let proc
  try {
    proc = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: createInstallEnvironment(tool),
      windowsHide: true
    })
  } catch (error) {
    reporter.feed('error', error.message)
    reporter.finish('failed to start')
    installHistory.set(tool.id, reporter.logPath)
    return { ok: false, error: `Installer could not start: ${error.message}` }
  }
  const job = {
    proc,
    reporter,
    subscribers: new Set([event.sender.id]),
    lastLine: `Preparing ${tool.name} installer...`,
    percent: 1,
    cancelled: false,
    settled: false,
    pendingProgress: null,
    progressTimer: null,
    lastProgressSignature: ''
  }
  installJobs.set(tool.id, job)

  queueInstallProgress(job, tool.id, true)

  const feed = (streamName, chunk) => {
    job.lastLine = reporter.feed(streamName, chunk) || job.lastLine
    job.percent = Math.max(job.percent, reporter.progress, inferInstallPercent(tool, job.lastLine, job.percent))
    queueInstallProgress(job, tool.id)
  }

  proc.stdout.on('data', (chunk) => feed('stdout', chunk))
  proc.stderr.on('data', (chunk) => feed('stderr', chunk))

  const finish = (ok, error = '') => {
    if (job.settled) return
    if (ok) {
      job.percent = 100
      job.lastLine = `${tool.name} installed and verified`
      queueInstallProgress(job, tool.id, true)
    } else {
      clearTimeout(job.progressTimer)
      job.progressTimer = null
    }
    job.settled = true
    installJobs.delete(tool.id)
    installHistory.set(tool.id, reporter.logPath)
    reporter.finish(ok ? 'success' : (job.cancelled ? 'cancelled' : 'failed'))
    broadcastInstall(job, 'install:done', {
      toolId: tool.id,
      ok,
      cancelled: job.cancelled,
      error: reporter.failure(error || job.lastLine),
      logAvailable: true
    })
  }

  proc.on('error', (error) => finish(false, error.message))
  proc.on('close', (code) => {
    const executable = resolveLocalExecutable(tool)
    if (job.cancelled) {
      finish(false, 'Installation cancelled.')
      return
    }
    finish(code === 0 && Boolean(executable), executable ? '' : `Installer exited with code ${code}, but the local executable was not found.`)
  })

  return { ok: true, joined: false }
})

ipcMain.handle('tool:cancel-install', (event, id) => {
  const job = installJobs.get(id)
  if (!job) return { ok: false, error: 'No active installer was found' }
  job.cancelled = true
  job.lastLine = 'Cancelling installation...'
  queueInstallProgress(job, id, true)
  terminateProcessTree(job.proc)
  return { ok: true }
})

ipcMain.handle('terminal:stop', (event) => {
  killPtyForSender(event.sender.id)
  return { ok: true }
})

ipcMain.handle('terminal:start', async (event, id, cols, rows, pixelWidth, pixelHeight) => {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }

  killPtyForSender(event.sender.id)

  const cwd = toolDir(tool)
  fs.mkdirSync(cwd, { recursive: true })

  const startCols = Number.isInteger(cols) ? Math.max(11, Math.min(cols, 1000)) : 90
  const startRows = Number.isInteger(rows) ? Math.max(6, Math.min(rows, 500)) : 28
  const startPixelWidth = Number.isInteger(pixelWidth) ? Math.max(1, Math.min(pixelWidth, 16384)) : startCols * 9
  const startPixelHeight = Number.isInteger(pixelHeight) ? Math.max(1, Math.min(pixelHeight, 16384)) : startRows * 18
  let launchExe = resolveLocalExecutable(tool)
  if (!launchExe) return { ok: false, error: 'The isolated local installation was not found' }

  try {
    const pty = require('node-pty')
    const ptyEnv = createIsolatedEnvironment(tool)
    let launchArgs = []

    const spawnOpts = {
      name: 'xterm-256color',
      cols: startCols,
      rows: startRows,
      pixelWidth: startPixelWidth,
      pixelHeight: startPixelHeight,
      cwd: cwd,
      env: ptyEnv
    }

    let ptyProc
    const comspec = process.env.ComSpec || 'cmd.exe'
    if (launchArgs.length > 0) {
      ptyProc = pty.spawn(launchExe, launchArgs, spawnOpts)
    } else if (launchExe && (launchExe.toLowerCase().endsWith('.cmd') || launchExe.toLowerCase().endsWith('.bat'))) {
      ptyProc = pty.spawn(comspec, ['/d', '/s', '/c', 'call', launchExe], spawnOpts)
    } else if (fs.existsSync(launchExe)) {
      ptyProc = pty.spawn(launchExe, [], spawnOpts)
    } else {
      return { ok: false, error: 'The isolated executable disappeared before launch' }
    }

    const session = {
      id: randomUUID(),
      proc: ptyProc,
      cols: startCols,
      rows: startRows,
      queryBuffer: '',
      outputBuffer: '',
      outputTimer: null
    }
    ptyRegistry.replace(event.sender.id, session)

    ptyProc.onData((data) => {
      if (ptyRegistry.get(event.sender.id) !== session) return
      const queryResult = collectTerminalResponses(
        session.queryBuffer,
        data,
        session.cols,
        session.rows,
        session.pixelWidth,
        session.pixelHeight
      )
      session.queryBuffer = queryResult.buffer
      for (const response of queryResult.responses) {
        try { ptyProc.write(response) } catch (error) {}
      }
      queuePtyOutput(event.sender.id, session, data)
    })

    ptyProc.onExit(({ exitCode }) => {
      flushPtyOutput(event.sender.id, session)
      if (ptyRegistry.deleteIfCurrent(event.sender.id, session)) {
        safeSend(event.sender.id, 'pty:exit', { sessionId: session.id, exitCode })
      }
    })

    return { ok: true, sessionId: session.id }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

ipcMain.on('pty:write', (event, data) => {
  const session = ptyRegistry.get(event.sender.id)
  if (session && typeof data === 'string' && data.length <= 1024 * 1024) {
    try { session.proc.write(data) } catch (error) {}
  }
})

ipcMain.on('pty:resize', (event, cols, rows, pixelWidth, pixelHeight) => {
  const session = ptyRegistry.get(event.sender.id)
  if (session && Number.isInteger(cols) && Number.isInteger(rows) && cols > 10 && rows > 5 && cols <= 1000 && rows <= 500) {
    session.cols = cols
    session.rows = rows
    if (Number.isInteger(pixelWidth) && pixelWidth > 0 && pixelWidth <= 16384) session.pixelWidth = pixelWidth
    if (Number.isInteger(pixelHeight) && pixelHeight > 0 && pixelHeight <= 16384) session.pixelHeight = pixelHeight
    try { session.proc.resize(cols, rows) } catch (error) {}
  }
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (windows.size === 0) {
      createWindow()
      return
    }
    for (const win of windows) {
      if (win.isDestroyed()) continue
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  prepareAllTools()
  loadInstallHistory()
  createWindow()
  createTray()

  globalShortcut.register('Ctrl+Alt+S', () => {
    if (windows.size === 0) {
      createWindow()
      return
    }
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused.isVisible()) {
      focused.hide()
    } else {
      for (const w of windows) {
        if (!w.isDestroyed()) {
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
          w.moveTop()
        }
      }
    }
  })
})

app.on('will-quit', () => {
  killAllPtys()
  for (const job of installJobs.values()) {
    job.cancelled = true
    terminateProcessTree(job.proc)
  }
  installJobs.clear()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
