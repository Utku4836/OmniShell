const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { DEFAULT_PROFILE_ID, normalizeProfileName } = require('./profile-store')
const { profileDir, toolDir } = require('./tooling')
const { applyProfilePathUpdates, planProfilePathUpdates } = require('./profile-path-references')

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

async function removeIfEmpty(directory) {
  try { await fs.rmdir(directory) } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

async function hasFiles(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || await hasFiles(path.join(directory, entry.name))) return true
  }
  return false
}

function safeLegacyName(value, used) {
  let base = String(value || '').trim().replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '').slice(0, 40).replace(/[. ]+$/g, '') || 'Profile'
  if (/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i.test(base)) base = `${base.slice(0, 32)}-profile`
  let candidate = base
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix += 1) {
    const ending = ` (${suffix})`
    candidate = `${base.slice(0, 40 - ending.length)}${ending}`
  }
  used.add(candidate.toLowerCase())
  return normalizeProfileName(candidate)
}

function renameJournalPath(systemRoot, toolId, profileId) {
  return path.join(systemRoot, '_profiles', 'operations', `${toolId}--${profileId}.json`)
}

async function recordPendingRename(systemRoot, tool, profile, to) {
  await writeJson(renameJournalPath(systemRoot, tool.id, profile.id), {
    toolId: tool.id, profileId: profile.id, from: profile.name, to
  })
}

async function clearPendingRename(systemRoot, tool, profileId) {
  await fs.rm(renameJournalPath(systemRoot, tool.id, profileId), { force: true })
}

async function recoverPendingRenames(store, tools, systemRoot) {
  const directory = path.join(systemRoot, '_profiles', 'operations')
  if (!await exists(directory)) return
  for (const file of await fs.readdir(directory)) {
    if (!file.endsWith('.json')) continue
    const pending = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))
    const tool = tools.find((candidate) => candidate.id === pending.toolId)
    if (!tool) throw new Error(`Unknown tool in pending profile rename: ${file}`)
    const profile = await store.get(tool.id, pending.profileId)
    if (!profile || ![pending.from, pending.to].includes(profile.name)) {
      throw new Error(`Profile rename state conflicts with metadata: ${file}`)
    }
    const source = profileDir(tool, { ...profile, name: pending.from }, systemRoot)
    const destination = profileDir(tool, { ...profile, name: pending.to }, systemRoot)
    const temporary = path.join(path.dirname(source), `.renaming-${profile.id}`)
    const chosen = profile.name === pending.to ? destination : source
    if (await exists(temporary)) {
      if (await exists(source) || await exists(destination)) throw new Error(`Profile rename paths conflict: ${file}`)
      await fs.rename(temporary, chosen)
    } else if (!await exists(chosen)) {
      const other = chosen === source ? destination : source
      if (!await exists(other)) throw new Error(`Profile rename folder is missing: ${file}`)
      await fs.rename(other, chosen)
    } else if (source.toLowerCase() !== destination.toLowerCase() && await exists(chosen === source ? destination : source)) {
      throw new Error(`Profile rename paths conflict: ${file}`)
    }
    if (source !== destination && source.toLowerCase() === destination.toLowerCase()) {
      const entries = await fs.readdir(path.dirname(chosen))
      const actual = entries.find((name) => name.toLowerCase() === path.basename(chosen).toLowerCase())
      if (actual && actual !== path.basename(chosen)) {
        await fs.rename(path.join(path.dirname(chosen), actual), temporary)
        await fs.rename(temporary, chosen)
      }
    }
    if (profile.name === pending.to) {
      const previous = { ...profile, name: pending.from }
      const updates = await planProfilePathUpdates(tool, previous, pending.to, await store.list(tool.id), systemRoot)
      await applyProfilePathUpdates(updates)
    }
    await writeProfileDescriptor(tool, profile, systemRoot)
    await clearPendingRename(systemRoot, tool, profile.id)
  }
  await removeIfEmpty(directory)
}

