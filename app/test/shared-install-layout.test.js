const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { ProfileStore } = require('../lib/profile-store')
const { TOOLS, cleanupInstallArtifacts, createInstallPlan, createIsolatedEnvironment, findTool, profileDir, resolveLocalExecutable, toolDir } = require('../lib/tooling')
const { migrateProfileLayout } = require('../lib/profile-layout')
const { migrateSharedInstallations } = require('../lib/shared-install-layout')

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-shared-install-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { system: path.join(root, 'system'), userData: path.join(root, 'userData') }
}

async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
}

async function oldStore(system, toolId, profiles) {
  await write(path.join(system, '_profiles', 'profiles.json'), JSON.stringify({
    schemaVersion: 2, layoutVersion: 2, tools: { [toolId]: profiles }
  }))
  return new ProfileStore(system)
}

const other = { id: `p_${'a'.repeat(32)}`, name: 'Work', settings: {} }
const defaultProfile = { id: 'default', name: 'Default', settings: {} }

test('one shared installation serves isolated profiles and preserves the other runtime in trash', async (t) => {
  const { system } = await temp(t)
  const tool = findTool('codex')
  const store = await oldStore(system, tool.id, [defaultProfile, other])
  await write(path.join(profileDir(tool, defaultProfile, system), 'runtime/node_modules/.bin/codex.cmd'), 'default binary')
  await write(path.join(profileDir(tool, other, system), 'runtime/node_modules/.bin/codex.cmd'), 'work binary')
  await write(path.join(profileDir(tool, defaultProfile, system), '.codex/auth.json'), 'default account')
  await write(path.join(profileDir(tool, other, system), '.codex/auth.json'), 'work account')
  await migrateSharedInstallations(store, [tool], system)
  assert.equal(await fs.readFile(path.join(toolDir(tool, system), 'node_modules/.bin/codex.cmd'), 'utf8'), 'default binary')
  assert.equal(resolveLocalExecutable(tool, system, defaultProfile), resolveLocalExecutable(tool, system, other))
  assert.equal(await fs.readFile(path.join(profileDir(tool, other, system), '.codex/auth.json'), 'utf8'), 'work account')
  assert.equal(await fs.readFile(path.join(profileDir(tool, defaultProfile, system), '.codex/auth.json'), 'utf8'), 'default account')
  assert.equal(await fs.readFile(path.join(system, '_profiles/trash/legacy-runtimes/codex', other.id, 'node_modules/.bin/codex.cmd'), 'utf8'), 'work binary')
  await assert.rejects(fs.access(path.join(profileDir(tool, other, system), 'runtime')), { code: 'ENOENT' })
  assert.equal((await store.load()).state.sharedInstallVersion, 1)
  await migrateSharedInstallations(new ProfileStore(system), [tool], system)
})

test('an installed custom runtime is selected when Default has no CLI', async (t) => {
  const { system } = await temp(t)
  const tool = findTool('codex')
  const store = await oldStore(system, tool.id, [defaultProfile, other])
  await write(path.join(profileDir(tool, defaultProfile, system), 'runtime/package.json'), '{}')
  await write(path.join(profileDir(tool, other, system), 'runtime/node_modules/.bin/codex.cmd'), 'installed')
  await migrateSharedInstallations(store, [tool], system)
  assert.equal(await fs.readFile(path.join(toolDir(tool, system), 'node_modules/.bin/codex.cmd'), 'utf8'), 'installed')
  assert.equal(await fs.readFile(path.join(system, '_profiles/trash/legacy-runtimes/codex/default/package.json'), 'utf8'), '{}')
})

