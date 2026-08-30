const fs = require('fs')
const path = require('path')
const { DEFAULT_PROFILE_ID, validateProfileId } = require('./profile-store')

const SYSTEM_ROOT = process.env.OMNISHELL_SYSTEM_ROOT
  ? path.resolve(process.env.OMNISHELL_SYSTEM_ROOT)
  : path.join(__dirname, '..', '..', 'system')

const TOOLS = [
  { id: 'claude', name: 'Claude Code', sigil: 'CL', accent: '#f0a77d', summary: 'Anthropic agentic coding terminal', category: 'ai', dir: 'ClaudeCode', bin: 'claude', installer: { type: 'npm', package: '@anthropic-ai/claude-code' } },
  { id: 'codex', name: 'Codex', sigil: 'CX', accent: '#78a9ff', summary: 'OpenAI coding agent for the terminal', category: 'ai', dir: 'Codex', bin: 'codex', installer: { type: 'npm', package: '@openai/codex' } },
  { id: 'opencode', name: 'OpenCode', sigil: 'OC', accent: '#f5d76e', summary: 'Open-source terminal coding agent', category: 'ai', dir: 'OpenCode', bin: 'opencode', installer: { type: 'npm', package: 'opencode-ai' } },
  {
    id: 'agy',
    name: 'Antigravity CLI',
    sigil: 'AG',
    accent: '#b49cff',
    summary: 'Google Antigravity command-line companion',
    category: 'ai',
    dir: 'Antigravity',
    bin: 'agy',
    installer: {
      type: 'powershell-script',
      url: 'https://antigravity.google/cli/install.ps1',
      args: ['--skip-path', '--skip-aliases']
    }
  },
  {
    id: 'aider',
    name: 'Aider',
    sigil: 'AI',
    accent: '#ff8fa3',
    summary: 'AI pair programming in your repository',
    category: 'ai',
    dir: 'Aider',
    bin: 'aider',
    installer: { type: 'powershell-script', url: 'https://aider.chat/install.ps1' }
  },
  { id: 'copilot', name: 'GitHub Copilot CLI', sigil: 'GH', accent: '#a8b4ff', terminalBackground: '#0d1117', summary: 'GitHub Copilot directly in the shell', category: 'ai', dir: 'CopilotCLI', bin: 'copilot', installer: { type: 'npm', package: '@github/copilot' } },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    sigil: 'CU',
    accent: '#f1f1f1',
    summary: 'Cursor native coding agent for Windows',
    category: 'ai',
    dir: 'CursorAgent',
    bin: 'cursor-agent',
    installer: {
      type: 'cursor-release',
      url: 'https://cursor.com/install?win32=true'
    }
  },
  { id: 'amp', name: 'Amp', sigil: 'AM', accent: '#ffb15c', summary: 'Sourcegraph coding agent', category: 'ai', dir: 'Amp', bin: 'amp', installer: { type: 'npm', package: '@ampcode/cli' } },
  {
    id: 'goose',
    name: 'Goose',
    sigil: 'GO',
    accent: '#72d6ff',
    summary: 'Block open-source AI agent',
    category: 'ai',
    dir: 'Goose',
    bin: 'goose',
    installer: {
      type: 'github-release',
      repo: 'aaif-goose/goose',
      asset: 'goose-x86_64-pc-windows-msvc.zip',
      executable: 'goose.exe'
    }
  },
  { id: 'crush', name: 'Crush', sigil: 'CR', accent: '#ff7597', summary: 'Charm terminal-native coding agent', category: 'ai', dir: 'Crush', bin: 'crush', installer: { type: 'npm', package: '@charmland/crush' } },
  { id: 'qwen', name: 'Qwen Code', sigil: 'QW', accent: '#a78bfa', summary: 'Qwen-powered open coding agent', category: 'ai', dir: 'QwenCode', bin: 'qwen', installer: { type: 'npm', package: '@qwen-code/qwen-code' } },
  { id: 'kimi', name: 'Kimi Code', sigil: 'KI', accent: '#9a8cff', summary: 'Moonshot AI coding agent for the terminal', category: 'ai', dir: 'KimiCode', bin: 'kimi', installer: { type: 'npm', package: '@moonshot-ai/kimi-code' } }
]

const TOOL_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]))
const EXECUTABLE_CANDIDATE_CACHE = new Map()
const RESOLVED_EXECUTABLE_CACHE = new Map()

function findTool(id) {
  return TOOL_BY_ID.get(id)
}

