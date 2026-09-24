const { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, net, screen, shell, webContents } = require('electron')
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
  cleanupInstallArtifacts,
  createInstallEnvironment,
  createInstallPlan,
  createIsolatedEnvironment,
  findTool,
  prepareAllTools,
  prepareProfileDirectories,
  profileDir,
  resolveLocalExecutable
} = require('./lib/tooling')
const { DEFAULT_PROFILE_ID, ProfileStore, normalizeProfileName, normalizeProfileSettings, validateProfileId } = require('./lib/profile-store')
const { PtyRegistry } = require('./lib/pty-registry')
const { collectTerminalResponses } = require('./lib/terminal-queries')
const { createInstallReporter, findLatestInstallLog, terminateProcessTree, stopPtyGracefully } = require('./lib/install-runtime')
const { clearPendingRename, migrateProfileLayout, recordPendingRename, recoverPendingRenames } = require('./lib/profile-layout')
const { migrateProfileDocuments, profileDocumentName, writeProfileDocumentSync } = require('./lib/profile-document')
const { migrateSharedInstallations } = require('./lib/shared-install-layout')
const { hydrateSharedProfileData, migrateLegacySharedMcp, persistSharedProfileData, sharingCapabilities } = require('./lib/profile-sharing')
const { applyProfilePathUpdates, planProfilePathUpdates, restoreProfilePathUpdates } = require('./lib/profile-path-references')
const { prepareProfileLaunch, finalizeProfileLaunch } = require('./lib/profile-launch')
const { animateWindow, clearWindowAnimation } = require('./lib/window-transitions')
const { ConsoleWindowGuard } = require('./lib/console-window-guard')
const consoleGuard = new ConsoleWindowGuard(__dirname)
const { AutoUpdater, ReleaseResolver, installedVersion, newerVersion } = require('./lib/tool-updates')

const windows = new Set()
const ptyRegistry = new PtyRegistry((proc, session) => {
  stopPtyGracefully(proc, session.exited)
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
const renamingTools = new Set()

let tray = null
let installHistoryLoaded = false
const releaseResolver = new ReleaseResolver(net?.fetch ? net.fetch.bind(net) : undefined)
const autoUpdater = new AutoUpdater({
  tools: TOOLS, systemRoot: SYSTEM_ROOT, listProfiles: (id) => profileStore.list(id), resolver: releaseResolver,
  readVersion: (tool, _root, profile) => readProfileVersion(tool, profile),
  isBusy: (toolId) => quitting || installJobs.has(toolId) || toolHasActiveSession(toolId),
  install: async (toolId, profileId, release) => {
    const result = await installTool(-1, toolId, profileId, release)
    if (!result.ok) return result
    return installJobs.get(toolId)?.completion || result
  }
})

let quitting = false
let quitReady = false
let startupReady = false

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
  if (senderId <= 0) return
  const target = sendTargets.get(senderId) || webContents.fromId(senderId)
  if (target && !target.isDestroyed()) target.send(channel, payload)
}

function profileInstallKey(toolId, profileId = DEFAULT_PROFILE_ID) {
  validateProfileId(profileId)
  return `${toolId}\u0000${profileId}`
}

function profileWorkspaceDir(tool, profile) {
  const root = path.join(profileDir(tool, profile, SYSTEM_ROOT), 'workspace')
  fs.mkdirSync(root, { recursive: true })
  return root
}

function profilesWithInstallState(tool, profiles) {
  return profiles.map((profile) => ({
    ...profile,
    installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile)),
    installing: installJobs.has(tool.id),
    installPercent: installJobs.get(tool.id)?.percent || 0,
    installLine: installJobs.get(tool.id)?.lastLine || ''
  }))
}

function profileHasActiveSession(toolId, profileId) {
  return renamingTools.has(toolId)
    || ptyRegistry.entries().some(([, session]) => session.toolId === toolId && session.profileId === profileId)
    || [...terminalLaunches.values()].some((launch) => launch.toolId === toolId && launch.profileId === profileId)
    || closingProfiles.has(profileInstallKey(toolId, profileId))
    || editingProfiles.has(profileInstallKey(toolId, profileId))
}

function toolHasActiveSession(toolId) {
  return renamingTools.has(toolId)
    || ptyRegistry.entries().some(([, session]) => session.toolId === toolId)
    || [...terminalLaunches.values()].some((launch) => launch.toolId === toolId)
    || [...closingProfiles.keys()].some((key) => key.startsWith(`${toolId}\u0000`))
    || [...editingProfiles].some((key) => key.startsWith(`${toolId}\u0000`))
}

