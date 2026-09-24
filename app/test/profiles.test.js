const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const toml = require('@iarna/toml')
const { ProfileStore } = require('../lib/profile-store')
const { prepareProfileLaunch } = require('../lib/profile-launch')
const { hydrateSharedProfileData, migrateLegacySharedMcp, persistSharedProfileData, sharingCapabilities } = require('../lib/profile-sharing')
const { findTool, profileDir } = require('../lib/tooling')
const { terminateProcessTree } = require('../lib/install-runtime')

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function write(root, relative, data) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
  return file
}

test('failed disk writes roll back profile changes and the queue recovers', async (t) => {
  const root = await temporaryRoot(t)
  const store = new ProfileStore(root)
  const profile = await store.create('codex', 'Work')
  const originalRename = fs.rename
  const mock = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('disk denied'), { code: 'EACCES' }) })
  await assert.rejects(store.rename('codex', profile.id, 'Lost'), /disk denied/)
  await assert.rejects(store.delete('codex', profile.id), /disk denied/)
  assert.equal((await store.get('codex', profile.id)).name, 'Work')
  assert.equal((await new ProfileStore(root).get('codex', profile.id)).name, 'Work')
  assert.deepEqual((await fs.readdir(store.directory)).filter((file) => file.endsWith('.partial')), [])
  mock.mock.restore()
  assert.equal(fs.rename, originalRename)
  await store.rename('codex', profile.id, 'Recovered')
  assert.equal((await new ProfileStore(root).get('codex', profile.id)).name, 'Recovered')
})

test('read errors do not move or overwrite valid profile metadata', async (t) => {
  const root = await temporaryRoot(t)
  const store = new ProfileStore(root)
  await store.create('codex', 'Work')
  const before = await fs.readFile(store.filePath, 'utf8')
  const mock = t.mock.method(fs, 'readFile', async () => { throw Object.assign(new Error('file locked'), { code: 'EACCES' }) })
  await assert.rejects(new ProfileStore(root).load(), /file locked/)
  mock.mock.restore()
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before)
  assert.deepEqual(await fs.readdir(store.directory), ['profiles.json'])
})

test('v1 settings migrate without rewriting during read, corrupt JSON is recoverable', async (t) => {
  const root = await temporaryRoot(t)
  const file = await write(root, '_profiles/profiles.json', JSON.stringify({ schemaVersion: 1, tools: { codex: [{ id: 'default', name: 'Default' }] } }))
  const store = new ProfileStore(root)
  assert.equal((await store.get('codex')).settings.fullPermission, false)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion, 1)
  await store.rename('codex', 'default', 'Main')
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion, 2)
  await fs.writeFile(file, '{broken')
  await new ProfileStore(root).list('codex')
  const backup = (await fs.readdir(store.directory)).find((name) => name.startsWith('profiles.corrupt-'))
  assert.equal(await fs.readFile(path.join(store.directory, backup), 'utf8'), '{broken')
})

test('Full Permission for Qwen never changes the shared config', async (t) => {
  const root = await temporaryRoot(t)
  const config = '{"tools":{"approvalMode":"default"},"theme":"dark"}'
  const file = await write(root, '.qwen/settings.json', config)
  const result = await prepareProfileLaunch({ id: 'qwen' }, { settings: { fullPermission: true } }, root, {})
  assert.deepEqual(result.args, ['--approval-mode', 'yolo'])
  assert.equal(await fs.readFile(file, 'utf8'), config)
  assert.deepEqual((await prepareProfileLaunch({ id: 'qwen' }, { settings: {} }, root, {})).args, [])
})

test('legacy Qwen permission backup restores only the previous approval setting', async (t) => {
  const root = await temporaryRoot(t)
  const file = await write(root, '.qwen/settings.json', '{"tools":{"approvalMode":"yolo"},"theme":"dark"}')
  await write(root, '.qwen/.omnishell-permission-backup.json', '{"existed":true,"value":"default"}')
  await prepareProfileLaunch({ id: 'qwen' }, { settings: {} }, root, {})
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { tools: { approvalMode: 'default' }, theme: 'dark' })
})