function toolDir(tool, systemRoot = SYSTEM_ROOT) {
  return path.join(systemRoot, tool.dir)
}

function profileDir(tool, profileId = DEFAULT_PROFILE_ID, systemRoot = SYSTEM_ROOT) {
  validateProfileId(profileId)
  const runtimeRoot = toolDir(tool, systemRoot)
  return profileId === DEFAULT_PROFILE_ID
    ? runtimeRoot
    : path.join(runtimeRoot, 'profiles', profileId)
}

function profileRuntimeDir(tool, profileId = DEFAULT_PROFILE_ID, systemRoot = SYSTEM_ROOT) {
  validateProfileId(profileId)
  return profileId === DEFAULT_PROFILE_ID
    ? toolDir(tool, systemRoot)
    : path.join(profileDir(tool, profileId, systemRoot), 'runtime')
}

function executableCandidates(tool, systemRoot = SYSTEM_ROOT, profileId = DEFAULT_PROFILE_ID) {
  validateProfileId(profileId)
  const cacheKey = `${path.resolve(systemRoot)}\u0000${tool.id}\u0000${profileId}`
  const cached = EXECUTABLE_CANDIDATE_CACHE.get(cacheKey)
  if (cached) return cached

  const root = profileRuntimeDir(tool, profileId, systemRoot)
  const candidates = []

  if (tool.installer && tool.installer.type === 'npm') {
    const names = [tool.bin]
    for (const name of names) {
      for (const extension of ['.cmd', '.exe', '.bat', '']) {
        candidates.push(path.join(root, 'node_modules', '.bin', name + extension))
      }
    }
  }

  if (tool.id === 'agy') {
    candidates.push(path.join(root, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'))
  }

  if (tool.id === 'aider') {
    candidates.push(path.join(root, 'bin', 'aider.exe'))
    candidates.push(path.join(root, '.local', 'bin', 'aider.exe'))
  }

  if (tool.id === 'goose') {
    candidates.push(path.join(root, 'bin', 'goose.exe'))
  }

  if (tool.id === 'cursor-agent') {
    candidates.push(path.join(root, 'bin', 'cursor-agent.exe'))
    candidates.push(path.join(root, 'bin', 'cursor-agent.cmd'))
  }

  const uniqueCandidates = Object.freeze([...new Set(candidates)])
  EXECUTABLE_CANDIDATE_CACHE.set(cacheKey, uniqueCandidates)
  return uniqueCandidates
}

function resolveLocalExecutable(tool, systemRoot = SYSTEM_ROOT, profileId = DEFAULT_PROFILE_ID) {
  validateProfileId(profileId)
  const cacheKey = `${path.resolve(systemRoot)}\u0000${tool.id}\u0000${profileId}`
  const cached = RESOLVED_EXECUTABLE_CACHE.get(cacheKey)
  if (cached && fs.existsSync(cached)) return cached
  RESOLVED_EXECUTABLE_CACHE.delete(cacheKey)
  const resolved = executableCandidates(tool, systemRoot, profileId).find((candidate) => fs.existsSync(candidate)) || null
  if (resolved) RESOLVED_EXECUTABLE_CACHE.set(cacheKey, resolved)
  return resolved
}

function ensureJsonFile(filePath, value) {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function ensureProfileDirectories(root) {
  const directories = [
    root,
    path.join(root, '.config'),
    path.join(root, '.local', 'share'),
    path.join(root, '.local', 'state'),
    path.join(root, '.cache'),
    path.join(root, 'AppData', 'Roaming'),
    path.join(root, 'AppData', 'Local'),
    path.join(root, 'Temp')
  ]
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true })
  return root
}

function prepareToolDirectories(tool, systemRoot = SYSTEM_ROOT) {
  const root = toolDir(tool, systemRoot)
  ensureProfileDirectories(root)

  if (tool.installer && tool.installer.type === 'npm') {
    ensureJsonFile(path.join(root, 'package.json'), {
      name: `omnishell-${tool.id}`,
      version: '1.0.0',
      private: true
    })
  }

  return root
}

function prepareProfileRuntimeDirectories(tool, profileId = DEFAULT_PROFILE_ID, systemRoot = SYSTEM_ROOT) {
  if (profileId === DEFAULT_PROFILE_ID) return prepareToolDirectories(tool, systemRoot)
  const root = profileRuntimeDir(tool, profileId, systemRoot)
  fs.mkdirSync(root, { recursive: true })
  if (tool.installer && tool.installer.type === 'npm') {
    ensureJsonFile(path.join(root, 'package.json'), {
      name: `omnishell-${tool.id}-${profileId}`,
      version: '1.0.0',
      private: true
    })
  }
  return root
}

function prepareProfileDirectories(tool, profileId = DEFAULT_PROFILE_ID, systemRoot = SYSTEM_ROOT) {
  if (profileId === DEFAULT_PROFILE_ID) return prepareToolDirectories(tool, systemRoot)
  return ensureProfileDirectories(profileDir(tool, profileId, systemRoot))
}

function prepareAllTools(systemRoot = SYSTEM_ROOT) {
  fs.mkdirSync(systemRoot, { recursive: true })
  fs.mkdirSync(path.join(systemRoot, '_install'), { recursive: true })
}

const PASSTHROUGH_ENV_KEYS = new Set([
  'ALL_PROXY', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ComSpec', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS',
  'NO_PROXY', 'NUMBER_OF_PROCESSORS', 'OS', 'Path', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'PROCESSOR_ARCHITEW6432', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'PSModulePath', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemDrive',
  'SystemRoot', 'USERNAME', 'windir', 'all_proxy', 'https_proxy', 'http_proxy',
  'no_proxy'
])

function copySafeBaseEnvironment(baseEnv) {
  const result = {}
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (PASSTHROUGH_ENV_KEYS.has(key) && typeof value === 'string') result[key] = value
  }
  return result
}