function profilesConflict(left, right) {
  if (left.id === right.id) return true
  return ['sharedSessions', 'sharedModels', 'sharedConfig', 'sharedSkills', 'sharedMcp'].some((key) => left.settings?.[key] && right.settings?.[key])
}

function persistSessionProfile(session) {
  if (!session) return Promise.resolve()
  if (session.persistPromise) return session.persistPromise
  session.persistPromise = (async () => {
    await finalizeProfileLaunch(session.tool, profileDir(session.tool, session.profile, SYSTEM_ROOT))
    await persistSharedProfileData(session.tool, session.profile, SYSTEM_ROOT)
  })()
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
  if (!profile) return
  prepareProfileDirectories(tool, profile)
  writeProfileDocumentSync(tool, profile, SYSTEM_ROOT)
}

function broadcastInstall(job, channel, payload) {
  for (const senderId of job.subscribers) safeSend(senderId, channel, payload)
}

async function loadInstallHistory() {
  if (installHistoryLoaded) return
  const profilesByTool = await profileStore.ensureTools(TOOLS.map((tool) => tool.id))
  for (const tool of TOOLS) {
    for (const profile of profilesByTool[tool.id] || []) {
      const log = findLatestInstallLog(profileDir(tool, profile, SYSTEM_ROOT))
      if (log) installHistory.set(profileInstallKey(tool.id, profile.id), log)
    }
  }
  installHistoryLoaded = true
}

function latestInstallLogForTool(toolId) {
  let latest = null
  let timestamp = -1
  for (const [key, file] of installHistory) {
    if (!key.startsWith(`${toolId}\u0000`)) continue
    try {
      const mtime = fs.statSync(file).mtimeMs
      if (mtime > timestamp) { latest = file; timestamp = mtime }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return latest
}

function flushInstallProgress(job) {
  clearTimeout(job.progressTimer)
  job.progressTimer = null
  if (!job.pendingProgress || job.settled) return
  const payload = job.pendingProgress
  job.pendingProgress = null
  const signature = `${payload.percent}:\u0000${payload.line}:${payload.elapsedSeconds}`
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
    logAvailable: true,
    elapsedSeconds: Math.floor((Date.now() - job.startedAt) / 1000)
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
    opacity: visualTestMode ? 1 : 0,
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
  newWin.on('show', () => { if (!visualTestMode) animateWindow(newWin, 'show') })
  newWin.on('restore', () => { if (!visualTestMode) animateWindow(newWin, 'show') })

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
    clearWindowAnimation(newWin)
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

ipcMain.handle('tools:list', async (event) => {
  await loadInstallHistory()
  const profilesByTool = await profileStore.ensureTools(TOOLS.map((tool) => tool.id))
  for (const job of installJobs.values()) job.subscribers.add(event.sender.id)
  return TOOLS.map((tool) => {
    const job = installJobs.get(tool.id)
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
    installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profilesByTool[tool.id][0])),
    installing: Boolean(job),
    installPercent: job?.percent || 0,
    hasLog: Boolean(latestInstallLogForTool(tool.id)),
    source: tool.installer?.package || tool.installer?.url || tool.installer?.repo || 'manual setup',
    profile: profileDir(tool, profilesByTool[tool.id][0], SYSTEM_ROOT)
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
    const existing = ptyRegistry.entries().find(([, session]) => session.toolId === tool.id && session.profileId === profile.id)
    if (existing) {
      const content = webContents.fromId(existing[0])
      const win = content && BrowserWindow.fromWebContents(content)
      if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return { ok: true, reused: true } }
    }
    if (!resolveLocalExecutable(tool, SYSTEM_ROOT, profile)) {
      return { ok: false, error: 'This CLI has not been installed yet' }
    }
  }
  createWindow({ toolId: tool.id, profileId, auxiliary: profileId !== null })
  return { ok: true }
})

ipcMain.handle('profiles:list', async (event, toolId) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found', profiles: [] }
  for (const job of installJobs.values()) { if (job.toolId === tool.id) job.subscribers.add(event.sender.id) }
  return { ok: true, profiles: profilesWithInstallState(tool, await profileStore.list(tool.id)), capabilities: sharingCapabilities(tool.id) }
})