test('a partially moved installation resumes and a conflicting destination stops safely', async (t) => {
  const { system } = await temp(t)
  const tool = findTool('codex')
  const store = await oldStore(system, tool.id, [defaultProfile])
  const runtime = path.join(profileDir(tool, defaultProfile, system), 'runtime')
  await write(path.join(runtime, 'node_modules/.bin/codex.cmd'), 'binary')
  await write(path.join(runtime, 'package.json'), '{}')
  const journal = path.join(system, '_profiles/shared-installs/codex.json')
  await write(journal, JSON.stringify({ toolId: tool.id, selected: { profileId: 'default', profileName: 'Default' }, entries: ['node_modules', 'package.json'], archives: [] }))
  await fs.rename(path.join(runtime, 'node_modules'), path.join(toolDir(tool, system), 'node_modules'))
  await migrateSharedInstallations(store, [tool], system)
  assert.equal(await fs.readFile(path.join(toolDir(tool, system), 'package.json'), 'utf8'), '{}')
  await assert.rejects(fs.access(journal), { code: 'ENOENT' })

  const next = await temp(t)
  const blockedStore = await oldStore(next.system, tool.id, [defaultProfile])
  const source = path.join(profileDir(tool, defaultProfile, next.system), 'runtime/node_modules/.bin/codex.cmd')
  const target = path.join(toolDir(tool, next.system), 'node_modules/.bin/codex.cmd')
  await write(source, 'old')
  await write(target, 'new')
  await assert.rejects(migrateSharedInstallations(blockedStore, [tool], next.system), /conflicts/)
  assert.equal(await fs.readFile(source, 'utf8'), 'old')
  assert.equal(await fs.readFile(target, 'utf8'), 'new')
})

test('legacy layouts and every installer type use each tool root while profiles keep separate homes', async (t) => {
  const { system, userData } = await temp(t)
  const tools = [findTool('codex'), findTool('agy'), findTool('aider'), findTool('cursor-agent'), findTool('goose')]
  await write(path.join(system, '_profiles/profiles.json'), JSON.stringify({
    schemaVersion: 2, tools: Object.fromEntries(tools.map((tool) => [tool.id, [defaultProfile]]))
  }))
  await write(path.join(system, 'Codex/node_modules/.bin/codex.cmd'), 'codex')
  await write(path.join(system, 'Antigravity/AppData/Local/agy/bin/agy.exe'), 'agy')
  await write(path.join(system, 'Aider/bin/aider.exe'), 'aider')
  await write(path.join(system, 'CursorAgent/bin/cursor-agent.exe'), 'cursor')
  await write(path.join(system, 'Goose/bin/goose.exe'), 'goose')
  const store = new ProfileStore(system)
  await migrateProfileLayout(store, tools, system, userData)
  await migrateSharedInstallations(store, tools, system)
  for (const tool of tools) {
    assert.ok(resolveLocalExecutable(tool, system, defaultProfile), tool.id)
    await assert.rejects(fs.access(path.join(profileDir(tool, defaultProfile, system), 'runtime')), { code: 'ENOENT' })
  }
  for (const tool of TOOLS) {
    const plan = createInstallPlan(tool, path.resolve(__dirname, '..'), system, defaultProfile, '1.2.3')
    assert.equal(plan.cwd, toolDir(tool, system), tool.id)
    const work = { id: other.id, name: 'Work' }
    const left = createIsolatedEnvironment(tool, {}, system, defaultProfile)
    const right = createIsolatedEnvironment(tool, {}, system, work)
    assert.notEqual(left.HOME, right.HOME, tool.id)
    assert.equal(left.npm_config_prefix, toolDir(tool, system), tool.id)
    assert.equal(right.npm_config_prefix, toolDir(tool, system), tool.id)
  }
})

test('installer cleanup removes only installation scratch data', async (t) => {
  const { system } = await temp(t)
  const tool = findTool('codex')
  const root = toolDir(tool, system)
  await write(path.join(root, 'install-temp/archive.zip'), 'download')
  await write(path.join(root, 'Temp/unpacked.bin'), 'temporary')
  await write(path.join(root, '.cache/npm/tarball'), 'cached')
  await write(path.join(root, 'node_modules/.bin/codex.cmd'), 'installation')
  await write(path.join(profileDir(tool, defaultProfile, system), 'Temp/session.txt'), 'profile data')
  await cleanupInstallArtifacts(tool, system)
  for (const name of ['install-temp', 'Temp', '.cache/npm']) {
    await assert.rejects(fs.access(path.join(root, name)), { code: 'ENOENT' })
  }
  assert.equal(await fs.readFile(path.join(root, 'node_modules/.bin/codex.cmd'), 'utf8'), 'installation')
  assert.equal(await fs.readFile(path.join(profileDir(tool, defaultProfile, system), 'Temp/session.txt'), 'utf8'), 'profile data')
})