function createIsolatedEnvironment(tool, baseEnv = process.env, systemRoot = SYSTEM_ROOT, profileId = DEFAULT_PROFILE_ID) {
  const runtimeRoot = prepareProfileRuntimeDirectories(tool, profileId, systemRoot)
  const root = prepareProfileDirectories(tool, profileId, systemRoot)
  const drive = path.parse(root).root.replace(/[\\/]$/, '')
  const configHome = path.join(root, '.config')
  const dataHome = path.join(root, '.local', 'share')
  const stateHome = path.join(root, '.local', 'state')
  const cacheHome = path.join(root, '.cache')
  const tempHome = path.join(root, 'Temp')

  const env = Object.assign(copySafeBaseEnvironment(baseEnv), {
    HOME: root,
    USERPROFILE: root,
    HOMEDRIVE: drive,
    HOMEPATH: root.slice(drive.length),
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: cacheHome,
    TEMP: tempHome,
    TMP: tempHome,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CI: 'false',
    GIT_CEILING_DIRECTORIES: root
  })

  if (!env.PROCESSOR_ARCHITECTURE) {
    const architectureNames = { x64: 'AMD64', arm64: 'ARM64', ia32: 'x86' }
    env.PROCESSOR_ARCHITECTURE = architectureNames[process.arch] || process.arch
  }

  const profiles = {
    claude: { CLAUDE_CONFIG_DIR: path.join(root, '.claude') },
    codex: { CODEX_HOME: path.join(root, '.codex') },
    opencode: {
      OPENCODE_CONFIG_DIR: path.join(configHome, 'opencode'),
      OPENCODE_DATA_DIR: path.join(dataHome, 'opencode'),
      OPENCODE_CACHE_DIR: path.join(cacheHome, 'opencode'),
      OPENCODE_DISABLE_AUTO_UPDATE: 'true'
    },
    agy: { AGY_HOME: path.join(root, '.agy'), ANTIGRAVITY_HOME: path.join(root, '.agy') },
    aider: {
      AIDER_CONFIG_DIR: path.join(root, '.aider'),
      AIDER_HOME: path.join(root, '.aider'),
      AIDER_GIT: 'false',
      AIDER_GITIGNORE: 'false'
    },
    copilot: { COPILOT_CONFIG_DIR: path.join(root, '.copilot'), GITHUB_COPILOT_CONFIG_DIR: path.join(root, '.copilot') },
    'cursor-agent': { CURSOR_CONFIG_DIR: path.join(root, '.cursor') },
    amp: { AMP_CONFIG_DIR: path.join(root, '.amp') },
    goose: { GOOSE_HOME: path.join(root, '.goose'), GOOSE_CONFIG_DIR: path.join(root, '.goose') },
    crush: {
      CRUSH_GLOBAL_CONFIG: path.join(configHome, 'crush', 'crushrc'),
      CRUSH_GLOBAL_DATA: path.join(dataHome, 'crush')
    },
    qwen: { QWEN_CONFIG_DIR: path.join(root, '.qwen') },
    kimi: {}
  }

  const profileEnvironment = profiles[tool.id] || {}
  Object.assign(env, profileEnvironment)
  for (const [key, value] of Object.entries(profileEnvironment)) {
    if (/(?:_HOME|_DIR)$/.test(key) && path.isAbsolute(value)) {
      fs.mkdirSync(value, { recursive: true })
    }
  }

  const localBinDirectories = [path.join(runtimeRoot, 'node_modules', '.bin'), path.join(runtimeRoot, 'bin'), runtimeRoot]
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
  env[pathKey] = localBinDirectories.join(path.delimiter) + path.delimiter + (env[pathKey] || '')

  return env
}

