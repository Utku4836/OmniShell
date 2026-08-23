const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const windows = new Set()
const windowPtyMap = new Map()
const windowInitialTools = new Map()
const windowResizeStates = new Map()

let tray = null

const SYSTEM_ROOT = path.join(__dirname, '..', 'system')

const TOOLS = [
  { id: 'claude', name: 'Claude Code', category: 'ai', dir: 'ClaudeCode', bin: 'claude', install: { type: 'npm', pkg: '@anthropic-ai/claude-code' }, configDir: '.claude', envKey: 'CLAUDE_CONFIG_DIR' },
  { id: 'codex', name: 'Codex', category: 'ai', dir: 'Codex', bin: 'codex', install: { type: 'npm', pkg: '@openai/codex' }, configDir: '.codex', envKey: 'CODEX_HOME' },
  { id: 'opencode', name: 'OpenCode', category: 'ai', dir: 'OpenCode', bin: 'opencode', install: { type: 'npm', pkg: 'opencode-ai' }, configDir: '.opencode', envKey: 'OPENCODE_CONFIG_DIR' },
  { id: 'kilo', name: 'Kilo Code', category: 'ai', dir: 'KiloCode', bin: 'kilo', install: { type: 'npm', pkg: '@kilocode/cli' }, configDir: '.kilo', envKey: 'KILO_CONFIG_DIR' },
  { id: 'agy', name: 'Antigravity CLI', category: 'ai', dir: 'Antigravity', bin: 'agy', install: { type: 'ps1', url: 'https://antigravity.google/cli/install.ps1' }, configDir: '.agy', envKey: 'AGY_HOME' },
  { id: 'aider', name: 'Aider', category: 'ai', dir: 'Aider', bin: 'aider', install: { type: 'ps1', url: 'https://aider.chat/install.ps1' }, configDir: '.aider', envKey: 'AIDER_CONFIG_DIR' },
  { id: 'copilot', name: 'GitHub Copilot CLI', category: 'ai', dir: 'CopilotCLI', bin: 'copilot', install: { type: 'npm', pkg: '@github/copilot' }, configDir: '.copilot', envKey: 'COPILOT_CONFIG_DIR' },
  { id: 'cursor-agent', name: 'Cursor Agent', category: 'ai', dir: 'CursorAgent', bin: 'cursor-agent', install: { type: 'npm', pkg: 'cursor-agent' }, configDir: '.cursor', envKey: 'CURSOR_CONFIG_DIR' },
  { id: 'amp', name: 'Amp', category: 'ai', dir: 'Amp', bin: 'amp', install: { type: 'npm', pkg: '@ampcode/cli' }, configDir: '.amp', envKey: 'AMP_CONFIG_DIR' },
  { id: 'goose', name: 'Goose', category: 'ai', dir: 'Goose', bin: 'goose', install: { type: 'pip', pkg: 'goose-ai' }, configDir: '.goose', envKey: 'GOOSE_HOME' },
  { id: 'crush', name: 'Crush', category: 'ai', dir: 'Crush', bin: 'crush', install: { type: 'npm', pkg: '@charmbracelet/crush' }, configDir: '.crush', envKey: 'CRUSH_CONFIG_DIR' },
  { id: 'qwen', name: 'Qwen Code', category: 'ai', dir: 'QwenCode', bin: 'qwen', install: { type: 'npm', pkg: '@qwen-code/qwen-code' }, configDir: '.qwen', envKey: 'QWEN_CONFIG_DIR' },
  { id: 'webtorrent', name: 'WebTorrent CLI', category: 'torrent', dir: 'WebTorrent', bin: 'webtorrent', install: { type: 'npm', pkg: 'webtorrent-cli' }, configDir: '.webtorrent', envKey: 'WEBTORRENT_HOME' },
  { id: 'torlink', name: 'Torlink', category: 'torrent', dir: 'Torlink', bin: 'torlnk', install: { type: 'npm', pkg: 'torlnk' }, configDir: '.torlink', envKey: 'TORLINK_HOME' }
]

function findTool(id) {
  return TOOLS.find(t => t.id === id)
}

function toolDir(tool) {
  return path.join(SYSTEM_ROOT, tool.dir)
}

