const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { executableCandidatesAtRoot, profileDir, toolDir } = require('./tooling')
const { writeProfileDescriptor } = require('./profile-layout')

async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const partial = `${file}.${randomUUID()}.partial`
  try {
    await fs.writeFile(partial, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(partial, file)
  } finally { await fs.rm(partial, { force: true }).catch(() => {}) }
}

function journalPath(systemRoot, tool) {
  return path.join(systemRoot, '_profiles', 'shared-installs', `${tool.id}.json`)
}

function archivePath(systemRoot, tool, profile) {
  return path.join(systemRoot, '_profiles', 'trash', 'legacy-runtimes', tool.id, profile.id)
}

async function installedAt(tool, root) {
  for (const candidate of executableCandidatesAtRoot(tool, root)) {
    if (await exists(candidate)) return true
  }
  return false
}

async function planTool(tool, profiles, systemRoot) {
  const runtimeProfiles = []
  for (const profile of profiles) {
    const runtime = path.join(profileDir(tool, profile, systemRoot), 'runtime')
    if (await exists(runtime)) runtimeProfiles.push({ profile, runtime, installed: await installedAt(tool, runtime) })
  }
  const selected = runtimeProfiles.find(({ profile, installed }) => profile.id === 'default' && installed)
    || runtimeProfiles.find(({ installed }) => installed)
    || runtimeProfiles.find(({ profile }) => profile.id === 'default')
    || runtimeProfiles[0]
  const destination = toolDir(tool, systemRoot)
  const entries = selected ? await fs.readdir(selected.runtime) : []
  for (const name of entries) {
    if (['Profiles', 'profiles', '_shared'].some((reserved) => reserved.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Shared CLI migration found a reserved installation entry: ${name}`)
    }
    if (await exists(path.join(destination, name))) {
      throw new Error(`Shared CLI migration target conflicts with existing data: ${path.join(destination, name)}`)
    }
  }
  const archives = runtimeProfiles.filter(({ profile }) => profile.id !== selected?.profile.id)
    .map(({ profile }) => ({ profileId: profile.id, profileName: profile.name }))
  for (const archived of archives) {
    if (await exists(archivePath(systemRoot, tool, { id: archived.profileId }))) {
      throw new Error(`Shared CLI migration archive already exists for ${tool.id}/${archived.profileId}`)
    }
  }
  return {
    toolId: tool.id,
    selected: selected ? { profileId: selected.profile.id, profileName: selected.profile.name } : null,
    entries,
    archives
  }
}

async function applyTool(tool, profiles, systemRoot, journal) {
  const destination = toolDir(tool, systemRoot)
  if (journal.selected) {
    const selected = profiles.find((profile) => profile.id === journal.selected.profileId)
    if (!selected || selected.name !== journal.selected.profileName) throw new Error(`Shared CLI migration profile changed for ${tool.id}`)
    const runtime = path.join(profileDir(tool, selected, systemRoot), 'runtime')
    for (const name of journal.entries) {
      const source = path.join(runtime, name)
      const target = path.join(destination, name)
      const sourceExists = await exists(source)
      const targetExists = await exists(target)
      if (sourceExists === targetExists) throw new Error(`Shared CLI migration cannot safely resume ${source}`)
      if (sourceExists) await fs.rename(source, target)
    }
    if (await exists(runtime)) await fs.rmdir(runtime)
  }
  for (const archived of journal.archives) {
    const profile = profiles.find((candidate) => candidate.id === archived.profileId)
    if (!profile || profile.name !== archived.profileName) throw new Error(`Shared CLI migration profile changed for ${tool.id}`)
    const source = path.join(profileDir(tool, profile, systemRoot), 'runtime')
    const target = archivePath(systemRoot, tool, profile)
    const sourceExists = await exists(source)
    const targetExists = await exists(target)
    if (sourceExists === targetExists) throw new Error(`Shared CLI migration cannot safely archive ${source}`)
    if (sourceExists) {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(source, target)
    }
  }
  for (const profile of profiles) await writeProfileDescriptor(tool, profile, systemRoot)
}

async function migrateSharedInstallations(store, tools, systemRoot) {
  await store.load()
  const profilesByTool = await store.ensureTools(tools.map((tool) => tool.id))
  if (store.state.sharedInstallVersion === 1) return profilesByTool
  for (const tool of tools) {
    const file = journalPath(systemRoot, tool)
    let journal
    try { journal = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      journal = await planTool(tool, profilesByTool[tool.id], systemRoot)
      await writeJson(file, journal)
    }
    if (journal.toolId !== tool.id || !Array.isArray(journal.entries) || !Array.isArray(journal.archives)) {
      throw new Error(`Invalid shared CLI migration journal: ${file}`)
    }
    await applyTool(tool, profilesByTool[tool.id], systemRoot, journal)
    await fs.rm(file)
  }
  await store.markSharedInstallCurrent()
  return profilesByTool
}

module.exports = { migrateSharedInstallations }
