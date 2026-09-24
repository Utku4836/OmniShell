const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { ProfileStore, normalizeProfileName } = require('../lib/profile-store')
const { findTool, profileDir } = require('../lib/tooling')
const { migrateProfileLayout, recordPendingRename, recoverPendingRenames } = require('../lib/profile-layout')

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-layout-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { system: path.join(root, 'system'), userData: path.join(root, 'userData') }
}

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value)
}

async function legacyStore(system, profiles) {
  await write(path.join(system, '_profiles', 'profiles.json'), JSON.stringify({
    schemaVersion: 2, tools: { codex: profiles }
  }))
  return new ProfileStore(system)
}

const customId = `p_${'a'.repeat(32)}`

test('legacy Default and custom profiles move with their runtime, workspace and logs', async (t) => {
  const { system, userData } = await temp(t)
  const tool = findTool('codex')
  const profiles = [{ id: 'default', name: 'Default', settings: {} }, { id: customId, name: 'Work', settings: {} }]
  const store = await legacyStore(system, profiles)
  await write(path.join(system, 'Codex', 'node_modules', '.bin', 'codex.cmd'), 'default cli')
  await write(path.join(system, 'Codex', '.codex', 'auth.json'), 'default secret')
  await write(path.join(system, 'Codex', '_shared', 'sharedSessions', 'keep.txt'), 'shared')
  await write(path.join(system, 'Codex', 'profiles', customId, 'runtime', 'node_modules', '.bin', 'codex.cmd'), 'work cli')
  await write(path.join(system, 'Codex', 'profiles', customId, '.codex', 'auth.json'), 'work secret')
  await write(path.join(userData, 'workspaces', 'codex', 'default', 'notes.txt'), 'default work')
  await write(path.join(userData, 'workspaces', 'codex', customId, 'notes.txt'), 'custom work')
  await write(path.join(system, '_install', 'logs', 'codex--default-2026-01-01T00-00-00-000Z.log'), 'default log')
  await write(path.join(system, '_install', 'logs', `codex--${customId}-2026-01-02T00-00-00-000Z.log`), 'custom log')

  await migrateProfileLayout(store, [tool], system, userData)
  const defaultRoot = profileDir(tool, profiles[0], system)
  const workRoot = profileDir(tool, profiles[1], system)
  assert.equal(await fs.readFile(path.join(defaultRoot, 'runtime', 'node_modules', '.bin', 'codex.cmd'), 'utf8'), 'default cli')
  assert.equal(await fs.readFile(path.join(defaultRoot, '.codex', 'auth.json'), 'utf8'), 'default secret')
  assert.equal(await fs.readFile(path.join(workRoot, 'runtime', 'node_modules', '.bin', 'codex.cmd'), 'utf8'), 'work cli')
  assert.equal(await fs.readFile(path.join(workRoot, '.codex', 'auth.json'), 'utf8'), 'work secret')
  assert.equal(await fs.readFile(path.join(defaultRoot, 'workspace', 'notes.txt'), 'utf8'), 'default work')
  assert.equal(await fs.readFile(path.join(workRoot, 'workspace', 'notes.txt'), 'utf8'), 'custom work')
  assert.equal((await fs.readdir(path.join(defaultRoot, 'logs'))).length, 1)
  assert.equal((await fs.readdir(path.join(workRoot, 'logs'))).length, 1)
  assert.equal(await fs.readFile(path.join(system, 'Codex', '_shared', 'sharedSessions', 'keep.txt'), 'utf8'), 'shared')
  assert.equal((await new ProfileStore(system).load()).state.layoutVersion, 2)
  await assert.rejects(fs.access(path.join(system, 'Codex', 'profiles', customId)), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(userData, 'workspaces', 'codex', 'default')), { code: 'ENOENT' })
  await migrateProfileLayout(new ProfileStore(system), [tool], system, userData)
  assert.equal(await fs.readFile(path.join(workRoot, '.codex', 'auth.json'), 'utf8'), 'work secret')
})

test('an interrupted custom migration resumes from its staging folder', async (t) => {
  const { system, userData } = await temp(t)
  const tool = findTool('codex')
  const profiles = [{ id: 'default', name: 'Default', settings: {} }, { id: customId, name: 'Work', settings: {} }]
  const store = await legacyStore(system, profiles)
  await write(path.join(system, 'Codex', 'Profiles', `.moving-${customId}`, 'runtime', 'node_modules', '.bin', 'codex.cmd'), 'staged')
  await migrateProfileLayout(store, [tool], system, userData)
  assert.equal(await fs.readFile(path.join(profileDir(tool, profiles[1], system), 'runtime', 'node_modules', '.bin', 'codex.cmd'), 'utf8'), 'staged')
})

