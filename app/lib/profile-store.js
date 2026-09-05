const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const SCHEMA_VERSION = 2
const DEFAULT_PROFILE_ID = 'default'
const PROFILE_ID_PATTERN = /^p_[0-9a-f]{32}$/
const DEFAULT_PROFILE_SETTINGS = Object.freeze({
  fullPermission: false,
  sharedSessions: false,
  sharedModels: false,
  sharedConfig: false
})

function normalizeProfileSettings(value = {}) {
  return Object.fromEntries(Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, value?.[key] === true]))
}

function cloneProfile(profile) {
  return { ...profile, settings: normalizeProfileSettings(profile.settings) }
}

function normalizeProfileName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ')
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Profile name must contain 1-40 visible characters')
  }
  return name
}

function validateProfileId(profileId) {
  if (profileId === DEFAULT_PROFILE_ID || PROFILE_ID_PATTERN.test(String(profileId || ''))) return profileId
  throw new Error('Invalid profile identifier')
}

function defaultProfile(now) {
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'Default',
    settings: normalizeProfileSettings(),
    createdAt: now,
    updatedAt: now
  }
}

class ProfileStore {
  constructor(systemRoot, options = {}) {
    this.directory = path.join(systemRoot, '_profiles')
    this.filePath = path.join(this.directory, 'profiles.json')
    this.now = options.now || (() => new Date().toISOString())
    this.uuid = options.uuid || randomUUID
    this.state = { schemaVersion: SCHEMA_VERSION, tools: {} }
    this.loadPromise = null
    this.writeQueue = Promise.resolve()
  }

  async load() {
    if (!this.loadPromise) this.loadPromise = this.#loadFromDisk()
    await this.loadPromise
    return this
  }

  async #loadFromDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, 'utf8'))
      if (![1, SCHEMA_VERSION].includes(parsed?.schemaVersion) || !parsed.tools || typeof parsed.tools !== 'object' || Array.isArray(parsed.tools)) {
        throw new Error('Unsupported profile metadata schema')
      }
      this.state = {
        schemaVersion: SCHEMA_VERSION,
        tools: Object.fromEntries(Object.entries(parsed.tools).map(([toolId, profiles]) => [
          toolId,
          Array.isArray(profiles) ? profiles.map((profile) => ({ ...profile, settings: normalizeProfileSettings(profile.settings) })) : []
        ]))
      }
    } catch (error) {
      if (error.code === 'ENOENT') return
      if (error.code) throw error
      await fsp.mkdir(this.directory, { recursive: true })
      const backupPath = path.join(this.directory, `profiles.corrupt-${Date.now()}.json`)
      await fsp.rename(this.filePath, backupPath)
      this.state = { schemaVersion: SCHEMA_VERSION, tools: {} }
    }
  }

  #profilesFor(toolId) {
    const current = this.state.tools[toolId]
    return Array.isArray(current) ? current : []
  }

  async #persist() {
    await fsp.mkdir(this.directory, { recursive: true })
    const partialPath = path.join(this.directory, `profiles.${process.pid}.${this.uuid()}.partial`)
    try {
      await fsp.writeFile(partialPath, JSON.stringify(this.state, null, 2), 'utf8')
      await fsp.rename(partialPath, this.filePath)
    } finally {
      await fsp.rm(partialPath, { force: true }).catch(() => {})
    }
  }

  #mutate(operation) {
    const task = this.writeQueue.then(async () => {
      await this.load()
      const previous = structuredClone(this.state)
      try {
        const result = operation()
        await this.#persist()
        return result
      } catch (error) {
        this.state = previous
        throw error
      }
    })
    this.writeQueue = task.catch(() => {})
    return task
  }

  async list(toolId) {
    await this.load()
    await this.writeQueue
    if (this.#profilesFor(toolId).length === 0) {
      await this.#mutate(() => {
        if (this.#profilesFor(toolId).length === 0) {
          this.state.tools[toolId] = [defaultProfile(this.now())]
        }
      })
    }
    return this.#profilesFor(toolId).map(cloneProfile)
  }

  async ensureTools(toolIds) {
    await this.load()
    await this.writeQueue
    const missing = toolIds.filter((toolId) => this.#profilesFor(toolId).length === 0)
    if (missing.length > 0) {
      await this.#mutate(() => {
        for (const toolId of missing) {
          if (this.#profilesFor(toolId).length === 0) {
            this.state.tools[toolId] = [defaultProfile(this.now())]
          }
        }
      })
    }
    return Object.fromEntries(toolIds.map((toolId) => [
      toolId,
      this.#profilesFor(toolId).map(cloneProfile)
    ]))
  }

  async get(toolId, profileId = DEFAULT_PROFILE_ID) {
    validateProfileId(profileId)
    const profiles = await this.list(toolId)
    return profiles.find((profile) => profile.id === profileId) || null
  }

  async create(toolId, requestedName, requestedSettings = {}) {
    const name = normalizeProfileName(requestedName)
    const settings = normalizeProfileSettings(requestedSettings)
    return this.#mutate(() => {
      const profiles = this.#profilesFor(toolId)
      if (profiles.length === 0) profiles.push(defaultProfile(this.now()))
      const duplicate = profiles.some((profile) => profile.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)
      if (duplicate) throw new Error('A profile with this name already exists')
      const timestamp = this.now()
      const profile = {
        id: `p_${this.uuid().replace(/-/g, '')}`,
        name,
        settings,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      profiles.push(profile)
      this.state.tools[toolId] = profiles
      return cloneProfile(profile)
    })
  }

  async rename(toolId, profileId, requestedName) {
    validateProfileId(profileId)
    const name = normalizeProfileName(requestedName)
    return this.#mutate(() => {
      const profiles = this.#profilesFor(toolId)
      if (profiles.length === 0) profiles.push(defaultProfile(this.now()))
      const profile = profiles.find((candidate) => candidate.id === profileId)
      if (!profile) throw new Error('Profile not found')
      const duplicate = profiles.some((candidate) =>
        candidate.id !== profileId && candidate.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
      )
      if (duplicate) throw new Error('A profile with this name already exists')
      profile.name = name
      profile.updatedAt = this.now()
      this.state.tools[toolId] = profiles
      return cloneProfile(profile)
    })
  }

  async updateSettings(toolId, profileId, requestedSettings) {
    validateProfileId(profileId)
    const settings = normalizeProfileSettings(requestedSettings)
    return this.#mutate(() => {
      const profile = this.#profilesFor(toolId).find((candidate) => candidate.id === profileId)
      if (!profile) throw new Error('Profile not found')
      profile.settings = settings
      profile.updatedAt = this.now()
      return cloneProfile(profile)
    })
  }

  async delete(toolId, profileId) {
    validateProfileId(profileId)
    if (profileId === DEFAULT_PROFILE_ID) throw new Error('The Default profile cannot be deleted')
    return this.#mutate(() => {
      const profiles = this.#profilesFor(toolId)
      const index = profiles.findIndex((candidate) => candidate.id === profileId)
      if (index < 0) throw new Error('Profile not found')
      const [profile] = profiles.splice(index, 1)
      return cloneProfile(profile)
    })
  }
}

module.exports = {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_SETTINGS,
  PROFILE_ID_PATTERN,
  ProfileStore,
  normalizeProfileName,
  normalizeProfileSettings,
  validateProfileId
}