test('malformed Amp config is not replaced with an empty permissive config', async (t) => {
  const root = await temporaryRoot(t)
  const file = await write(root, '.config/amp/amp.json', '{broken')
  await assert.rejects(prepareProfileLaunch({ id: 'amp' }, { settings: { fullPermission: true } }, root, {}), SyntaxError)
  assert.equal(await fs.readFile(file, 'utf8'), '{broken')
  await assert.rejects(fs.access(path.join(root, '.config/amp/omnishell-full-permission.json')), { code: 'ENOENT' })
})

test('sharing copies committed SQLite WAL data and never transfers credentials', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('codex')
  const first = { id: 'default', name: 'Default', settings: { sharedSessions: true } }
  const second = { id: `p_${'a'.repeat(32)}`, name: 'Second', settings: { sharedSessions: true } }
  const firstRoot = profileDir(tool, first, root)
  const secondRoot = profileDir(tool, second, root)
  const file = await write(firstRoot, '.codex/state_5.sqlite', '')
  const db = new DatabaseSync(file)
  try {
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES (\'first\')')
  await write(firstRoot, '.codex/auth.json', 'private-first')
  await write(secondRoot, '.codex/auth.json', 'private-second')
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  const copy = new DatabaseSync(path.join(secondRoot, '.codex/state_5.sqlite'))
  try {
    assert.equal(copy.prepare('SELECT id FROM sessions').get().id, 'first')
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { copy.close() }
  assert.equal(await fs.readFile(path.join(secondRoot, '.codex/auth.json'), 'utf8'), 'private-second')
  await assert.rejects(fs.access(path.join(root, 'Codex/_shared/sharedSessions/.codex/auth.json')), { code: 'ENOENT' })
  db.exec('INSERT INTO sessions VALUES (\'second\')')
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  const updated = new DatabaseSync(path.join(secondRoot, '.codex/state_5.sqlite'))
  try { assert.equal(updated.prepare('SELECT count(*) AS count FROM sessions').get().count, 2) } finally { updated.close() }
  } finally { db.close() }
})

test('sharing does not follow linked session folders outside the profile', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('codex')
  const profile = { id: 'default', name: 'Default', settings: { sharedSessions: true } }
  const outside = path.join(root, 'unshared')
  await write(outside, 'private.json', 'secret')
  const sessions = path.join(profileDir(tool, profile, root), '.codex/sessions')
  await fs.mkdir(path.dirname(sessions), { recursive: true })
  await fs.symlink(outside, sessions, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(persistSharedProfileData(tool, profile, root), /links/)
  assert.equal(await fs.readFile(path.join(outside, 'private.json'), 'utf8'), 'secret')
})

test('skills and MCP remain private until their separate controls are enabled', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('codex')
  const first = { id: 'default', name: 'Default', settings: { sharedConfig: true } }
  const second = { id: `p_${'b'.repeat(32)}`, name: 'Second', settings: { sharedConfig: true } }
  const firstRoot = profileDir(tool, first, root)
  const secondRoot = profileDir(tool, second, root)
  await write(firstRoot, '.codex/skills/private/SKILL.md', 'private skill')
  await write(firstRoot, '.codex/config.toml', '[mcp_servers.private]\ncommand = "secret"\n[model_provider]\nname = "first"\n')
  await write(secondRoot, '.codex/config.toml', '[mcp_servers.second]\ncommand = "second"\n')
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  assert.equal(toml.parse(await fs.readFile(path.join(secondRoot, '.codex/config.toml'), 'utf8')).mcp_servers.second.command, 'second')
  assert.equal(toml.parse(await fs.readFile(path.join(secondRoot, '.codex/config.toml'), 'utf8')).model_provider.name, 'first')
  await assert.rejects(fs.access(path.join(secondRoot, '.codex/skills/private/SKILL.md')), { code: 'ENOENT' })
  assert.equal(toml.parse(await fs.readFile(path.join(root, 'Codex/_shared/sharedConfig/.codex/config.toml'), 'utf8')).mcp_servers, undefined)
  first.settings.sharedSkills = true
  first.settings.sharedMcp = true
  second.settings.sharedSkills = true
  second.settings.sharedMcp = true
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  assert.equal(await fs.readFile(path.join(secondRoot, '.codex/skills/private/SKILL.md'), 'utf8'), 'private skill')
  assert.equal(toml.parse(await fs.readFile(path.join(secondRoot, '.codex/config.toml'), 'utf8')).mcp_servers.private.command, 'secret')
  assert.equal(toml.parse(await fs.readFile(path.join(secondRoot, '.codex/config.toml'), 'utf8')).model_provider.name, 'first')
})