test('an interrupted Default migration resumes moving the remaining configuration', async (t) => {
  const { system, userData } = await temp(t)
  const tool = findTool('codex')
  const profile = { id: 'default', name: 'Default', settings: {} }
  const store = await legacyStore(system, [profile])
  await write(path.join(system, 'Codex', 'Profiles', '.moving-default', 'node_modules', '.bin', 'codex.cmd'), 'staged cli')
  await write(path.join(system, 'Codex', '.codex', 'auth.json'), 'remaining secret')
  await migrateProfileLayout(store, [tool], system, userData)
  assert.equal(await fs.readFile(path.join(profileDir(tool, profile, system), 'runtime', 'node_modules', '.bin', 'codex.cmd'), 'utf8'), 'staged cli')
  assert.equal(await fs.readFile(path.join(profileDir(tool, profile, system), '.codex', 'auth.json'), 'utf8'), 'remaining secret')
})

test('native installer layouts move their executables into each Default runtime', async (t) => {
  const { system, userData } = await temp(t)
  const tools = [findTool('agy'), findTool('aider'), findTool('cursor-agent'), findTool('goose')]
  const profile = { id: 'default', name: 'Default', settings: {} }
  await write(path.join(system, '_profiles', 'profiles.json'), JSON.stringify({
    schemaVersion: 2, tools: Object.fromEntries(tools.map((tool) => [tool.id, [profile]]))
  }))
  await write(path.join(system, 'Antigravity', 'AppData', 'Local', 'agy', 'bin', 'agy.exe'), 'agy')
  await write(path.join(system, 'Aider', 'bin', 'aider.exe'), 'aider')
  await write(path.join(system, 'CursorAgent', 'bin', 'cursor-agent.exe'), 'cursor')
  await write(path.join(system, 'Goose', 'bin', 'goose.exe'), 'goose')
  await migrateProfileLayout(new ProfileStore(system), tools, system, userData)
  for (const [tool, executable] of [['agy', 'AppData/Local/agy/bin/agy.exe'], ['aider', 'bin/aider.exe'],
    ['cursor-agent', 'bin/cursor-agent.exe'], ['goose', 'bin/goose.exe']]) {
    assert.equal(await fs.readFile(path.join(profileDir(findTool(tool), profile, system), 'runtime', executable), 'utf8'),
      tool === 'cursor-agent' ? 'cursor' : tool)
  }
})

test('a conflicting destination stops migration without replacing old data', async (t) => {
  const { system, userData } = await temp(t)
  const tool = findTool('codex')
  const profiles = [{ id: 'default', name: 'Default', settings: {} }, { id: customId, name: 'Work', settings: {} }]
  const store = await legacyStore(system, profiles)
  const legacy = path.join(system, 'Codex', 'profiles', customId, 'secret.txt')
  await write(legacy, 'secret')
  const conflict = path.join(system, 'Codex', 'Profiles', 'Work', 'other.txt')
  await write(conflict, 'other')
  await assert.rejects(migrateProfileLayout(store, [tool], system, userData), /conflicts/)
  assert.equal(await fs.readFile(legacy, 'utf8'), 'secret')
  assert.equal(await fs.readFile(conflict, 'utf8'), 'other')
  assert.equal((await new ProfileStore(system).load()).state.layoutVersion, 1)
})

test('invalid legacy names become safe folder names, while new invalid names are rejected', async (t) => {
  const { system, userData } = await temp(t)
  const tool = findTool('codex')
  const store = await legacyStore(system, [{ id: 'default', name: 'CON', settings: {} }, { id: customId, name: 'Work/Personal', settings: {} }])
  await migrateProfileLayout(store, [tool], system, userData)
  const profiles = await store.list('codex')
  assert.equal(profiles[0].name, 'CON-profile')
  assert.equal(profiles[1].name, 'Work-Personal')
  assert.equal((await fs.readdir(path.join(system, 'Codex', 'Profiles'))).length, 2)
  const report = JSON.parse(await fs.readFile(path.join(system, '_profiles', 'layout-migration.json'), 'utf8'))
  assert.equal(report.renamed.length, 2)
  for (const name of ['CON', 'Work/Personal', 'name.', 'one:two']) assert.throws(() => normalizeProfileName(name))
})

test('an interrupted rename restores the folder to the name saved in metadata', async (t) => {
  const { system } = await temp(t)
  const tool = findTool('codex')
  const store = new ProfileStore(system)
  const profile = await store.create('codex', 'Work')
  const source = profileDir(tool, profile, system)
  const renamed = profileDir(tool, { ...profile, name: 'Personal' }, system)
  await write(path.join(source, 'secret.txt'), 'preserved')
  await recordPendingRename(system, tool, profile, 'Personal')
  await fs.rename(source, renamed)
  await recoverPendingRenames(new ProfileStore(system), [tool], system)
  assert.equal(await fs.readFile(path.join(source, 'secret.txt'), 'utf8'), 'preserved')
  await assert.rejects(fs.access(renamed), { code: 'ENOENT' })

  await recordPendingRename(system, tool, profile, 'Personal')
  await store.rename('codex', profile.id, 'Personal')
  await recoverPendingRenames(new ProfileStore(system), [tool], system)
  assert.equal(await fs.readFile(path.join(renamed, 'secret.txt'), 'utf8'), 'preserved')
  await assert.rejects(fs.access(source), { code: 'ENOENT' })
})
