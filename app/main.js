const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, screen, shell, webContents } = require('electron')
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
  prepareProfileDirectories,
  prepareToolDirectories,
  profileDir,
  resolveLocalExecutable,
  toolDir
} = require('./lib/tooling')
const { DEFAULT_PROFILE_ID, ProfileStore, normalizeProfileSettings, validateProfileId } = require('./lib/profile-store')
const { PtyRegistry } = require('./lib/pty-registry')
const { collectTerminalResponses } = require('./lib/terminal-queries')
const { createInstallReporter, findLatestInstallLogs, terminateProcessTree } = require('./lib/install-runtime')
const { hydrateSharedProfileData, persistSharedProfileData, sharingCapabilities } = require('./lib/profile-sharing')
const { prepareProfileLaunch } = require('./lib/profile-launch')

const windows = new Set()
const ptyRegistry = new PtyRegistry((proc) => {
  if (process.platform === 'win32' && terminateProcessTree(proc)) return
  proc.kill()
})
const windowInitialContexts = new Map()
const installJobs = new Map()
const installHistory = new Map()
const sendTargets = new Map()
const visualTestMode = process.env.OMNISHELL_VISUAL_TEST === '1'
const profileStore = new ProfileStore(SYSTEM_ROOT)
const terminalLaunches = new Map()
const closingProfiles = new Map()
const pendingProfileWrites = new Set()
const editingProfiles = new Set()

let tray = null
let installHistoryLoaded = false
let quitting = false
let quitReady = false

app.setName('OmniShell')
app.setAppUserModelId('OmniShell')

function roundedWindowShape(width, height, radius = 12) {
  const safeRadius = Math.max(1, Math.min(radius, Math.floor(width / 2), Math.floor(height / 2)))
  const rects = [{ x: 0, y: safeRadius, width, height: Math.max(1, height - (safeRadius * 2)) }]
  for (let offset = 0; offset < safeRadius; offset += 1) {
    const distance = safeRadius - offset - 0.5
    const inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt((safeRadius * safeRadius) - (distance * distance))))
    const rowWidth = Math.max(1, width - (inset * 2))
    rects.push({ x: inset, y: offset, width: rowWidth, height: 1 })
    rects.push({ x: inset, y: height - offset - 1, width: rowWidth, height: 1 })
  }
  return rects
}

function applyWindowShape(targetWin) {
  if (!targetWin || targetWin.isDestroyed()) return
  const [width, height] = targetWin.getSize()
  targetWin.setShape(roundedWindowShape(width, height))
}

function safeSend(senderId, channel, payload) {
  const target = sendTargets.get(senderId) || webContents.fromId(senderId)
  if (target && !target.isDestroyed()) target.send(channel, payload)
}

function profileInstallKey(toolId, profileId = DEFAULT_PROFILE_ID) {
  validateProfileId(profileId)
  return `${toolId}\u0000${profileId}`
}

function installLogId(toolId, profileId = DEFAULT_PROFILE_ID) {
  validateProfileId(profileId)
  return `${toolId}--${profileId}`
}

function profileWorkspaceDir(tool, profileId = DEFAULT_PROFILE_ID) {
  validateProfileId(profileId)
  const root = path.join(app.getPath('userData'), 'workspaces', tool.id, profileId)
  fs.mkdirSync(root, { recursive: true })
  return root
}

function profilesWithInstallState(tool, profiles) {
  return profiles.map((profile) => ({
    ...profile,
    installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile.id))
  }))
}

function profileHasActiveSession(toolId, profileId) {
  return ptyRegistry.entries().some(([, session]) => session.toolId === toolId && session.profileId === profileId)
    || [...terminalLaunches.values()].some((launch) => launch.toolId === toolId && launch.profileId === profileId)
    || closingProfiles.has(profileInstallKey(toolId, profileId))
    || editingProfiles.has(profileInstallKey(toolId, profileId))
}

function profilesConflict(left, right) {
  if (left.id === right.id) return true
  return ['sharedSessions', 'sharedModels', 'sharedConfig'].some((key) => left.settings?.[key] && right.settings?.[key])
}

function persistSessionProfile(session) {
  if (!session) return Promise.resolve()
  if (session.persistPromise) return session.persistPromise
  session.persistPromise = persistSharedProfileData(session.tool, session.profile, SYSTEM_ROOT)
  pendingProfileWrites.add(session.persistPromise)
  session.persistPromise.catch((error) => {
    console.error(`[PROFILE SHARE] ${String(error.message || error)}`)
  }).finally(() => {
    pendingProfileWrites.delete(session.persistPromise)
  })
  return session.persistPromise
}