test('Qwen JSONC MCP sharing keeps other settings separate', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('qwen')
  const first = { id: 'default', name: 'Default', settings: { sharedMcp: true } }
  const second = { id: `p_${'c'.repeat(32)}`, name: 'Second', settings: { sharedMcp: true } }
  await write(profileDir(tool, first, root), '.qwen/settings.json', '{ // comment\n "theme": "light", "mcpServers": {"local": {"command":"one"}} }')
  await write(profileDir(tool, second, root), '.qwen/settings.json', '{"theme":"dark"}')
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  const secondConfig = JSON.parse(await fs.readFile(path.join(profileDir(tool, second, root), '.qwen/settings.json'), 'utf8'))
  assert.equal(secondConfig.theme, 'dark')
  assert.equal(secondConfig.mcpServers.local.command, 'one')
})

test('old Shared Config MCP entries are removed from the live shared copy with a recoverable backup', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('codex')
  const file = await write(root, 'Codex/_shared/sharedConfig/.codex/config.toml', '[mcp_servers.secret]\ncommand = "private"\n[model_provider]\nname = "example"\n')
  await migrateLegacySharedMcp(tool, root)
  const live = toml.parse(await fs.readFile(file, 'utf8'))
  assert.equal(live.mcp_servers, undefined)
  assert.equal(live.model_provider.name, 'example')
  const backups = await fs.readdir(path.join(root, '_profiles/trash/legacy-shared-mcp/codex'))
  assert.equal(backups.length, 1)
  assert.match(await fs.readFile(path.join(root, '_profiles/trash/legacy-shared-mcp/codex', backups[0]), 'utf8'), /private/)
  await migrateLegacySharedMcp(tool, root)
  assert.equal((await fs.readdir(path.join(root, '_profiles/trash/legacy-shared-mcp/codex'))).length, 1)
})

test('Goose YAML keeps private extensions out of Shared Config and shares them only with Shared MCP', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('goose')
  const first = { id: 'default', name: 'Default', settings: { sharedConfig: true } }
  const second = { id: `p_${'d'.repeat(32)}`, name: 'Second', settings: { sharedConfig: true } }
  const relative = 'AppData/Roaming/Block/goose/config/config.yaml'
  await write(profileDir(tool, first, root), relative, 'provider: example\nextensions:\n  private:\n    type: stdio\n    cmd: private\n')
  await write(profileDir(tool, second, root), relative, 'extensions:\n  local:\n    type: stdio\n    cmd: local\n')
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  const privateConfig = await fs.readFile(path.join(profileDir(tool, second, root), relative), 'utf8')
  assert.match(privateConfig, /local/)
  assert.doesNotMatch(privateConfig, /private/)
  assert.match(privateConfig, /provider: example/)
  first.settings.sharedMcp = true
  second.settings.sharedMcp = true
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  assert.match(await fs.readFile(path.join(profileDir(tool, second, root), relative), 'utf8'), /private/)
})

test('direct MCP files and tool capabilities are isolated by CLI', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('cursor-agent')
  const first = { id: 'default', name: 'Default', settings: { sharedMcp: true } }
  const second = { id: `p_${'e'.repeat(32)}`, name: 'Second', settings: { sharedMcp: true } }
  await write(profileDir(tool, first, root), '.cursor/mcp.json', '{"mcpServers":{"one":{"command":"one"}}}')
  await persistSharedProfileData(tool, first, root)
  await hydrateSharedProfileData(tool, second, root)
  assert.equal(JSON.parse(await fs.readFile(path.join(profileDir(tool, second, root), '.cursor/mcp.json'), 'utf8')).mcpServers.one.command, 'one')
  assert.equal(sharingCapabilities('aider').sharedMcp, false)
  assert.equal(sharingCapabilities('aider').sharedSkills, false)
  assert.equal(sharingCapabilities('cursor-agent').sharedSkills, true)
})

test('missing taskkill falls back to the PTY kill without an unhandled error', () => {
  const killer = new EventEmitter()
  let killed = 0
  assert.equal(terminateProcessTree({ pid: 123, kill: () => { killed += 1 } }, 'win32', () => killer), true)
  killer.emit('error', new Error('not found'))
  assert.equal(killed, 1)
})
