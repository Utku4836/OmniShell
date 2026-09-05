const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
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

async function copyPath(source, destination) {
  let stat
  try { stat = await fsp.lstat(source) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Shared data must not contain links: ${source}`)
  if (/\.(?:sqlite|db)-(?:wal|shm|journal)$/i.test(source)) return
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  try {
    if ((await fsp.lstat(destination)).isSymbolicLink()) throw new Error(`Shared destination must not be a link: ${destination}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat.isDirectory()) {
    await fsp.mkdir(destination, { recursive: true })
    for (const name of await fsp.readdir(source)) await copyPath(path.join(source, name), path.join(destination, name))
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

async function synchronize(direction, tool, profile, systemRoot) {
  if (!profile?.settings) return
  const rules = SHARING_RULES[tool.id] || {}
  const dataRoot = profileDir(tool, profile.id, systemRoot)
  for (const setting of ['sharedSessions', 'sharedModels', 'sharedConfig']) {
    if (!profile.settings[setting]) continue
    const sharedRoot = path.join(toolDir(tool, systemRoot), '_shared', setting)
    const sourceRoot = direction === 'hydrate' ? sharedRoot : dataRoot
    const destinationRoot = direction === 'hydrate' ? dataRoot : sharedRoot
    for (const rule of rules[setting] || []) {
      for (const relativePath of await expandRule(sourceRoot, rule)) {
        await rejectLinkedParents(sourceRoot, relativePath)
        await rejectLinkedParents(destinationRoot, relativePath)
        await copyPath(path.join(sourceRoot, relativePath), path.join(destinationRoot, relativePath))
      }
    }
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
    sharedConfig: Boolean(rules.sharedConfig?.length)
  }
}

module.exports = {
  SHARING_RULES,
  hydrateSharedProfileData,
  persistSharedProfileData,
  sharingCapabilities
}