function finishSessionProfile(session) {
  if (session.finishPromise) return session.finishPromise
  const key = profileInstallKey(session.toolId, session.profileId)
  session.finishPromise = session.exited.then(() => persistSessionProfile(session))
  closingProfiles.set(key, session.finishPromise)
  session.finishPromise.catch((error) => {
    console.error(`[PROFILE CLOSE] ${String(error.message || error)}`)
  }).finally(() => {
    if (closingProfiles.get(key) === session.finishPromise) closingProfiles.delete(key)
  })
  return session.finishPromise
}

function writeProfileDescriptor(tool, profile) {
  if (!profile || profile.id === DEFAULT_PROFILE_ID) return
  const root = prepareProfileDirectories(tool, profile.id)
  fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify({
    id: profile.id,
    name: profile.name,
    settings: profile.settings,
    updatedAt: profile.updatedAt,
    data: '.',
    runtime: 'runtime'
  }, null, 2), 'utf8')
}

function broadcastInstall(job, channel, payload) {
  for (const senderId of job.subscribers) safeSend(senderId, channel, payload)
}

function loadInstallHistory() {
  if (installHistoryLoaded) return
  installHistoryLoaded = true
  for (const [logId, logPath] of findLatestInstallLogs(SYSTEM_ROOT)) {
    const match = /^(.*)--(default|p_[0-9a-f]{32})$/.exec(logId)
    if (match) installHistory.set(profileInstallKey(match[1], match[2]), logPath)
    else installHistory.set(profileInstallKey(logId), logPath)
  }
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

function queueInstallProgress(job, immediate = false) {
  job.pendingProgress = {
    toolId: job.toolId,
    profileId: job.profileId,
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

function createWindow(initialContext = null) {
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
    backgroundColor: '#070707',
    backgroundMaterial: 'none',
    icon: path.join(__dirname, 'assets', 'omnishell.ico'),
    movable: true,
    resizable: true,
    thickFrame: false,
    roundedCorners: true,
    hasShadow: false,
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
  if (initialContext) {
    const normalized = typeof initialContext === 'string'
      ? { toolId: initialContext, profileId: null, auxiliary: false }
      : {
          toolId: initialContext.toolId,
          profileId: initialContext.profileId || null,
          auxiliary: Boolean(initialContext.auxiliary)
        }
    windowInitialContexts.set(webContentsId, normalized)
  }

  windows.add(newWin)
  let shapeTimer = null
  const scheduleShape = () => {
    clearTimeout(shapeTimer)
    shapeTimer = setTimeout(() => applyWindowShape(newWin), 16)
  }
  applyWindowShape(newWin)
  newWin.on('resize', scheduleShape)

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
    if (!visualTestMode) newWin.focus()
  })

  newWin.on('closed', () => {
    clearTimeout(shapeTimer)
    killPtyForSender(webContentsId).catch((error) => console.error(`[PROFILE CLOSE] ${String(error.message || error)}`))
    for (const job of installJobs.values()) job.subscribers.delete(webContentsId)
    windows.delete(newWin)
    sendTargets.delete(webContentsId)
    windowInitialContexts.delete(webContentsId)
  })

  return newWin
}

function killPtyForSender(senderId) {
  const launch = terminalLaunches.get(senderId)
  terminalLaunches.delete(senderId)
  const session = ptyRegistry.get(senderId)
  const finished = session ? finishSessionProfile(session) : Promise.resolve()
  ptyRegistry.kill(senderId)
  return Promise.all([finished, launch?.finished])
}

function killAllPtys() {
  const senderIds = new Set([...terminalLaunches.keys(), ...ptyRegistry.entries().map(([senderId]) => senderId)])
  return [...senderIds].map(killPtyForSender)
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
    const job = installJobs.get(profileInstallKey(tool.id))
    return {
    id: tool.id,
    name: tool.name,
    sigil: tool.sigil,
    accent: tool.accent,
    terminalBackground: tool.terminalBackground || '#000000',
    summary: tool.summary,
    category: tool.category,
    installable: Boolean(tool.installer),
    hint: tool.hint || '',
    notice: tool.notice || '',
    installed: Boolean(resolveLocalExecutable(tool)),
    installing: Boolean(job),
    installPercent: job?.percent || 0,
    hasLog: Boolean(installHistory.get(profileInstallKey(tool.id))),
    source: tool.installer?.package || tool.installer?.url || tool.installer?.repo || 'manual setup',
    profile: toolDir(tool)
  }})
})