async function movePath(source, destination) {
  if (!await exists(source)) return
  if (await exists(destination)) throw new Error(`Profile migration target already exists: ${destination}`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    const partial = `${destination}.copying`
    await fs.rm(partial, { recursive: true, force: true })
    await fs.cp(source, partial, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    if (!await sameTree(source, partial)) throw new Error(`Profile migration copy could not be verified: ${source}`)
    await fs.rename(partial, destination)
    await fs.rm(source, { recursive: true, force: true })
  }
}

async function sameTree(left, right) {
  const a = await fs.lstat(left)
  const b = await fs.lstat(right)
  if (a.isSymbolicLink() || b.isSymbolicLink()) throw new Error('Profile migration cannot copy linked data across volumes')
  if (a.isFile()) return b.isFile() && a.size === b.size && await fileHash(left) === await fileHash(right)
  if (!a.isDirectory() || !b.isDirectory()) return false
  const names = await fs.readdir(left)
  const other = await fs.readdir(right)
  if (names.length !== other.length) return false
  for (const name of names) {
    if (!other.includes(name) || !await sameTree(path.join(left, name), path.join(right, name))) return false
  }
  return true
}

async function fileHash(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256')
    fsSync.createReadStream(file).on('data', (chunk) => digest.update(chunk))
      .once('error', reject).once('end', () => resolve(digest.digest('hex')))
  })
}

async function importWorkspace(source, destination) {
  const copying = `${destination}.copying`
  if (await exists(copying)) await fs.rm(copying, { recursive: true, force: true })
  if (!await exists(source)) return
  if (await exists(destination)) {
    if (!await sameTree(source, destination)) throw new Error(`Profile workspace conflicts with existing data: ${destination}`)
    await fs.rm(source, { recursive: true, force: true })
    return
  }
  await movePath(source, destination)
}

async function writeProfileDescriptor(tool, profile, systemRoot) {
  const root = profileDir(tool, profile, systemRoot)
  await writeJson(path.join(root, 'profile.json'), {
    id: profile.id, name: profile.name, settings: profile.settings, updatedAt: profile.updatedAt,
    data: '.', runtime: '../..', workspace: 'workspace', logs: 'logs'
  })
}

async function importLegacyLogs(tool, profile, systemRoot, destination) {
  const old = path.join(systemRoot, '_install', 'logs')
  if (!await exists(old)) return
  const prefixes = [`${tool.id}--${profile.id}-`]
  if (profile.id === DEFAULT_PROFILE_ID) prefixes.push(`${tool.id}-`)
  for (const name of await fs.readdir(old)) {
    if (profile.id === DEFAULT_PROFILE_ID && name.startsWith(`${tool.id}--`) && !name.startsWith(`${tool.id}--default-`)) continue
    const prefix = prefixes.find((item) => name.startsWith(item))
    if (!prefix || !name.endsWith('.log')) continue
    const newName = `install-${name.slice(prefix.length)}`
    await movePath(path.join(old, name), path.join(destination, 'logs', newName))
  }
}

async function moveDefaultRuntime(tool, stage) {
  const runtime = path.join(stage, 'runtime')
  const entries = ['node_modules', 'package.json', 'package-lock.json', '.omnishell-install.json', 'bin', 'uv',
    `${tool.bin}.cmd`, `${tool.bin}.exe`, `${tool.bin}.bat`]
  for (const name of entries) await movePath(path.join(stage, name), path.join(runtime, name))
  if (tool.id === 'agy') {
    await movePath(path.join(stage, 'AppData', 'Local', 'agy', 'bin'), path.join(runtime, 'AppData', 'Local', 'agy', 'bin'))
  }
  if (tool.id === 'aider') {
    await movePath(path.join(stage, '.local', 'bin'), path.join(runtime, '.local', 'bin'))
  }
  for (const name of ['npm', 'uv']) {
    await movePath(path.join(stage, '.cache', name), path.join(runtime, '.cache', name))
  }
}