function createInstallEnvironment(tool, baseEnv = process.env, systemRoot = SYSTEM_ROOT, profileId = DEFAULT_PROFILE_ID) {
  const root = prepareProfileRuntimeDirectories(tool, profileId, systemRoot)
  const env = createIsolatedEnvironment(tool, baseEnv, systemRoot, profileId)
  const drive = path.parse(root).root.replace(/[\\/]$/, '')
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    HOMEDRIVE: drive,
    HOMEPATH: root.slice(drive.length),
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    TEMP: path.join(root, 'Temp'),
    TMP: path.join(root, 'Temp')
  })
  ensureProfileDirectories(root)
  env.npm_config_cache = path.join(root, '.cache', 'npm')
  env.npm_config_update_notifier = 'false'

  if (tool.id === 'aider') {
    env.UV_INSTALL_DIR = path.join(root, 'bin')
    env.UV_TOOL_DIR = path.join(root, 'uv', 'tools')
    env.UV_TOOL_BIN_DIR = path.join(root, 'bin')
    env.UV_PYTHON_INSTALL_DIR = path.join(root, 'uv', 'python')
    env.UV_CACHE_DIR = path.join(root, '.cache', 'uv')
    env.UV_NO_MODIFY_PATH = '1'
  }

  return env
}

function externalScriptPath(appRoot, scriptName) {
  return path.join(appRoot, 'scripts', scriptName)
    .replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2')
}

function createInstallPlan(tool, appRoot = path.join(__dirname, '..'), systemRoot = SYSTEM_ROOT, profileId = DEFAULT_PROFILE_ID) {
  if (!tool || !tool.installer) return null
  const root = prepareProfileRuntimeDirectories(tool, profileId, systemRoot)
  const workingDirectory = path.join(systemRoot, '_install', tool.id, profileId)
  const installer = tool.installer

  if (installer.type === 'npm') {
    return {
      command: process.platform === 'win32' ? 'powershell.exe' : 'npm',
      args: process.platform === 'win32'
        ? [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', externalScriptPath(appRoot, 'install-npm.ps1'),
            '-PackageName', installer.package,
            '-Destination', root,
            '-AdditionalArgumentsJson', JSON.stringify(installer.args || [])
          ]
        : ['install', '--save-exact', installer.package, '--no-fund', '--no-audit'],
      cwd: root
    }
  }

  if (installer.type === 'powershell-script') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', externalScriptPath(appRoot, 'install-remote.ps1'),
        '-Uri', installer.url,
        '-Destination', path.join(workingDirectory, 'bootstrap.ps1'),
        '-InstallerArgumentsJson', JSON.stringify(installer.args || [])
      ],
      cwd: root
    }
  }

  if (installer.type === 'github-release') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', externalScriptPath(appRoot, 'install-github-release.ps1'),
        '-Repository', installer.repo,
        '-AssetName', installer.asset,
        '-ExecutableName', installer.executable,
        '-DestinationDirectory', path.join(root, 'bin'),
        '-WorkingDirectory', workingDirectory
      ],
      cwd: root
    }
  }

  if (installer.type === 'cursor-release') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', externalScriptPath(appRoot, 'install-cursor.ps1'),
        '-BootstrapUri', installer.url,
        '-DestinationDirectory', path.join(root, 'bin'),
        '-WorkingDirectory', workingDirectory
      ],
      cwd: root
    }
  }

  return null
}

module.exports = {
  SYSTEM_ROOT,
  TOOLS,
  TOOL_BY_ID,
  createInstallEnvironment,
  createInstallPlan,
  createIsolatedEnvironment,
  executableCandidates,
  externalScriptPath,
  findTool,
  prepareAllTools,
  prepareProfileDirectories,
  prepareProfileRuntimeDirectories,
  prepareToolDirectories,
  profileDir,
  profileRuntimeDir,
  resolveLocalExecutable,
  toolDir
}