ipcMain.handle('window:get-initial-context', (event) => {
  return windowInitialContexts.get(event.sender.id) || null
})

ipcMain.handle('window:open-tool', async (event, toolId, profileId = null) => {
  if (toolId === null || toolId === undefined) {
    createWindow()
    return { ok: true }
  }
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  if (profileId !== null) {
    const profile = await profileStore.get(tool.id, profileId)
    if (!profile) return { ok: false, error: 'Profile not found' }
    if (!resolveLocalExecutable(tool, SYSTEM_ROOT, profile.id)) {
      return { ok: false, error: 'This profile does not have its own CLI installation yet' }
    }
  }
  createWindow({ toolId: tool.id, profileId, auxiliary: profileId !== null })
  return { ok: true }
})

ipcMain.handle('profiles:list', async (event, toolId) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found', profiles: [] }
  return { ok: true, profiles: profilesWithInstallState(tool, await profileStore.list(tool.id)), capabilities: sharingCapabilities(tool.id) }
})

ipcMain.handle('profiles:create', async (event, toolId, name, settings = {}) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  try {
    const profile = await profileStore.create(tool.id, name, settings)
    prepareProfileDirectories(tool, profile.id)
    writeProfileDescriptor(tool, profile)
    return { ok: true, profile: { ...profile, installed: false } }
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
})

ipcMain.handle('profiles:rename', async (event, toolId, profileId, name) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  try {
    const profile = await profileStore.rename(tool.id, profileId, name)
    writeProfileDescriptor(tool, profile)
    return { ok: true, profile: { ...profile, installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile.id)) } }
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
})

ipcMain.handle('profiles:update-settings', async (event, toolId, profileId, settings) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  if (profileHasActiveSession(tool.id, profileId)) return { ok: false, error: 'Close this profile before changing its settings' }
  const key = profileInstallKey(tool.id, profileId)
  editingProfiles.add(key)
  try {
    const previous = await profileStore.get(tool.id, profileId)
    if (!previous) return { ok: false, error: 'Profile not found' }
    // Opting in consumes the shared copy; a stale local profile must not replace it.
    await hydrateSharedProfileData(tool, { ...previous, settings: normalizeProfileSettings(settings) }, SYSTEM_ROOT)
    const profile = await profileStore.updateSettings(tool.id, profileId, settings)
    writeProfileDescriptor(tool, profile)
    return { ok: true, profile: { ...profile, installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile.id)) } }
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  } finally {
    editingProfiles.delete(key)
  }
})

ipcMain.handle('profiles:delete', async (event, toolId, profileId) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  if (profileId === DEFAULT_PROFILE_ID) return { ok: false, error: 'The Default profile cannot be deleted' }
  if (profileHasActiveSession(tool.id, profileId)) return { ok: false, error: 'Close this profile before deleting it' }
  if (installJobs.has(profileInstallKey(tool.id, profileId))) return { ok: false, error: 'Cancel the profile installation before deleting it' }
  const key = profileInstallKey(tool.id, profileId)
  editingProfiles.add(key)
  let source
  let destination
  try {
    const profile = await profileStore.get(tool.id, profileId)
    if (!profile) return { ok: false, error: 'Profile not found' }
    source = profileDir(tool, profile.id, SYSTEM_ROOT)
    destination = path.join(SYSTEM_ROOT, '_profiles', 'trash', tool.id, `${profile.id}-${Date.now()}`)
    if (fs.existsSync(source)) {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.rename(source, destination)
    }
    await profileStore.delete(tool.id, profile.id)
    return { ok: true, deletedProfile: profile, recoverablePath: destination }
  } catch (error) {
    if (source && destination && fs.existsSync(destination) && !fs.existsSync(source)) {
      try { await fs.promises.rename(destination, source) } catch (rollbackError) {}
    }
    return { ok: false, error: String(error.message || error) }
  } finally {
    editingProfiles.delete(key)
  }
})

ipcMain.handle('clipboard:read-text', () => {
  return clipboard.readText().slice(0, 1024 * 1024)
})

ipcMain.handle('clipboard:write-text', (event, value) => {
  if (typeof value !== 'string' || value.length > 1024 * 1024) {
    return { ok: false, error: 'Clipboard text is invalid or too large' }
  }
  clipboard.writeText(value)
  return { ok: true }
})