async function migrateOne(tool, profile, systemRoot, userDataRoot) {
  const toolRoot = toolDir(tool, systemRoot)
  const target = profileDir(tool, profile, systemRoot)
  const stage = path.join(toolRoot, 'Profiles', `.moving-${profile.id}`)
  const legacy = path.join(toolRoot, 'profiles', profile.id)
  const targetExists = await exists(target)
  if (targetExists) {
    let descriptor
    try { descriptor = JSON.parse(await fs.readFile(path.join(target, 'profile.json'), 'utf8')) } catch (error) {}
    if (descriptor?.id !== profile.id || await exists(stage) || (profile.id !== DEFAULT_PROFILE_ID && await exists(legacy))) {
      throw new Error(`Profile migration target conflicts with existing data: ${target}`)
    }
  } else {
    await fs.mkdir(path.dirname(stage), { recursive: true })
    if (!await exists(stage)) {
      if (profile.id !== DEFAULT_PROFILE_ID && await exists(legacy)) await movePath(legacy, stage)
      else await fs.mkdir(stage, { recursive: true })
    }
    if (profile.id !== DEFAULT_PROFILE_ID && await exists(legacy)) {
      throw new Error(`Profile migration has both staged and original data: ${legacy}`)
    }
    if (profile.id === DEFAULT_PROFILE_ID) {
      for (const name of await fs.readdir(toolRoot)) {
        if (['Profiles', 'profiles', '_shared'].includes(name)) continue
        await movePath(path.join(toolRoot, name), path.join(stage, name))
      }
      await moveDefaultRuntime(tool, stage)
    }
  }

  const working = targetExists ? target : stage
  await fs.mkdir(path.join(working, 'runtime'), { recursive: true })
  await fs.mkdir(path.join(working, 'logs'), { recursive: true })
  await importWorkspace(path.join(userDataRoot, 'workspaces', tool.id, profile.id), path.join(working, 'workspace'))
  await fs.mkdir(path.join(working, 'workspace'), { recursive: true })
  await importLegacyLogs(tool, profile, systemRoot, working)
  const oldScratch = path.join(systemRoot, '_install', tool.id, profile.id)
  if (await exists(oldScratch)) await fs.rm(oldScratch, { recursive: true, force: true })
  if (!targetExists) {
    await writeJson(path.join(stage, 'profile.json'), {
      id: profile.id, name: profile.name, settings: profile.settings, updatedAt: profile.updatedAt,
      data: '.', runtime: 'runtime', workspace: 'workspace', logs: 'logs'
    })
    await fs.rename(stage, target)
  }
  await writeProfileDescriptor(tool, profile, systemRoot)
}

async function migrateProfileLayout(store, tools, systemRoot, userDataRoot) {
  await store.load()
  const profilesByTool = await store.ensureTools(tools.map((tool) => tool.id))
  if (store.state.layoutVersion === 2) {
    for (const tool of tools) {
      for (const profile of profilesByTool[tool.id] || []) {
        const root = profileDir(tool, profile, systemRoot)
        if (!await exists(root)) continue
        const descriptor = path.join(root, 'profile.json')
        if (!await exists(descriptor)) {
          if (await exists(path.join(root, `${profile.name}-${tool.name}.Toml`))
            || await exists(path.join(root, `${profile.name}-${tool.dir}.Toml`))) continue
          if (await hasFiles(root)) throw new Error(`Profile folder has data without a descriptor: ${root}`)
          continue
        }
        const saved = JSON.parse(await fs.readFile(descriptor, 'utf8'))
        if (saved.id !== profile.id) throw new Error(`Profile folder belongs to another profile: ${root}`)
      }
    }
    return profilesByTool
  }

  const reportPath = path.join(systemRoot, '_profiles', 'layout-migration.json')
  let report
  try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    report = { startedAt: new Date().toISOString(), renamed: [] }
  }
  for (const tool of tools) {
    const used = new Set()
    const profiles = profilesByTool[tool.id] || []
    for (const profile of profiles) {
      let safe
      try {
        safe = normalizeProfileName(profile.name)
        if (safe !== profile.name || used.has(safe.toLowerCase())) safe = safeLegacyName(profile.name, used)
        else used.add(safe.toLowerCase())
      } catch (error) { safe = safeLegacyName(profile.name, used) }
      if (safe !== profile.name) {
        report.renamed.push({ toolId: tool.id, profileId: profile.id, from: profile.name, to: safe })
        await writeJson(reportPath, report)
        const updated = await store.rename(tool.id, profile.id, safe)
        Object.assign(profile, updated)
      }
    }
  }
  for (const tool of tools) {
    for (const profile of profilesByTool[tool.id] || []) {
      await migrateOne(tool, profile, systemRoot, userDataRoot)
    }
    await removeIfEmpty(path.join(toolDir(tool, systemRoot), 'profiles'))
    await removeIfEmpty(path.join(userDataRoot, 'workspaces', tool.id))
    await removeIfEmpty(path.join(systemRoot, '_install', tool.id))
  }
  await removeIfEmpty(path.join(userDataRoot, 'workspaces'))
  await removeIfEmpty(path.join(systemRoot, '_install', 'logs'))
  await removeIfEmpty(path.join(systemRoot, '_install'))
  await store.markLayoutCurrent()
  report.completedAt = new Date().toISOString()
  await writeJson(reportPath, report)
  return profilesByTool
}

module.exports = { clearPendingRename, migrateProfileLayout, recordPendingRename, recoverPendingRenames, safeLegacyName, writeProfileDescriptor }
