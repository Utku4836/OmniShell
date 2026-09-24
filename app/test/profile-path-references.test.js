const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { ProfileStore } = require('../lib/profile-store')
const { findTool, profileDir } = require('../lib/tooling')
const { recordPendingRename, recoverPendingRenames } = require('../lib/profile-layout')
const { applyProfilePathUpdates, planProfilePathUpdates, replaceProfilePaths, restoreProfilePathUpdates } = require('../lib/profile-path-references')

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-path-rename-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value)
}

test('profile path replacement handles native, JSON-escaped and slash paths without touching sibling names', () => {
  const oldRoot = 'C:\\OmniShell\\Codex\\Profiles\\Old'
  const newRoot = 'C:\\OmniShell\\Codex\\Profiles\\New-$1'
  const input = [
    `${oldRoot}\\mcp.js`,
    JSON.stringify(`${oldRoot}\\mcp.js`),
    `${oldRoot.replaceAll('\\', '/')}/mcp.js`,
    `${oldRoot}Suffix\\mcp.js`
  ].join('\n')
  const result = replaceProfilePaths(input, oldRoot, newRoot)
  assert.ok(result.includes(`${newRoot}\\mcp.js`))
  assert.ok(result.includes(JSON.stringify(`${newRoot}\\mcp.js`)))
  assert.ok(result.includes(`${newRoot.replaceAll('\\', '/')}/mcp.js`))
  assert.ok(result.includes(`${oldRoot}Suffix\\mcp.js`))
})

test('a failed configuration update restores every file already changed', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('codex')
  const store = new ProfileStore(root)
  const profile = await store.create(tool.id, 'Old')
  const oldRoot = profileDir(tool, profile, root)
  const newRoot = profileDir(tool, { ...profile, name: 'New' }, root)
  const ownConfig = path.join(oldRoot, '.codex/config.toml')
  const sharedConfig = path.join(root, 'Codex/_shared/sharedConfig/.codex/config.toml')
  const original = `[mcp_servers.local]\ncommand = ${JSON.stringify(path.join(oldRoot, 'mcp.js'))}\nother = ${JSON.stringify(path.join(newRoot, 'keep.js'))}\n`
  await write(ownConfig, original)
  await write(sharedConfig, original)
  const plan = await planProfilePathUpdates(tool, profile, 'New', await store.list(tool.id), root)
  await fs.rename(oldRoot, newRoot)
  const realRename = fs.rename
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === sharedConfig) throw Object.assign(new Error('locked configuration'), { code: 'EACCES' })
    return realRename(from, to)
  })
  await assert.rejects(applyProfilePathUpdates(plan), /locked configuration/)
  mock.mock.restore()
  assert.equal(plan.applied.length, 1)
  await restoreProfilePathUpdates(plan)
  assert.equal(await fs.readFile(path.join(newRoot, '.codex/config.toml'), 'utf8'), original)
  assert.equal(await fs.readFile(sharedConfig, 'utf8'), original)
})

test('startup completes profile path updates after an interrupted rename', async (t) => {
  const root = await temporaryRoot(t)
  const tool = findTool('codex')
  const store = new ProfileStore(root)
  const profile = await store.create(tool.id, 'Old')
  const oldRoot = profileDir(tool, profile, root)
  const newRoot = profileDir(tool, { ...profile, name: 'New' }, root)
  await write(path.join(oldRoot, '.codex/config.toml'), `command = ${JSON.stringify(path.join(oldRoot, 'mcp.js'))}\n`)
  await recordPendingRename(root, tool, profile, 'New')
  await fs.rename(oldRoot, newRoot)
  await store.rename(tool.id, profile.id, 'New')
  await recoverPendingRenames(new ProfileStore(root), [tool], root)
  assert.equal(await fs.readFile(path.join(newRoot, '.codex/config.toml'), 'utf8'), `command = ${JSON.stringify(path.join(newRoot, 'mcp.js'))}\n`)
  assert.equal((await fs.readdir(path.join(root, '_profiles/operations')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).length, 0)
})
