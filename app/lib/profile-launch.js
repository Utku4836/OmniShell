const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const FULL_PERMISSION_ARGS = {
  claude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  opencode: ['--auto'],
  agy: ['--dangerously-skip-permissions'],
  aider: ['--yes-always'],
  copilot: ['--allow-all'],
  'cursor-agent': ['--yolo'],
  crush: ['--yolo'],
  qwen: ['--approval-mode', 'yolo'],
  kimi: ['--auto']
}

async function readJson(filePath, fallback = {}) {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid JSON object: ${filePath}`)
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const partial = `${filePath}.${randomUUID()}.partial`
  try {
    await fsp.writeFile(partial, JSON.stringify(value, null, 2), 'utf8')
    await fsp.rename(partial, filePath)
  } finally {
    await fsp.rm(partial, { force: true }).catch(() => {})
  }
}

async function restoreQwenPermission(profileRoot) {
  const settingsPath = path.join(profileRoot, '.qwen', 'settings.json')
  const backupPath = path.join(profileRoot, '.qwen', '.omnishell-permission-backup.json')
  const backup = await readJson(backupPath, null)
  if (!backup) return
  const settings = await readJson(settingsPath)
  settings.tools ||= {}
  if (typeof settings.tools !== 'object' || Array.isArray(settings.tools)) throw new Error('Invalid Qwen tools settings')
  if (backup.existed) settings.tools.approvalMode = backup.value
  else delete settings.tools.approvalMode
  await writeJson(settingsPath, settings)
  await fsp.rm(backupPath, { force: true })
}

async function prepareAmpSettings(profileRoot, env) {
  const configRoot = path.join(profileRoot, '.config', 'amp')
  const basePath = path.join(configRoot, 'amp.json')
  const fallbackPath = path.join(configRoot, 'settings.json')
  const base = await readJson(basePath, null) || await readJson(fallbackPath)
  base['amp.dangerouslyAllowAll'] = true
  const generatedPath = path.join(configRoot, 'omnishell-full-permission.json')
  await writeJson(generatedPath, base)
  env.AMP_SETTINGS_FILE = generatedPath
  return ['--settings-file', generatedPath]
}

async function prepareProfileLaunch(tool, profile, profileRoot, baseEnv) {
  const env = { ...baseEnv }
  const enabled = profile?.settings?.fullPermission === true
  if (tool.id === 'aider') {
    const historyRoot = path.join(profileRoot, '.aider')
    env.AIDER_INPUT_HISTORY_FILE = path.join(historyRoot, 'input.history')
    env.AIDER_CHAT_HISTORY_FILE = path.join(historyRoot, 'chat.history.md')
    env.AIDER_LLM_HISTORY_FILE = path.join(historyRoot, 'llm.history')
  }
  if (tool.id === 'qwen') await restoreQwenPermission(profileRoot)
  if (!enabled) return { args: [], env }
  if (tool.id === 'goose') {
    env.GOOSE_MODE = 'auto'
    return { args: [], env }
  }
  if (tool.id === 'amp') return { args: await prepareAmpSettings(profileRoot, env), env }
  return { args: [...(FULL_PERMISSION_ARGS[tool.id] || [])], env }
}

module.exports = { FULL_PERMISSION_ARGS, prepareProfileLaunch }