ipcMain.handle('profiles:create', async (event, toolId, name, settings = {}) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  if (renamingTools.has(tool.id)) return { ok: false, error: 'Wait for this CLI profile rename to finish' }
  let profile
  try {
    const normalizedName = normalizeProfileName(name)
    const proposed = profileDir(tool, { id: DEFAULT_PROFILE_ID, name: normalizedName }, SYSTEM_ROOT)
    if (fs.existsSync(proposed)) throw new Error('A profile folder with this name already exists')
    profile = await profileStore.create(tool.id, normalizedName, settings)
    prepareProfileDirectories(tool, profile)
    writeProfileDescriptor(tool, profile)
    return { ok: true, profile: { ...profile, installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT)) } }
  } catch (error) {
    if (profile) {
      try {
        await profileStore.delete(tool.id, profile.id)
        await fs.promises.rm(profileDir(tool, profile, SYSTEM_ROOT), { recursive: true, force: true })
      } catch (rollbackError) {}
    }
    return { ok: false, error: String(error.message || error) }
  }
})

ipcMain.handle('profiles:rename', async (event, toolId, profileId, name) => {
  const tool = findTool(toolId)
  if (!tool) return { ok: false, error: 'Tool not found' }
  if (toolHasActiveSession(tool.id) || installJobs.has(tool.id)) {
    return { ok: false, error: 'Close this CLI’s sessions and finish its installation before renaming a profile' }
  }
  renamingTools.add(tool.id)
  const key = profileInstallKey(tool.id, profileId)
  editingProfiles.add(key)
  let previous
  let moved = false
  let journaled = false
  let previousLog
  let source
  let destination
  let newDocumentName
  let pathUpdates
  try {
    previous = await profileStore.get(tool.id, profileId)
    if (!previous) return { ok: false, error: 'Profile not found' }
    const normalizedName = normalizeProfileName(name)
    newDocumentName = profileDocumentName(tool, { ...previous, name: normalizedName })
    source = profileDir(tool, previous, SYSTEM_ROOT)
    destination = profileDir(tool, { ...previous, name: normalizedName }, SYSTEM_ROOT)
    pathUpdates = await planProfilePathUpdates(tool, previous, normalizedName, await profileStore.list(tool.id), SYSTEM_ROOT)
    if (source !== destination) {
      const exists = fs.existsSync(destination)
      if (exists && source.toLowerCase() !== destination.toLowerCase()) throw new Error('A profile folder with this name already exists')
      await recordPendingRename(SYSTEM_ROOT, tool, previous, normalizedName)
      journaled = true
      if (source.toLowerCase() === destination.toLowerCase()) {
        const temporary = path.join(path.dirname(source), `.renaming-${profileId}`)
        if (fs.existsSync(temporary)) throw new Error('An unfinished profile rename needs recovery')
        await fs.promises.rename(source, temporary)
        try { await fs.promises.rename(temporary, destination) } catch (error) {
          await fs.promises.rename(temporary, source)
          throw error
        }
      } else await fs.promises.rename(source, destination)
      moved = true
    }
    const profile = await profileStore.rename(tool.id, profileId, normalizedName)
    await applyProfilePathUpdates(pathUpdates)
    if (previous.name !== profile.name) {
      await fs.promises.rm(path.join(destination, profileDocumentName(tool, previous)), { force: true })
    }
    writeProfileDescriptor(tool, profile)
    previousLog = installHistory.get(key)
    if (previousLog) installHistory.set(key, path.join(destination, 'logs', path.basename(previousLog)))
    if (journaled) await clearPendingRename(SYSTEM_ROOT, tool, profileId)
    return { ok: true, profile: { ...profile, installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile)) } }
  } catch (error) {
    if (pathUpdates?.applied.length) {
      try { await restoreProfilePathUpdates(pathUpdates) } catch (rollbackError) {
        return { ok: false, error: `Profile rename could not be rolled back safely. Restart OmniShell to recover it: ${String(rollbackError.message || rollbackError)}` }
      }
    }
    if (previousLog) installHistory.set(key, previousLog)
    if (moved && fs.existsSync(destination) && !fs.existsSync(source)) {
      try { await fs.promises.rename(destination, source) } catch (rollbackError) {}
    }
    if (previous && (await profileStore.get(tool.id, profileId))?.name !== previous.name) {
      try { await profileStore.rename(tool.id, profileId, previous.name) } catch (rollbackError) {}
    }
    if (previous && source && fs.existsSync(source) && (await profileStore.get(tool.id, profileId))?.name === previous.name) {
      try {
        writeProfileDescriptor(tool, previous)
        if (newDocumentName && newDocumentName !== profileDocumentName(tool, previous)) {
          await fs.promises.rm(path.join(source, newDocumentName), { force: true })
        }
      } catch (rollbackError) {}
    }
    if (journaled && fs.existsSync(source) && !fs.existsSync(path.join(path.dirname(source), `.renaming-${profileId}`))
      && (await profileStore.get(tool.id, profileId))?.name === previous.name) {
      try { await clearPendingRename(SYSTEM_ROOT, tool, profileId) } catch (rollbackError) {}
    }
    const restored = !previous || ((await profileStore.get(tool.id, profileId))?.name === previous.name && (!moved || fs.existsSync(source)))
    return { ok: false, error: restored
      ? `This profile name could not be used. The previous name was restored: ${String(error.message || error)}`
      : `Profile rename could not be rolled back safely. Restart OmniShell to recover it: ${String(error.message || error)}` }
  } finally {
    editingProfiles.delete(key)
    renamingTools.delete(tool.id)
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
    return { ok: true, profile: { ...profile, installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile)) } }
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
  if (installJobs.has(tool.id)) return { ok: false, error: 'Cancel the CLI installation before deleting this profile' }
  const key = profileInstallKey(tool.id, profileId)
  editingProfiles.add(key)
  let source
  let destination
  try {
    const profile = await profileStore.get(tool.id, profileId)
    if (!profile) return { ok: false, error: 'Profile not found' }
    source = profileDir(tool, profile, SYSTEM_ROOT)
    destination = path.join(SYSTEM_ROOT, '_profiles', 'trash', tool.id, `${profile.name}-${Date.now()}`)
    if (fs.existsSync(source)) {
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.rename(source, destination)
    }
    await profileStore.delete(tool.id, profile.id)
    installHistory.delete(key)
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

ipcMain.on('win:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) animateWindow(win, 'hide', () => { win.minimize(); win.setOpacity(1) })
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
  await loadInstallHistory()
  const profile = await profileStore.get(tool.id, profileId)
  const logPath = installHistory.get(profileInstallKey(id, profileId)) || latestInstallLogForTool(id)
  if (kind === 'log' && !logPath) return { ok: false, error: 'No installation log is available in this session' }
  if (kind === 'profile' && !profile) {
    return { ok: false, error: 'Profile not found' }
  }
  const target = kind === 'log'
    ? path.dirname(logPath)
    : prepareProfileDirectories(tool, profile)
  if (!fs.existsSync(target)) return { ok: false, error: 'Folder not found' }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('tool:check', async (event, id, profileId = DEFAULT_PROFILE_ID) => {
  const tool = findTool(id)
  if (!tool) return { installed: false, error: 'Tool not found' }
  try { validateProfileId(profileId) } catch (error) { return { installed: false, error: error.message } }
  const profile = await profileStore.get(tool.id, profileId)
  if (!profile) return { installed: false, error: 'Profile not found' }
  const executable = resolveLocalExecutable(tool, SYSTEM_ROOT, profile)
  return {
    installed: Boolean(executable),
    isLocal: Boolean(executable),
    installable: Boolean(tool.installer),
    hint: tool.hint || ''
  }
})

async function readProfileVersion(tool, profile, fresh = false) {
  if (tool.installer?.type !== 'npm') await consoleGuard.ready()
  return installedVersion(tool, SYSTEM_ROOT, profile, {
    fresh, watch: (pid) => consoleGuard.watch(pid), unwatch: (pid) => consoleGuard.unwatch(pid)
  })
}

async function installTool(senderId, id, profileId = DEFAULT_PROFILE_ID, knownRelease = null) {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }
  let profile
  try { profile = await profileStore.get(tool.id, profileId) } catch (error) { return { ok: false, error: error.message } }
  if (!profile) return { ok: false, error: 'Profile not found' }
  if (quitting) return { ok: false, busy: true, error: 'OmniShell is closing' }
  const key = tool.id
  if (toolHasActiveSession(tool.id)) return { ok: false, busy: true, error: 'Close all profiles of this CLI before updating it' }
  if (!tool.installer) return { ok: false, manual: true, error: 'This tool requires manual installation' }
  const existing = installJobs.get(key)
  if (existing) {
    if (senderId > 0) existing.subscribers.add(senderId)
    queueInstallProgress(existing, true)
    return { ok: true, joined: true }
  }
  let reporter
  try {
    reporter = createInstallReporter({ ...tool, name: `${tool.name} / ${profile.name}` }, profileDir(tool, profile, SYSTEM_ROOT))
  } catch (error) { return { ok: false, error: `Could not create installer log: ${error.message}` } }
  const job = {
    key, toolId: tool.id, profileId: profile.id, proc: null, reporter,
    subscribers: new Set([...sendTargets.keys(), senderId].filter((value) => value > 0)),
    lastLine: 'Checking the latest release...', percent: 1, startedAt: Date.now(), lastActivity: Date.now(),
    cancelled: false, settled: false, pendingProgress: null, progressTimer: null, lastProgressSignature: ''
  }
  installJobs.set(key, job)
  installHistory.set(profileInstallKey(tool.id, profile.id), reporter.logPath)
  queueInstallProgress(job, true)
  const heartbeat = setInterval(() => {
    if (job.settled) return
    if (job.proc && Date.now() - job.lastActivity > 5 * 60 * 1000 && !job.cancelled) {
      job.failure = 'The installer stopped responding. Check the connection and retry.'
      job.cancelled = true
      terminateProcessTree(job.proc)
    }
    queueInstallProgress(job)
  }, 1000)
  heartbeat.unref?.()
  job.completion = (async () => {
    let result
    try {
      const before = await readProfileVersion(tool, profile)
      const release = knownRelease || await releaseResolver.resolve(tool, true)
      if (job.cancelled || quitting) throw new Error('Installation cancelled.')
      job.percent = 3
      job.lastLine = before ? `Updating ${tool.name}: ${before} → ${release.version}` : `Installing ${tool.name} ${release.version}`
      reporter.feed('info', `${job.lastLine}\n`)
      queueInstallProgress(job, true)
      const plan = createInstallPlan(tool, __dirname, SYSTEM_ROOT, profile, release.version)
      if (!plan) throw new Error('No installer is configured for this tool')
      const code = await new Promise((resolve, reject) => {
        const proc = spawn(plan.command, plan.args, {
          cwd: plan.cwd, env: createInstallEnvironment(tool, process.env, SYSTEM_ROOT, profile), windowsHide: true
        })
        job.proc = proc
        const feed = (stream, chunk) => {
          job.lastActivity = Date.now()
          job.lastLine = reporter.feed(stream, chunk) || job.lastLine
          job.percent = Math.max(job.percent, reporter.progress, inferInstallPercent(tool, job.lastLine, job.percent))
          queueInstallProgress(job)
        }
        proc.stdout.on('data', (chunk) => feed('stdout', chunk))
        proc.stderr.on('data', (chunk) => feed('stderr', chunk))
        proc.once('error', reject)
        proc.once('close', resolve)
      })
      if (job.cancelled || quitting) throw new Error(job.failure || 'Installation cancelled.')
      if (code !== 0) throw new Error(reporter.failure(`Installer exited with code ${code}`))
      if (!resolveLocalExecutable(tool, SYSTEM_ROOT, profile)) throw new Error('The local executable was not found after installation')
      job.lastLine = 'Checking installed version...'
      job.percent = Math.max(job.percent, 96)
      queueInstallProgress(job, true)
      const actual = await readProfileVersion(tool, profile, true)
      if (!actual || newerVersion(release.version, actual)) {
        throw new Error(`Expected ${release.version}, but the installed CLI reports ${actual || 'an unknown version'}`)
      }
      result = { ok: true, version: actual }
      job.percent = 100
      job.lastLine = `${tool.name} ${actual} is ready`
      queueInstallProgress(job, true)
    } catch (error) {
      const message = String(error.message || error)
      reporter.feed('error', `${message}\n`)
      result = { ok: false, error: message, cancelled: job.cancelled && !job.failure }
    } finally {
      clearInterval(heartbeat)
      clearTimeout(job.progressTimer)
      job.settled = true
      reporter.finish(result?.ok ? 'success' : (result?.cancelled ? 'cancelled' : 'failed'))
      await cleanupInstallArtifacts(tool, SYSTEM_ROOT).catch(console.error)
      installJobs.delete(key)
      broadcastInstall(job, 'install:done', { toolId: tool.id, profileId: profile.id, ...result, installed: Boolean(resolveLocalExecutable(tool, SYSTEM_ROOT, profile)), logAvailable: true })
    }
    return result
  })()
  return { ok: true, joined: false }
}

ipcMain.handle('tool:install', (event, id, profileId) => installTool(event.sender.id, id, profileId))

ipcMain.handle('tool:cancel-install', (event, id, profileId = DEFAULT_PROFILE_ID) => {
  let jobKey
  try { validateProfileId(profileId); jobKey = id } catch (error) { return { ok: false, error: error.message } }
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
    if (renamingTools.has(tool.id) || editingProfiles.has(profileInstallKey(tool.id, profile.id))) return { ok: false, error: 'Wait for this profile change to finish' }
    if (installJobs.has(tool.id)) return { ok: false, error: 'Wait for this CLI installation to finish' }
    const busyProfiles = [
      ...ptyRegistry.entries().map(([, session]) => session),
      ...[...terminalLaunches.values()].filter((candidate) => candidate !== launch && candidate.profile)
    ]
    if (busyProfiles.some((candidate) => candidate.toolId === tool.id && profilesConflict(profile, candidate.profile))) {
      return { ok: false, error: 'Close the active profile using this profile or its shared data before opening it here' }
    }
    launch.profile = profile

    prepareProfileDirectories(tool, profile)
    const cwd = profileWorkspaceDir(tool, profile)
    await hydrateSharedProfileData(tool, profile, SYSTEM_ROOT)
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }

    const startCols = Number.isInteger(cols) ? Math.max(11, Math.min(cols, 1000)) : 90
    const startRows = Number.isInteger(rows) ? Math.max(6, Math.min(rows, 500)) : 28
    const startPixelWidth = Number.isInteger(pixelWidth) ? Math.max(1, Math.min(pixelWidth, 16384)) : startCols * 9
    const startPixelHeight = Number.isInteger(pixelHeight) ? Math.max(1, Math.min(pixelHeight, 16384)) : startRows * 18
    const launchExe = resolveLocalExecutable(tool, SYSTEM_ROOT, profile)
    if (!launchExe) return { ok: false, error: 'The shared CLI installation was not found' }

    await consoleGuard.ready()
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }
    const pty = require('node-pty')
    const basePtyEnv = createIsolatedEnvironment(tool, process.env, SYSTEM_ROOT, profile)
    const launchPolicy = await prepareProfileLaunch(tool, profile, profileDir(tool, profile, SYSTEM_ROOT), basePtyEnv)
    if (!isCurrentLaunch()) return { ok: false, error: 'Launch cancelled' }
    const ptyEnv = launchPolicy.env
    ptyEnv.PWD = cwd
    ptyEnv.INIT_CWD = cwd
    ptyEnv.GIT_CEILING_DIRECTORIES = cwd
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

    consoleGuard.watch(ptyProc.pid)
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
      consoleGuard.unwatch(ptyProc.pid)
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
    if (!startupReady) return
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

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  prepareAllTools()
  await profileStore.load()
  await recoverPendingRenames(profileStore, TOOLS, SYSTEM_ROOT)
  await migrateProfileLayout(profileStore, TOOLS, SYSTEM_ROOT, app.getPath('userData'))
  await migrateSharedInstallations(profileStore, TOOLS, SYSTEM_ROOT)
  await migrateProfileDocuments(profileStore, TOOLS, SYSTEM_ROOT)
  for (const tool of TOOLS) await migrateLegacySharedMcp(tool, SYSTEM_ROOT)
  await loadInstallHistory()
  startupReady = true
  createWindow()
  createTray()
  consoleGuard.ready()
  if (process.env.OMNISHELL_DISABLE_AUTO_UPDATE !== '1') autoUpdater.start().catch(console.error)

  globalShortcut.register('Ctrl+Alt+S', () => {
    if (windows.size === 0) {
      createWindow()
      return
    }
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && focused.isVisible()) {
      animateWindow(focused, 'hide', () => focused.hide())
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
}).catch((error) => {
  console.error(`[PROFILE MIGRATION] ${String(error.stack || error)}`)
  dialog.showErrorBox('OmniShell profile migration failed', `${String(error.message || error)}\n\nYour existing profile files were not replaced. Close OmniShell and resolve the folder conflict before trying again.`)
  app.quit()
})

app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  autoUpdater.stop()
  releaseResolver.cancel()
  const installing = [...installJobs.values()]
  for (const job of installing) { job.cancelled = true; if (job.proc) terminateProcessTree(job.proc) }
  const closing = killAllPtys()
  Promise.allSettled([...closing, ...closingProfiles.values(), ...pendingProfileWrites, ...installing.map((job) => job.completion)]).then(() => {
    quitReady = true
    app.quit()
  })
})

app.on('will-quit', () => {
  consoleGuard.stop()
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
