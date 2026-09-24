const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const toml = require('@iarna/toml')
const { normalizeProfileSettings } = require('./profile-store')
const { profileDir } = require('./tooling')

function profileDocumentName(tool, profile) {
  return `${profile.name}-${tool.name}.Toml`
}

function profileDocumentPath(tool, profile, systemRoot) {
  return path.join(profileDir(tool, profile, systemRoot), profileDocumentName(tool, profile))
}

function documentValue(tool, profile) {
  const settings = normalizeProfileSettings(profile.settings)
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      cli: tool.id,
      created_at: profile.createdAt || '',
      updated_at: profile.updatedAt || ''
    },
    settings: {
      full_permission: settings.fullPermission,
      shared_sessions: settings.sharedSessions,
      shared_models: settings.sharedModels,
      shared_config: settings.sharedConfig,
      shared_skills: settings.sharedSkills,
      shared_mcp: settings.sharedMcp
    }
  }
}

function settingsFromDocument(value) {
  if (!value || typeof value !== 'object' || !value.settings || typeof value.settings !== 'object') {
    throw new Error('Profile TOML is missing [settings]')
  }
  const names = {
    fullPermission: 'full_permission', sharedSessions: 'shared_sessions', sharedModels: 'shared_models',
    sharedConfig: 'shared_config', sharedSkills: 'shared_skills', sharedMcp: 'shared_mcp'
  }
  const settings = {}
  for (const [key, field] of Object.entries(names)) {
    const current = value.settings[field]
    if (current !== undefined && typeof current !== 'boolean') throw new Error(`Profile TOML setting ${field} must be true or false`)
    settings[key] = current === true
  }
  return normalizeProfileSettings(settings)
}

function parseProfileDocument(text, tool, profile) {
  const value = toml.parse(text)
  if (value.profile?.id !== profile.id || value.profile?.cli !== tool.id) {
    throw new Error(`Profile TOML belongs to another profile or CLI: ${profile.name}`)
  }
  return { name: value.profile.name, settings: settingsFromDocument(value) }
}

async function writeProfileDocument(tool, profile, systemRoot) {
  const file = profileDocumentPath(tool, profile, systemRoot)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const partial = `${file}.${randomUUID()}.partial`
  try {
    await fsp.writeFile(partial, toml.stringify(documentValue(tool, profile)), 'utf8')
    await fsp.rename(partial, file)
  } finally { await fsp.rm(partial, { force: true }).catch(() => {}) }
  return file
}

function writeProfileDocumentSync(tool, profile, systemRoot) {
  const file = profileDocumentPath(tool, profile, systemRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const partial = `${file}.${randomUUID()}.partial`
  try {
    fs.writeFileSync(partial, toml.stringify(documentValue(tool, profile)), 'utf8')
    fs.renameSync(partial, file)
  } finally { if (fs.existsSync(partial)) fs.rmSync(partial, { force: true }) }
  return file
}

async function migrateProfileDocuments(store, tools, systemRoot) {
  const profilesByTool = await store.ensureTools(tools.map((tool) => tool.id))
  for (const tool of tools) {
    for (const listed of profilesByTool[tool.id] || []) {
      let profile = listed
      const root = profileDir(tool, profile, systemRoot)
      const expected = profileDocumentPath(tool, profile, systemRoot)
      const suffixes = [`-${tool.name.toLowerCase()}.toml`, `-${tool.dir.toLowerCase()}.toml`]
      const candidates = (await fsp.readdir(root).catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })).filter((name) => suffixes.some((suffix) => name.toLowerCase().endsWith(suffix)))
      const matching = candidates.filter((name) => name.toLowerCase() === path.basename(expected).toLowerCase())
      if (matching.length > 1 || (candidates.length > 1 && !matching.length)) throw new Error(`Profile TOML files conflict in ${root}`)
      let existing = matching[0] || candidates[0]
      let changed = false
      const extras = candidates.filter((name) => name !== existing)
      for (const extra of extras) {
        parseProfileDocument(await fsp.readFile(path.join(root, extra), 'utf8'), tool, profile)
      }
      if (existing) {
        const saved = parseProfileDocument(await fsp.readFile(path.join(root, existing), 'utf8'), tool, profile)
        if (existing === path.basename(expected) && saved.name !== profile.name) {
          throw new Error(`Profile TOML name conflicts with profile index: ${expected}`)
        }
        if (JSON.stringify(saved.settings) !== JSON.stringify(normalizeProfileSettings(profile.settings))) {
          profile = await store.updateSettings(tool.id, profile.id, saved.settings)
          changed = true
        }
      }
      if (existing && existing !== path.basename(expected) && existing.toLowerCase() === path.basename(expected).toLowerCase()) {
        const temporary = path.join(root, `.profile-document-${randomUUID()}.partial`)
        await fsp.rename(path.join(root, existing), temporary)
        try { await fsp.rename(temporary, expected) } catch (error) {
          await fsp.rename(temporary, path.join(root, existing))
          throw error
        }
        existing = path.basename(expected)
      }
      if (!existing || existing !== path.basename(expected) || changed) await writeProfileDocument(tool, profile, systemRoot)
      if (existing && existing !== path.basename(expected)) {
        await fsp.rm(path.join(root, existing))
      }
      for (const extra of extras) await fsp.rm(path.join(root, extra))
      await fsp.rm(path.join(root, 'profile.json'), { force: true })
    }
  }
  return store.ensureTools(tools.map((tool) => tool.id))
}

module.exports = {
  migrateProfileDocuments,
  parseProfileDocument,
  profileDocumentName,
  profileDocumentPath,
  writeProfileDocument,
  writeProfileDocumentSync
}
