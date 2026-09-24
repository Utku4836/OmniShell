const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const toml = require('@iarna/toml')
const jsonc = require('jsonc-parser')
const yaml = require('yaml')
const { profileDir, toolDir } = require('./tooling')

const SHARING_RULES = {
  claude: {
    sharedSessions: ['.claude/projects', '.claude/history.jsonl', '.claude/todos'],
    sharedModels: ['.claude/cache'],
    sharedConfig: ['.claude/settings.json']
  },
  codex: {
    sharedSessions: ['.codex/sessions', '.codex/archived_sessions', '.codex/history.jsonl', '.codex/session_index.jsonl', '.codex/state_*.sqlite'],
    sharedModels: ['.codex/models_cache.json', '.codex/version.json'],
    sharedConfig: ['.codex/config.toml']
  },
  opencode: {
    sharedSessions: ['.local/share/opencode/opencode.db', '.local/share/opencode/repos'],
    sharedModels: ['.cache/opencode'],
    sharedConfig: ['.config/opencode/opencode.json']
  },
  agy: {
    sharedSessions: [
      '.gemini/antigravity-cli/conversations',
      '.gemini/antigravity-cli/conversation_summaries.db',
      '.gemini/antigravity-cli/implicit',
      '.gemini/antigravity-cli/knowledge'
    ],
    sharedModels: ['.gemini/antigravity-cli/cache'],
    sharedConfig: [
      '.gemini/antigravity-cli/settings.json',
      '.gemini/config/config.json',
      '.gemini/config/mcp_config.json'
    ]
  },
  aider: {
    sharedSessions: ['.aider/chat.history.md', '.aider/input.history', '.aider/llm.history'],
    sharedModels: ['.aider/model*.json'],
    sharedConfig: ['.aider/aider.json', '.aider/aider.conf.yml']
  },
  copilot: {
    sharedSessions: ['.copilot/session-state', '.copilot/sidebar-sessions-state', '.copilot/session-store.db'],
    sharedModels: ['.copilot/models*.json'],
    sharedConfig: ['.copilot/config.json']
  },
  'cursor-agent': {
    sharedSessions: ['.cursor/chats', '.cursor/projects', '.cursor/agent-cli-state.json'],
    sharedModels: ['.cursor/models*.json'],
    sharedConfig: ['.cursor/cli-config.json']
  },
  amp: {
    sharedSessions: ['.local/share/amp/threads'],
    sharedModels: ['.cache/amp/models'],
    sharedConfig: ['.config/amp/settings.json', '.config/amp/amp.json']
  },
  goose: {
    sharedSessions: ['AppData/Roaming/Block/goose/data/sessions'],
    sharedModels: ['AppData/Roaming/Block/goose/data/models'],
    sharedConfig: ['AppData/Roaming/Block/goose/config/config.yaml', '.config/goose/config.yaml']
  },
  crush: {
    sharedSessions: ['.local/share/crush/sessions', '.local/share/crush/projects.json'],
    sharedModels: ['.cache/crush/models'],
    sharedConfig: ['.config/crush/crush.json']
  },
  qwen: {
    sharedSessions: ['.qwen/sessions', '.qwen/history'],
    sharedModels: ['.qwen/models*.json'],
    sharedConfig: ['.qwen/settings.json']
  },
  kimi: {
    sharedSessions: ['.kimi-code/sessions', '.kimi-code/session_index.jsonl'],
    sharedModels: ['.kimi-code/models'],
    sharedConfig: ['.kimi-code/config.toml']
  }
}

// These are CLI-native user locations inside each profile's isolated HOME.
// A missing adapter is shown as N/A in the UI instead of claiming to share data.
const SKILL_RULES = {
  claude: ['.claude/skills'],
  codex: ['.codex/skills'],
  opencode: ['.config/opencode/skills'],
  agy: ['.gemini/config/skills', '.gemini/antigravity-cli/skills'],
  copilot: ['.copilot/skills'],
  'cursor-agent': ['.cursor/skills'],
  amp: ['.config/agents/skills', '.config/amp/skills'],
  goose: ['.config/goose/skills'],
  crush: ['.config/crush/skills'],
  qwen: ['.qwen/skills'],
  kimi: ['.kimi-code/skills']
}

const MCP_RULES = {
  claude: { path: '.claude/.claude.json', format: 'jsonc', key: 'mcpServers' },
  codex: { path: '.codex/config.toml', format: 'toml', key: 'mcp_servers' },
  opencode: { path: '.config/opencode/opencode.json', format: 'jsonc', key: 'mcp' },
  amp: { path: '.config/amp/settings.json', format: 'jsonc', key: 'amp.mcpServers' },
  goose: { path: 'AppData/Roaming/Block/goose/config/config.yaml', format: 'yaml', key: 'extensions' },
  crush: { path: '.config/crush/crush.json', format: 'jsonc', key: 'mcp' },
  copilot: { path: '.copilot/mcp-config.json', format: 'file' },
  'cursor-agent': { path: '.cursor/mcp.json', format: 'file' },
  qwen: { path: '.qwen/settings.json', format: 'jsonc', key: 'mcpServers' },
  agy: { path: '.gemini/config/mcp_config.json', format: 'file' },
  kimi: { path: '.kimi-code/mcp.json', format: 'file' }
}