function localNpmBinPath(tool) {
  const binDir = path.join(toolDir(tool), 'node_modules', '.bin')
  const names = [tool.bin]
  if (tool.id === 'torlink') names.push('torlink', 'torlnk')
  const exts = ['.cmd', '.exe', '.bat', '']
  for (const n of names) {
    for (const ext of exts) {
      const candidate = path.join(binDir, n + ext)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return path.join(binDir, tool.bin + '.cmd')
}

function localPipBinPath(tool) {
  const scriptsDir = path.join(toolDir(tool), 'Scripts')
  const exts = ['.exe', '.cmd', '.bat', '']
  for (const ext of exts) {
    const candidate = path.join(scriptsDir, tool.bin + ext)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(scriptsDir, tool.bin + '.exe')
}

function localPs1BinPath(tool) {
  const localAppData = process.env.LOCALAPPDATA || ''
  const userProfile = process.env.USERPROFILE || ''
  const candidates = [
    path.join(userProfile, '.local', 'bin', tool.bin + '.exe'),
    path.join(toolDir(tool), 'bin', tool.bin + '.exe'),
    path.join(toolDir(tool), tool.bin + '.exe'),
    path.join(localAppData, tool.bin, 'bin', tool.bin + '.exe'),
    path.join(localAppData, 'Programs', tool.bin, 'bin', tool.bin + '.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Launcher', tool.bin + '.exe'),
    path.join(toolDir(tool), 'bin', 'agy.exe')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return path.join(userProfile, '.local', 'bin', tool.bin + '.exe')
}

function localBinExists(tool) {
  if (!tool.install) return false
  try {
    if (tool.install.type === 'npm') {
      const p = localNpmBinPath(tool)
      return fs.existsSync(p)
    }
    if (tool.install.type === 'pip') {
      const p = localPipBinPath(tool)
      return fs.existsSync(p)
    }
    if (tool.install.type === 'ps1') {
      const p = localPs1BinPath(tool)
      return fs.existsSync(p)
    }
  } catch (e) {}
  return false
}

function checkGlobalBin(tool) {
  return new Promise((resolve) => {
    const proc = spawn('where', [tool.bin], { windowsHide: true })
    let stdout = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        const firstLine = stdout.trim().split(/\r?\n/)[0].trim()
        resolve({ installed: true, isGlobal: true, path: firstLine })
      } else {
        resolve({ installed: false })
      }
    })
    proc.on('error', () => resolve({ installed: false }))
  })
}

function ensureSystemFolders() {
  fs.mkdirSync(SYSTEM_ROOT, { recursive: true })
  fs.mkdirSync(path.join(SYSTEM_ROOT, '_install'), { recursive: true })
  TOOLS.forEach(t => {
    const dir = toolDir(t)
    fs.mkdirSync(dir, { recursive: true })
    if (t.configDir) {
      const cfgPath = path.join(dir, t.configDir)
      fs.mkdirSync(cfgPath, { recursive: true })
      // Create local boundary config files so CLI tools never walk up to %USERPROFILE%
      const confFile = path.join(cfgPath, `${t.id}.json`)
      if (!fs.existsSync(confFile)) {
        try { fs.writeFileSync(confFile, '{}', 'utf8') } catch (e) {}
      }
    }
    // Isolated XDG & AppData directories for complete independence
    const xdgConfig = path.join(dir, '.config', t.id)
    const xdgData = path.join(dir, '.local', 'share', t.id)
    fs.mkdirSync(xdgConfig, { recursive: true })
    fs.mkdirSync(xdgData, { recursive: true })
    fs.mkdirSync(path.join(dir, '.local', 'state', t.id), { recursive: true })
    fs.mkdirSync(path.join(dir, '.cache', t.id), { recursive: true })
    fs.mkdirSync(path.join(dir, 'AppData', 'Roaming', t.id), { recursive: true })
    fs.mkdirSync(path.join(dir, 'AppData', 'Local', t.id), { recursive: true })

    const xdgConfFile = path.join(xdgConfig, `${t.id}.json`)
    if (!fs.existsSync(xdgConfFile)) {
      try { fs.writeFileSync(xdgConfFile, '{}', 'utf8') } catch (e) {}
    }

    if (t.category === 'torrent') {
      fs.mkdirSync(path.join(dir, 'Downloads'), { recursive: true })
    }
    if (t.install && t.install.type === 'npm') {
      const pkgJson = path.join(dir, 'package.json')
      if (!fs.existsSync(pkgJson)) {
        try {
          fs.writeFileSync(pkgJson, JSON.stringify({ name: `siyah-${t.id}`, version: '1.0.0', private: true }, null, 2), 'utf8')
        } catch (e) {}
      }
    }
  })
}

function writeInstallBatch(tool) {
  const dir = toolDir(tool)
  const batPath = path.join(SYSTEM_ROOT, '_install', tool.id + '.cmd')
  let content

  if (tool.install.type === 'npm') {
    content =
      '@echo off\r\n' +
      'cd /d "' + dir + '"\r\n' +
      'call npm install "' + tool.install.pkg + '" --save --no-fund --no-audit\r\n' +
      'exit /b %errorlevel%\r\n'
  } else if (tool.install.type === 'ps1') {
    content =
      '@echo off\r\n' +
      'cd /d "' + dir + '"\r\n' +
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:AGY_INSTALL_DIR=\'' + dir + '\'; irm ' + tool.install.url + ' | iex"\r\n' +
      'exit /b %errorlevel%\r\n'
  } else {
    content =
      '@echo off\r\n' +
      'cd /d "' + dir + '"\r\n' +
      'python -m venv "' + dir + '"\r\n' +
      'if errorlevel 1 exit /b %errorlevel%\r\n' +
      'call "' + path.join(dir, 'Scripts', 'python.exe') + '" -m pip install --upgrade pip setuptools wheel\r\n' +
      'call "' + path.join(dir, 'Scripts', 'pip.exe') + '" install ' + tool.install.pkg + '\r\n' +
      'exit /b %errorlevel%\r\n'
  }

  fs.writeFileSync(batPath, content, 'utf8')
  return batPath
}

function createWindow(initialToolId = null) {
  const offset = (windows.size % 8) * 28

  const newWin = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 340,
    center: windows.size === 0,
    x: windows.size > 0 ? undefined : undefined,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: true,
    hasShadow: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const webContentsId = newWin.webContents.id
  if (initialToolId) {
    windowInitialTools.set(webContentsId, initialToolId)
  }

  windows.add(newWin)

  newWin.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER LOG] ${message} (${sourceId}:${line})`)
  })

  newWin.webContents.on('did-fail-load', (e, code, desc) => {
    console.error(`[DID FAIL LOAD] ${code}: ${desc}`)
  })

  newWin.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  newWin.once('ready-to-show', () => {
    newWin.show()
    newWin.focus()
  })

  newWin.on('closed', () => {
    killPtyForSender(webContentsId)
    windows.delete(newWin)
    windowInitialTools.delete(webContentsId)
    windowResizeStates.delete(webContentsId)
  })

  return newWin
}

function killPtyForSender(senderId) {
  const p = windowPtyMap.get(senderId)
  if (p) {
    try { p.kill() } catch (e) {}
    windowPtyMap.delete(senderId)
  }
}

function killAllPtys() {
  for (const [senderId, p] of windowPtyMap.entries()) {
    try { p.kill() } catch (e) {}
  }
  windowPtyMap.clear()
}

function createTray() {
  if (tray) return
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'))
  tray.setToolTip('Black App')

  const ctxMenu = Menu.buildFromTemplate([
    { label: 'New Window', click: () => { createWindow() } },
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

ipcMain.handle('tools:list', () => {
  return TOOLS.map(t => ({ id: t.id, name: t.name, category: t.category }))
})

ipcMain.handle('window:get-initial-tool', (event) => {
  return windowInitialTools.get(event.sender.id) || null
})

ipcMain.handle('window:open-tool', (event, toolId) => {
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

ipcMain.handle('tool:check', async (e, id) => {
  const tool = findTool(id)
  if (!tool) return { installed: false }

  if (localBinExists(tool)) {
    return { installed: true, isLocal: true }
  }

  const globalCheck = await checkGlobalBin(tool)
  if (globalCheck.installed) {
    return { installed: true, isGlobal: true, path: globalCheck.path }
  }

  return { installed: false, hint: tool.hint || '' }
})

ipcMain.handle('tool:install', (event, id) => {
  const tool = findTool(id)
  if (!tool || !tool.install) {
    if (!event.sender.isDestroyed()) {
      event.sender.send('install:done', { ok: false, manual: true, hint: tool ? tool.hint : '' })
    }
    return
  }

  ensureSystemFolders()
  const batPath = writeInstallBatch(tool)
  const proc = spawn('cmd.exe', ['/d', '/s', '/c', batPath], { windowsHide: true })
  
  let currentPercent = 6

  // Send immediate feedback
  if (!event.sender.isDestroyed()) {
    event.sender.send('install:progress', {
      percent: currentPercent,
      line: `Installing ${tool.name}...`
    })
  }

  // Smooth ticker so user never sees 0% stuck
  const ticker = setInterval(() => {
    if (currentPercent < 90) {
      currentPercent += (currentPercent < 45 ? 4 : (currentPercent < 75 ? 2 : 1))
      if (!event.sender.isDestroyed()) {
        event.sender.send('install:progress', {
          percent: currentPercent,
          line: `Downloading and installing ${tool.name}...`
        })
      }
    }
  }, 450)

  let lastLine = ''

  const feed = (chunk) => {
    const text = chunk.toString()
    const lines = text.split(/\r?\n|\r/).filter(l => l.trim().length > 0)
    if (lines.length > 0) {
      lastLine = lines[lines.length - 1].slice(0, 160)
    }
    const matches = text.match(/(\d{1,3})%/g)
    if (matches) {
      matches.forEach(m => {
        const val = parseInt(m, 10)
        if (val > currentPercent && val <= 95) currentPercent = val
      })
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send('install:progress', {
        percent: currentPercent,
        line: lastLine || `Installing ${tool.name}...`
      })
    }
  }

  proc.stdout.on('data', feed)
  proc.stderr.on('data', feed)

  proc.on('close', (code) => {
    clearInterval(ticker)
    const isOk = (code === 0 && localBinExists(tool)) || localBinExists(tool)
    if (!event.sender.isDestroyed()) {
      if (isOk) {
        event.sender.send('install:progress', { percent: 100, line: 'Installation completed!' })
      }
      event.sender.send('install:done', { ok: isOk })
    }
  })
})

ipcMain.handle('terminal:stop', (event) => {
  killPtyForSender(event.sender.id)
  return { ok: true }
})

ipcMain.handle('terminal:start', async (event, id, cols, rows) => {
  const tool = findTool(id)
  if (!tool) return { ok: false, error: 'Tool not found' }

  killPtyForSender(event.sender.id)

  const cwd = toolDir(tool)
  fs.mkdirSync(cwd, { recursive: true })

  const startCols = Number.isInteger(cols) && cols > 10 ? cols : 90
  const startRows = Number.isInteger(rows) && rows > 5 ? rows : 28

  let launchExe = null

  if (localBinExists(tool)) {
    if (tool.install.type === 'npm') launchExe = localNpmBinPath(tool)
    else if (tool.install.type === 'pip') launchExe = localPipBinPath(tool)
    else if (tool.install.type === 'ps1') launchExe = localPs1BinPath(tool)
  } else {
    const g = await checkGlobalBin(tool)
    if (g.installed) {
      launchExe = g.path || tool.bin
    } else {
      return { ok: false, error: 'Local or global installation not found' }
    }
  }

  try {
    const pty = require('node-pty')

    const configHome = path.join(cwd, '.config')
    const dataHome = path.join(cwd, '.local', 'share')
    const stateHome = path.join(cwd, '.local', 'state')
    const cacheHome = path.join(cwd, '.cache')
    const roamingHome = path.join(cwd, 'AppData', 'Roaming')
    const localHome = path.join(cwd, 'AppData', 'Local')

    fs.mkdirSync(configHome, { recursive: true })
    fs.mkdirSync(dataHome, { recursive: true })
    fs.mkdirSync(stateHome, { recursive: true })
    fs.mkdirSync(cacheHome, { recursive: true })
    fs.mkdirSync(roamingHome, { recursive: true })
    fs.mkdirSync(localHome, { recursive: true })

    const drive = path.parse(cwd).root.replace(/[\/\\]$/, '')
    const homepath = cwd.slice(drive.length)

    const ptyEnv = Object.assign({}, process.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      CI: 'false',
      // Universal Environment Isolation for every CLI tool
      HOME: cwd,
      USERPROFILE: cwd,
      HOMEDRIVE: drive,
      HOMEPATH: homepath,
      APPDATA: roamingHome,
      LOCALAPPDATA: localHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: cacheHome
    })

    // 1. Tool-Specific Config & Environment Mapping
    if (tool.configDir && tool.envKey) {
      const toolHome = path.join(cwd, tool.configDir)
      fs.mkdirSync(toolHome, { recursive: true })
      ptyEnv[tool.envKey] = toolHome
    }

    // Specific AI tool aliases for 100% strict isolation
    if (tool.id === 'claude') {
      ptyEnv.CLAUDE_CONFIG_DIR = path.join(cwd, '.claude')
    } else if (tool.id === 'codex') {
      ptyEnv.CODEX_HOME = path.join(cwd, '.codex')
    } else if (tool.id === 'opencode') {
      ptyEnv.OPENCODE_CONFIG_DIR = path.join(configHome, 'opencode')
      ptyEnv.OPENCODE_DATA_DIR = path.join(dataHome, 'opencode')
      ptyEnv.OPENCODE_CACHE_DIR = path.join(cacheHome, 'opencode')
      ptyEnv.OPENCODE_HOME = path.join(cwd, '.opencode')
      ptyEnv.OPENCODE_DISABLE_AUTO_UPDATE = 'true'
    } else if (tool.id === 'agy') {
      ptyEnv.AGY_HOME = path.join(cwd, '.agy')
      ptyEnv.ANTIGRAVITY_HOME = path.join(cwd, '.agy')
    } else if (tool.id === 'aider') {
      ptyEnv.AIDER_CONFIG_DIR = path.join(cwd, '.aider')
      ptyEnv.AIDER_HOME = path.join(cwd, '.aider')
    } else if (tool.id === 'copilot') {
      ptyEnv.COPILOT_CONFIG_DIR = path.join(cwd, '.copilot')
      ptyEnv.GITHUB_COPILOT_CONFIG_DIR = path.join(cwd, '.copilot')
    } else if (tool.id === 'cursor-agent') {
      ptyEnv.CURSOR_CONFIG_DIR = path.join(cwd, '.cursor')
    } else if (tool.id === 'amp') {
      ptyEnv.AMP_CONFIG_DIR = path.join(cwd, '.amp')
    } else if (tool.id === 'goose') {
      ptyEnv.GOOSE_HOME = path.join(cwd, '.goose')
      ptyEnv.GOOSE_CONFIG_DIR = path.join(cwd, '.goose')
    } else if (tool.id === 'crush') {
      ptyEnv.CRUSH_CONFIG_DIR = path.join(cwd, '.crush')
    } else if (tool.id === 'qwen') {
      ptyEnv.QWEN_CONFIG_DIR = path.join(cwd, '.qwen')
    } else if (tool.id === 'kilo') {
      ptyEnv.KILO_CONFIG_DIR = path.join(configHome, 'kilo')
      ptyEnv.KILO_DATA_DIR = path.join(dataHome, 'kilo')
      ptyEnv.KILO_CACHE_DIR = path.join(cacheHome, 'kilo')
      ptyEnv.KILO_HOME = path.join(cwd, '.kilo')
      ptyEnv.KILO_DISABLE_AUTO_UPDATE = 'true'
      ptyEnv.OPENCODE_CONFIG_DIR = path.join(configHome, 'kilo')
      ptyEnv.OPENCODE_DATA_DIR = path.join(dataHome, 'kilo')
      ptyEnv.OPENCODE_HOME = path.join(cwd, '.kilo')
    }

    // 2. Isolate Downloads directory for torrent tools
    if (tool.category === 'torrent') {
      const downloadsDir = path.join(cwd, 'Downloads')
      fs.mkdirSync(downloadsDir, { recursive: true })
      ptyEnv.TORLINK_DOWNLOAD_DIR = downloadsDir
      ptyEnv.WEBTORRENT_PATH = downloadsDir
      ptyEnv.TORRENT_DOWNLOAD_DIR = downloadsDir
    }

    // 3. Prepend Tool-Specific Local Binary Path to PATH for self-contained execution
    const pathKey = Object.keys(ptyEnv).find(k => k.toUpperCase() === 'PATH') || 'PATH'
    const existingPath = ptyEnv[pathKey] || ''
    const localBinDirs = []

    if (tool.install && tool.install.type === 'npm') {
      localBinDirs.push(path.join(cwd, 'node_modules', '.bin'))
    } else if (tool.install && tool.install.type === 'pip') {
      localBinDirs.push(path.join(cwd, 'Scripts'))
    }
    localBinDirs.push(path.join(cwd, 'bin'), cwd)

    const prepended = localBinDirs.filter(d => fs.existsSync(d)).join(path.delimiter)
    if (prepended) {
      ptyEnv[pathKey] = prepended + path.delimiter + existingPath
    }

    // 4. WebTorrent Interactive Minimalist Launcher
    if (tool.id === 'webtorrent') {
      const launcherPath = path.join(cwd, 'launcher.cmd')
      const launcherContent =
        '@echo off\r\n' +
        'cd /d "%~dp0"\r\n' +
        'title WebTorrent\r\n' +
        ':loop\r\n' +
        'cls\r\n' +
        'echo.\r\n' +
        'set "TORRENT="\r\n' +
        'set /p "TORRENT=> "\r\n' +
        'if "%TORRENT%"=="" goto loop\r\n' +
        'echo.\r\n' +
        'call "%~dp0node_modules\\.bin\\webtorrent.cmd" "%TORRENT%" --out "%~dp0Downloads"\r\n' +
        'echo.\r\n' +
        'echo Press any key to enter another torrent...\r\n' +
        'pause >nul\r\n' +
        'goto loop\r\n'
      fs.writeFileSync(launcherPath, launcherContent, 'utf8')
      launchExe = launcherPath
    }

    const spawnOpts = {
      name: 'xterm-256color',
      cols: startCols,
      rows: startRows,
      cwd: cwd,
      env: ptyEnv
    }

    let ptyProc
    const comspec = process.env.ComSpec || 'cmd.exe'
    if (launchExe && (launchExe.toLowerCase().endsWith('.cmd') || launchExe.toLowerCase().endsWith('.bat'))) {
      ptyProc = pty.spawn(comspec, ['/d', '/s', '/c', 'call', launchExe], spawnOpts)
    } else if (launchExe && launchExe !== tool.bin && fs.existsSync(launchExe)) {
      ptyProc = pty.spawn(launchExe, [], spawnOpts)
    } else {
      ptyProc = pty.spawn(comspec, ['/d', '/s', '/c', 'call', tool.bin], spawnOpts)
    }

    windowPtyMap.set(event.sender.id, ptyProc)

    ptyProc.onData((data) => {
      // Respond to terminal window/cell size queries for OpenCode and advanced TUIs
      if (data.includes('\u001b[14t')) {
        try { ptyProc.write(`\u001b[4;${startRows * 18};${startCols * 9}t`) } catch (e) {}
      }
      if (data.includes('\u001b[18t')) {
        try { ptyProc.write(`\u001b[8;${startRows};${startCols}t`) } catch (e) {}
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty:data', data)
      }
    })

    ptyProc.onExit(({ exitCode }) => {
      windowPtyMap.delete(event.sender.id)
      if (!event.sender.isDestroyed()) {
        event.sender.send('pty:exit', { exitCode })
      }
    })

    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
})

ipcMain.on('pty:write', (event, data) => {
  const p = windowPtyMap.get(event.sender.id)
  if (p) {
    try { p.write(data) } catch (e) {}
  }
})

ipcMain.on('pty:resize', (event, cols, rows) => {
  const p = windowPtyMap.get(event.sender.id)
  if (p && Number.isInteger(cols) && Number.isInteger(rows) && cols > 10 && rows > 5) {
    try { p.resize(cols, rows) } catch (err) {}
  }
})

ipcMain.on('win:resize-start', (e, dir, startX, startY) => {
  const targetWin = BrowserWindow.fromWebContents(e.sender)
  if (!targetWin) return
  windowResizeStates.set(e.sender.id, {
    dir: String(dir),
    bounds: targetWin.getBounds(),
    startX: typeof startX === 'number' ? startX : screen.getCursorScreenPoint().x,
    startY: typeof startY === 'number' ? startY : screen.getCursorScreenPoint().y
  })
})

ipcMain.on('win:resize-move', (e, screenX, screenY) => {
  const resizeState = windowResizeStates.get(e.sender.id)
  const targetWin = BrowserWindow.fromWebContents(e.sender)
  if (!resizeState || !targetWin || targetWin.isDestroyed()) return

  const { dir, bounds: b, startX, startY } = resizeState
  const MINW = 480
  const MINH = 340
  const dx = Math.round(screenX - startX)
  const dy = Math.round(screenY - startY)

  let nx = b.x
  let ny = b.y
  let nw = b.width
  let nh = b.height

  if (dir.includes('e')) nw = Math.max(MINW, b.width + dx)
  if (dir.includes('s')) nh = Math.max(MINH, b.height + dy)
  if (dir.includes('w')) {
    nw = Math.max(MINW, b.width - dx)
    nx = b.x + (b.width - nw)
  }
  if (dir.includes('n')) {
    nh = Math.max(MINH, b.height - dy)
    ny = b.y + (b.height - nh)
  }

  targetWin.setBounds({ x: nx, y: ny, width: nw, height: nh })
})

ipcMain.on('win:resize-end', (e) => {
  windowResizeStates.delete(e.sender.id)
})

app.whenReady().then(() => {
  ensureSystemFolders()
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
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})