ipcMain.on('win:close', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender)
  if (targetWin && !targetWin.isDestroyed()) {
    targetWin.close()
  }
})

ipcMain.handle('win:get-bounds', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender)
  return targetWin && !targetWin.isDestroyed() ? targetWin.getBounds() : null
})

ipcMain.on('win:set-bounds', (event, requestedBounds) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender)
  if (!targetWin || targetWin.isDestroyed() || !requestedBounds || typeof requestedBounds !== 'object') return
  const current = targetWin.getBounds()
  const display = screen.getDisplayMatching(current)
  const workArea = display.workArea
  const width = Math.max(480, Math.min(workArea.width, Math.round(Number(requestedBounds.width) || current.width)))
  const height = Math.max(340, Math.min(workArea.height, Math.round(Number(requestedBounds.height) || current.height)))
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, Math.round(Number(requestedBounds.x) || current.x)))
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, Math.round(Number(requestedBounds.y) || current.y)))
  targetWin.setSize(width, height, false)
  targetWin.setPosition(x, y, false)
  applyWindowShape(targetWin)
})

ipcMain.handle('tool:open-folder', async (event, id, kind = 'profile', profileId = DEFAULT_PROFILE_ID) => {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }
  loadInstallHistory()
  const logPath = installHistory.get(profileInstallKey(id, profileId))
  if (kind === 'log' && !logPath) return { ok: false, error: 'No installation log is available in this session' }
  if (kind === 'profile' && !await profileStore.get(tool.id, profileId)) {
    return { ok: false, error: 'Profile not found' }
  }
  const target = kind === 'log'
    ? path.dirname(logPath)
    : prepareProfileDirectories(tool, profileId)
  if (!fs.existsSync(target)) return { ok: false, error: 'Folder not found' }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('tool:check', (event, id, profileId = DEFAULT_PROFILE_ID) => {
  const tool = findTool(id)
  if (!tool) return { installed: false, error: 'Tool not found' }
  try { validateProfileId(profileId) } catch (error) { return { installed: false, error: error.message } }

  const executable = resolveLocalExecutable(tool, SYSTEM_ROOT, profileId)
  return {
    installed: Boolean(executable),
    isLocal: Boolean(executable),
    installable: Boolean(tool.installer),
    hint: tool.hint || ''
  }
})

ipcMain.handle('tool:install', async (event, id, profileId = DEFAULT_PROFILE_ID) => {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }
  let profile
  try {
    profile = await profileStore.get(tool.id, profileId)
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
  if (!profile) return { ok: false, error: 'Profile not found' }
  const jobKey = profileInstallKey(tool.id, profile.id)
  if (profileHasActiveSession(tool.id, profile.id)) return { ok: false, error: 'Close this profile before installing or updating it' }

  if (!tool.installer) {
    safeSend(event.sender.id, 'install:done', {
      toolId: tool.id,
      profileId: profile.id,
      ok: false,
      manual: true,
      hint: tool.hint || 'This tool requires manual installation.'
    })
    return { ok: false, manual: true }
  }

  const existingJob = installJobs.get(jobKey)
  if (existingJob) {
    existingJob.subscribers.add(event.sender.id)
    safeSend(event.sender.id, 'install:progress', {
      toolId: tool.id,
      profileId: profile.id,
      line: existingJob.lastLine || `Installing ${tool.name}...`,
      percent: existingJob.percent,
      logAvailable: true
    })
    return { ok: true, joined: true }
  }

  const plan = createInstallPlan(tool, __dirname, SYSTEM_ROOT, profile.id)
  if (!plan) return { ok: false, error: 'No installer is configured for this tool' }

  let reporter
  try {
    reporter = createInstallReporter({ ...tool, id: installLogId(tool.id, profile.id), name: `${tool.name} / ${profile.name}` }, SYSTEM_ROOT)
    installHistory.set(jobKey, reporter.logPath)
  } catch (error) {
    return { ok: false, error: `Installer log could not be created: ${error.message}` }
  }

  let proc
  try {
    proc = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: createInstallEnvironment(tool, process.env, SYSTEM_ROOT, profile.id),
      windowsHide: true
    })
  } catch (error) {
    reporter.feed('error', error.message)
    reporter.finish('failed to start')
    installHistory.set(jobKey, reporter.logPath)
    return { ok: false, error: `Installer could not start: ${error.message}` }
  }
  const job = {
    key: jobKey,
    toolId: tool.id,
    profileId: profile.id,
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
  installJobs.set(jobKey, job)

  queueInstallProgress(job, true)

  const feed = (streamName, chunk) => {
    job.lastLine = reporter.feed(streamName, chunk) || job.lastLine
    job.percent = Math.max(job.percent, reporter.progress, inferInstallPercent(tool, job.lastLine, job.percent))
    queueInstallProgress(job)
  }

  proc.stdout.on('data', (chunk) => feed('stdout', chunk))
  proc.stderr.on('data', (chunk) => feed('stderr', chunk))

  const finish = (ok, error = '') => {
    if (job.settled) return
    if (ok) {
      job.percent = 100
      job.lastLine = `${tool.name} installed and verified`
      queueInstallProgress(job, true)
    } else {
      clearTimeout(job.progressTimer)
      job.progressTimer = null
    }
    job.settled = true
    installJobs.delete(jobKey)
    installHistory.set(jobKey, reporter.logPath)
    reporter.finish(ok ? 'success' : (job.cancelled ? 'cancelled' : 'failed'))
    broadcastInstall(job, 'install:done', {
      toolId: tool.id,
      profileId: profile.id,
      ok,
      cancelled: job.cancelled,
      error: reporter.failure(error || job.lastLine),
      logAvailable: true
    })
  }

  proc.on('error', (error) => finish(false, error.message))
  proc.on('close', (code) => {
    const executable = resolveLocalExecutable(tool, SYSTEM_ROOT, profile.id)
    if (job.cancelled) {
      finish(false, 'Installation cancelled.')
      return
    }
    finish(code === 0 && Boolean(executable), executable ? '' : `Installer exited with code ${code}, but the local executable was not found.`)
  })

  return { ok: true, joined: false }
})

