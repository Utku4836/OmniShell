const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { profileDir, toolDir } = require('./tooling')
const { MCP_RULES, SHARING_RULES } = require('./profile-sharing')

const EXTRA_CONFIG_PATHS = {
  claude: ['.claude.json'],
  opencode: ['.config/opencode/opencode.jsonc'],
  aider: ['.aider.conf.yml', '.aider.conf.yaml'],
  amp: ['.config/amp/omnishell-full-permission.json'],
  crush: ['.config/crush/crushrc']
}
const MAX_CONFIG_BYTES = 16 * 1024 * 1024

function configPaths(tool) {
  return [...new Set([
    ...(SHARING_RULES[tool.id]?.sharedConfig || []),
    MCP_RULES[tool.id]?.path,
    ...(EXTRA_CONFIG_PATHS[tool.id] || [])
  ].filter(Boolean))]
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathVariants(oldRoot, newRoot) {
  const pairs = [
    [oldRoot.replaceAll('\\', '\\\\'), newRoot.replaceAll('\\', '\\\\')],
    [oldRoot.replaceAll('\\', '/'), newRoot.replaceAll('\\', '/')],
    [oldRoot, newRoot]
  ]
  return [...new Map(pairs.map(([from, to]) => [from, to])).entries()]
    .sort(([left], [right]) => right.length - left.length)
}

function replaceProfilePaths(text, oldRoot, newRoot) {
  let result = text
  for (const [from, to] of pathVariants(oldRoot, newRoot)) {
    const exactFolder = new RegExp(`${escapeRegex(from)}(?![\\p{L}\\p{N}._-])`, 'giu')
    result = result.replace(exactFolder, () => to)
  }
  return result
}

async function safeConfigStat(root, relative) {
  let current = root
  const segments = relative.split(/[\\/]/)
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index])
    let stat
    try { stat = await fs.lstat(current) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`A CLI configuration path is linked outside its profile: ${current}`)
    if (index === segments.length - 1) return stat
  }
  return null
}

async function readConfigUpdate(sourceRoot, destinationRoot, relative, oldRoot, newRoot) {
  const stat = await safeConfigStat(sourceRoot, relative)
  if (!stat) return null
  if (!stat.isFile()) throw new Error(`CLI configuration is not a file: ${path.join(sourceRoot, relative)}`)
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`CLI configuration is too large to update safely: ${path.join(sourceRoot, relative)}`)
  const before = await fs.readFile(path.join(sourceRoot, relative))
  const text = before.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(before)) throw new Error(`CLI configuration is not UTF-8: ${path.join(sourceRoot, relative)}`)
  const updated = replaceProfilePaths(text, oldRoot, newRoot)
  if (updated === text) return null
  return { file: path.join(destinationRoot, relative), before, after: Buffer.from(updated, 'utf8'), mode: stat.mode }
}

async function planProfilePathUpdates(tool, previous, nextName, profiles, systemRoot) {
  const oldRoot = profileDir(tool, previous, systemRoot)
  const newRoot = profileDir(tool, { ...previous, name: nextName }, systemRoot)
  if (oldRoot === newRoot) return { updates: [], applied: [] }
  const roots = profiles.map((profile) => ({
    source: profileDir(tool, profile, systemRoot),
    destination: profile.id === previous.id ? newRoot : profileDir(tool, profile, systemRoot)
  }))
  for (const setting of ['sharedConfig', 'sharedMcp']) {
    const root = path.join(toolDir(tool, systemRoot), '_shared', setting)
    roots.push({ source: root, destination: root })
  }
  const updates = []
  for (const root of roots) {
    for (const relative of configPaths(tool)) {
      const update = await readConfigUpdate(root.source, root.destination, relative, oldRoot, newRoot)
      if (update) updates.push(update)
    }
  }
  return { updates, applied: [] }
}

async function writeAtomically(file, content, mode) {
  const partial = `${file}.${randomUUID()}.partial`
  try {
    await fs.writeFile(partial, content)
    await fs.chmod(partial, mode)
    await fs.rename(partial, file)
  } finally { await fs.rm(partial, { force: true }).catch(() => {}) }
}

async function applyProfilePathUpdates(plan) {
  for (const update of plan.updates) {
    await writeAtomically(update.file, update.after, update.mode)
    plan.applied.push(update)
  }
}

async function restoreProfilePathUpdates(plan) {
  for (const update of [...plan.applied].reverse()) {
    const current = await fs.readFile(update.file)
    if (!current.equals(update.after)) throw new Error(`CLI configuration changed during rename: ${update.file}`)
    await writeAtomically(update.file, update.before, update.mode)
  }
  plan.applied.length = 0
}

module.exports = { applyProfilePathUpdates, planProfilePathUpdates, replaceProfilePaths, restoreProfilePathUpdates }