for (const [toolId, rule] of Object.entries(MCP_RULES)) {
  SHARING_RULES[toolId].sharedConfig = SHARING_RULES[toolId].sharedConfig.filter((item) => item !== rule.path)
}
// These alternate legacy files may also contain MCP definitions. Keep them local.
SHARING_RULES.amp.sharedConfig = SHARING_RULES.amp.sharedConfig.filter((item) => item !== '.config/amp/amp.json')
SHARING_RULES.goose.sharedConfig = SHARING_RULES.goose.sharedConfig.filter((item) => item !== '.config/goose/config.yaml')

const queues = new Map()

function wildcardExpression(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

async function expandRule(root, relativePattern) {
  if (!relativePattern.includes('*')) return [relativePattern]
  const directory = path.join(root, path.dirname(relativePattern))
  let entries
  try { entries = await fsp.readdir(directory, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const expression = wildcardExpression(path.basename(relativePattern))
  return entries.filter((entry) => expression.test(entry.name)).map((entry) => path.join(path.dirname(relativePattern), entry.name))
}

async function copyPath(source, destination, keepNewer = false) {
  let stat
  try { stat = await fsp.lstat(source) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Shared data must not contain links: ${source}`)
  if (/\.(?:sqlite|db)-(?:wal|shm|journal)$/i.test(source)) return
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  try {
    const current = await fsp.lstat(destination)
    if (stat.isFile() && current.isFile() && keepNewer && current.mtimeMs > stat.mtimeMs) return
    if (stat.isFile() && current.isFile() && !/\.(?:db|sqlite)$/i.test(source) && current.size === stat.size && Math.abs(current.mtimeMs - stat.mtimeMs) < 1) return
    if (current.isSymbolicLink()) throw new Error(`Shared destination must not be a link: ${destination}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat.isDirectory()) {
    await fsp.mkdir(destination, { recursive: true })
    for (const name of await fsp.readdir(source)) await copyPath(path.join(source, name), path.join(destination, name), keepNewer)
  } else if (/\.(?:sqlite|db)$/i.test(source)) {
    // SQLite's backup transaction includes committed WAL pages without copying live sidecars.
    const { DatabaseSync, backup } = require('node:sqlite')
    const database = new DatabaseSync(source, { readOnly: true })
    try { await backup(database, destination) } finally { database.close() }
  } else if (stat.isFile()) {
    const partial = `${destination}.${randomUUID()}.partial`
    try {
      await fsp.copyFile(source, partial)
      await fsp.rename(partial, destination)
      await fsp.utimes(destination, stat.atime, stat.mtime)
    } finally {
      await fsp.rm(partial, { force: true }).catch(() => {})
    }
  }
}

async function rejectLinkedParents(root, relativePath) {
  let current = root
  for (const part of ['.', ...path.dirname(relativePath).split(/[\\/]/)]) {
    current = path.join(current, part)
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error(`Shared data must not traverse links: ${current}`)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

async function readConfig(file, format) {
  let source
  try {
    if ((await fsp.lstat(file)).isSymbolicLink()) throw new Error(`Shared data must not contain links: ${file}`)
    source = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (format === 'toml') return toml.parse(source)
  if (format === 'yaml') {
    const value = yaml.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid CLI configuration: ${file}`)
    return value
  }
  const errors = []
  const value = jsonc.parse(source, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid CLI configuration: ${file}`)
  }
  return value
}

async function writeConfig(file, value, format) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  try {
    if ((await fsp.lstat(file)).isSymbolicLink()) throw new Error(`Shared destination must not be a link: ${file}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const partial = `${file}.${randomUUID()}.partial`
  try {
    const content = format === 'toml' ? toml.stringify(value) : format === 'yaml' ? yaml.stringify(value) : `${JSON.stringify(value, null, 2)}\n`
    await fsp.writeFile(partial, content, 'utf8')
    await fsp.rename(partial, file)
  } finally { await fsp.rm(partial, { force: true }).catch(() => {}) }
}

async function syncConfigSection(direction, tool, dataRoot, setting, systemRoot) {
  const rule = MCP_RULES[tool.id]
  if (!rule) return
  const sharedRoot = path.join(toolDir(tool, systemRoot), '_shared', setting)
  const sourceRoot = direction === 'hydrate' ? sharedRoot : dataRoot
  const destinationRoot = direction === 'hydrate' ? dataRoot : sharedRoot
  await rejectLinkedParents(sourceRoot, rule.path)
  await rejectLinkedParents(destinationRoot, rule.path)
  const sourceFile = path.join(sourceRoot, rule.path)
  const destinationFile = path.join(destinationRoot, rule.path)
  if (rule.format === 'file') {
    if (setting === 'sharedMcp') await copyPath(sourceFile, destinationFile)
    return
  }
  const source = await readConfig(sourceFile, rule.format)
  if (!source) return
  const destination = await readConfig(destinationFile, rule.format) || {}
  let output
  if (setting === 'sharedMcp') {
    if (!Object.hasOwn(source, rule.key)) return
    output = { ...destination, [rule.key]: source[rule.key] }
  } else {
    const { [rule.key]: privateMcp, ...otherSettings } = destination
    const { [rule.key]: ignored, ...sharedSettings } = source
    output = { ...otherSettings, ...sharedSettings }
    if (Object.hasOwn(destination, rule.key)) output[rule.key] = privateMcp
  }
  await writeConfig(destinationFile, output, rule.format)
}

async function migrateLegacySharedMcp(tool, systemRoot) {
  const rule = MCP_RULES[tool.id]
  if (!rule) return
  const sharedRoot = path.join(toolDir(tool, systemRoot), '_shared', 'sharedConfig')
  await rejectLinkedParents(sharedRoot, rule.path)
  const file = path.join(sharedRoot, rule.path)
  let value
  if (rule.format === 'file') {
    try {
      if ((await fsp.lstat(file)).isSymbolicLink()) throw new Error(`Shared data must not contain links: ${file}`)
    } catch (error) { if (error.code === 'ENOENT') return; throw error }
  } else {
    value = await readConfig(file, rule.format)
    if (!value || !Object.hasOwn(value, rule.key)) return
  }
  const backup = path.join(systemRoot, '_profiles', 'trash', 'legacy-shared-mcp', tool.id, `${path.basename(file)}-${randomUUID()}`)
  await fsp.mkdir(path.dirname(backup), { recursive: true })
  if (rule.format === 'file') await fsp.rename(file, backup)
  else {
    await fsp.copyFile(file, backup)
    delete value[rule.key]
    await writeConfig(file, value, rule.format)
  }
}

async function synchronize(direction, tool, profile, systemRoot) {
  if (!profile?.settings) return
  const rules = SHARING_RULES[tool.id] || {}
  const dataRoot = profileDir(tool, profile, systemRoot)
  for (const setting of ['sharedSessions', 'sharedModels', 'sharedConfig', 'sharedSkills', 'sharedMcp']) {
    if (!profile.settings[setting]) continue
    const sharedRoot = path.join(toolDir(tool, systemRoot), '_shared', setting)
    const sourceRoot = direction === 'hydrate' ? sharedRoot : dataRoot
    const destinationRoot = direction === 'hydrate' ? dataRoot : sharedRoot
    const paths = setting === 'sharedSkills' ? SKILL_RULES[tool.id] || [] : rules[setting] || []
    for (const rule of paths) {
      for (const relativePath of await expandRule(sourceRoot, rule)) {
        await rejectLinkedParents(sourceRoot, relativePath)
        await rejectLinkedParents(destinationRoot, relativePath)
        await copyPath(path.join(sourceRoot, relativePath), path.join(destinationRoot, relativePath), direction === 'hydrate' && setting === 'sharedConfig')
      }
    }
    if (setting === 'sharedConfig' || setting === 'sharedMcp') await syncConfigSection(direction, tool, dataRoot, setting, systemRoot)
  }
}

function enqueue(tool, systemRoot, operation) {
  const key = `${path.resolve(systemRoot || require('./tooling').SYSTEM_ROOT)}\u0000${tool.id}`
  const previous = queues.get(key) || Promise.resolve()
  const current = previous.then(operation, operation)
  const tail = current.catch(() => {})
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return current
}

function hydrateSharedProfileData(tool, profile, systemRoot) {
  return enqueue(tool, systemRoot, () => synchronize('hydrate', tool, profile, systemRoot))
}

function persistSharedProfileData(tool, profile, systemRoot) {
  return enqueue(tool, systemRoot, () => synchronize('persist', tool, profile, systemRoot))
}

function sharingCapabilities(toolId) {
  const rules = SHARING_RULES[toolId] || {}
  return {
    sharedSessions: Boolean(rules.sharedSessions?.length),
    sharedModels: Boolean(rules.sharedModels?.length),
    sharedConfig: Boolean(rules.sharedConfig?.length || (MCP_RULES[toolId] && MCP_RULES[toolId].format !== 'file')),
    sharedSkills: Boolean(SKILL_RULES[toolId]?.length),
    sharedMcp: Boolean(MCP_RULES[toolId])
  }
}

module.exports = {
  MCP_RULES,
  SHARING_RULES,
  hydrateSharedProfileData,
  migrateLegacySharedMcp,
  persistSharedProfileData,
  sharingCapabilities
}