ipcMain.handle('tool:cancel-install', (event, id, profileId = DEFAULT_PROFILE_ID) => {
  let jobKey
  try { jobKey = profileInstallKey(id, profileId) } catch (error) { return { ok: false, error: error.message } }
  const job = installJobs.get(jobKey)
  if (!job) return { ok: false, error: 'No active installer was found' }
  job.cancelled = true
  job.lastLine = 'Cancelling installation...'
  queueInstallProgress(job, true)
  terminateProcessTree(job.proc)
  return { ok: true }
})

ipcMain.handle('terminal:stop', async (event) => {
  try {
    await killPtyForSender(event.sender.id)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error.message || error) }
  }
})

ipcMain.handle('terminal:start', async (event, id, profileId = DEFAULT_PROFILE_ID, cols, rows, pixelWidth, pixelHeight) => {
  const senderId = event.sender.id
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }
  if (quitting) return { ok: false, error: 'OmniShell is closing' }
  const previousSessionClosed = killPtyForSender(senderId)
  let completeLaunch
  const launch = { toolId: tool.id, profileId, finished: new Promise((resolve) => { completeLaunch = resolve }) }
  terminalLaunches.set(senderId, launch)
  const isCurrentLaunch = () => terminalLaunches.get(senderId) === launch && !event.sender.isDestroyed() && !quitting
  try {
    await previousSessionClosed
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }
    const profile = await profileStore.get(tool.id, profileId)
    if (!profile) return { ok: false, error: 'Profile not found' }
    await Promise.all([...closingProfiles].filter(([key]) => key.startsWith(`${tool.id}\u0000`)).map(([, finished]) => finished))
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }
    if (editingProfiles.has(profileInstallKey(tool.id, profile.id))) return { ok: false, error: 'Wait for this profile change to finish' }
    if (installJobs.has(profileInstallKey(tool.id, profile.id))) return { ok: false, error: 'Wait for this profile installation to finish' }
    const busyProfiles = [
      ...ptyRegistry.entries().map(([, session]) => session),
      ...[...terminalLaunches.values()].filter((candidate) => candidate !== launch && candidate.profile)
    ]
    if (busyProfiles.some((candidate) => candidate.toolId === tool.id && profilesConflict(profile, candidate.profile))) {
      return { ok: false, error: 'Close the active profile using this profile or its shared data before opening it here' }
    }
    launch.profile = profile

    prepareProfileDirectories(tool, profile.id)
    const cwd = profileWorkspaceDir(tool, profile.id)
    await hydrateSharedProfileData(tool, profile, SYSTEM_ROOT)
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }

    const startCols = Number.isInteger(cols) ? Math.max(11, Math.min(cols, 1000)) : 90
    const startRows = Number.isInteger(rows) ? Math.max(6, Math.min(rows, 500)) : 28
    const startPixelWidth = Number.isInteger(pixelWidth) ? Math.max(1, Math.min(pixelWidth, 16384)) : startCols * 9
    const startPixelHeight = Number.isInteger(pixelHeight) ? Math.max(1, Math.min(pixelHeight, 16384)) : startRows * 18
    const launchExe = resolveLocalExecutable(tool, SYSTEM_ROOT, profile.id)
    if (!launchExe) return { ok: false, error: 'The isolated local installation was not found' }

    const pty = require('node-pty')
    const basePtyEnv = createIsolatedEnvironment(tool, process.env, SYSTEM_ROOT, profile.id)
    const launchPolicy = await prepareProfileLaunch(tool, profile, profileDir(tool, profile.id, SYSTEM_ROOT), basePtyEnv)
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }
    const ptyEnv = launchPolicy.env
    ptyEnv.PWD = cwd
    ptyEnv.INIT_CWD = cwd
    ptyEnv.GIT_CEILING_DIRECTORIES = path.join(app.getPath('userData'), 'workspaces')
    ptyEnv.OMNISHELL_PROFILE_WORKSPACE = cwd
    const launchArgs = launchPolicy.args

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
    if (launchExe && (launchExe.toLowerCase().endsWith('.cmd') || launchExe.toLowerCase().endsWith('.bat'))) {
      ptyProc = pty.spawn(comspec, ['/d', '/s', '/c', 'call', launchExe, ...launchArgs], spawnOpts)
    } else if (launchArgs.length > 0) {
      ptyProc = pty.spawn(launchExe, launchArgs, spawnOpts)
    } else if (fs.existsSync(launchExe)) {
      ptyProc = pty.spawn(launchExe, [], spawnOpts)
    } else {
      return { ok: false, error: 'The isolated executable disappeared before launch' }
    }

    let session = null
    let resolveExit
    const exited = new Promise((resolve) => { resolveExit = resolve })
    const earlyData = []
    let earlyExit = null

    const handleData = (data) => {
      if (!session || ptyRegistry.get(senderId) !== session) return
      const queryResult = collectTerminalResponses(
        session.queryBuffer,
        data,
        session.cols,
        session.rows,
        session.pixelWidth,
        session.pixelHeight,
        { background: session.terminalBackground }
      )
      session.queryBuffer = queryResult.buffer
      for (const response of queryResult.responses) {
        try { ptyProc.write(response) } catch (error) {}
      }
      queuePtyOutput(senderId, session, data)
    }

    const handleExit = ({ exitCode }) => {
      if (!session) {
        earlyExit = { exitCode }
        return
      }
      resolveExit()
      finishSessionProfile(session)
      flushPtyOutput(senderId, session)
      if (ptyRegistry.deleteIfCurrent(senderId, session)) {
        safeSend(senderId, 'pty:exit', { sessionId: session.id, exitCode })
      }
    }

    ptyProc.onData((data) => {
      if (!session) earlyData.push(data)
      else handleData(data)
    })
    ptyProc.onExit(handleExit)

    session = {
      id: randomUUID(),
      toolId: tool.id,
      profileId: profile.id,
      tool,
      profile,
      exited,
      persistPromise: null,
      finishPromise: null,
      terminalBackground: (tool.terminalBackground || '#000000').replace('#', ''),
      proc: ptyProc,
      cols: startCols,
      rows: startRows,
      pixelWidth: startPixelWidth,
      pixelHeight: startPixelHeight,
      queryBuffer: '',
      outputBuffer: '',
      outputTimer: null
    }
    ptyRegistry.replace(senderId, session)
    for (const data of earlyData) handleData(data)
    if (earlyExit) handleExit(earlyExit)

    return { ok: true, sessionId: session.id, profile }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  } finally {
    if (terminalLaunches.get(senderId) === launch) terminalLaunches.delete(senderId)
    completeLaunch()
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
  profileStore.ensureTools(TOOLS.map((tool) => tool.id))
    .then((profilesByTool) => {
      for (const tool of TOOLS) {
        for (const profile of profilesByTool[tool.id] || []) writeProfileDescriptor(tool, profile)
      }
    })
    .catch((error) => {
      console.error(`[PROFILE STORE] ${String(error.message || error)}`)
    })
  createWindow()
  createTray()
  setImmediate(loadInstallHistory)

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

app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  const closing = killAllPtys()
  Promise.allSettled([...closing, ...closingProfiles.values(), ...pendingProfileWrites]).then(() => {
    quitReady = true
    app.quit()
  })
})

app.on('will-quit', () => {
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
