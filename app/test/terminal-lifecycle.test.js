const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const tooling = require('../lib/tooling')
const { ProfileStore } = require('../lib/profile-store')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-lifecycle-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const handlers = new Map()
  const app = new EventEmitter()
  let quitCount = 0
  Object.assign(app, {
    setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), getPath: () => path.join(root, 'userdata'),
    quit: () => { quitCount += 1 }
  })
  const spawned = []
  const pty = {
    spawn() {
      const proc = {
        pid: spawned.length + 100, onData() {}, onExit(callback) { this.exit = callback },
        write() {}, resize() {}, kill() { setImmediate(() => this.exit({ exitCode: 0 })) }
      }
      spawned.push(proc)
      return proc
    }
  }
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => handlers.set(name, callback) }
  const sourcePath = path.join(__dirname, '../main.js')
  const localRequire = createRequire(sourcePath)
  const store = new ProfileStore(root)
  await store.list('codex')
  const tool = tooling.findTool('codex')
  const install = async (profileId = 'default') => {
    const executable = tooling.executableCandidates(tool, root, profileId)[0]
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.writeFile(executable, '')
  }
  await install()
  vm.runInNewContext(await fs.readFile(sourcePath, 'utf8'), {
    require(name) {
      if (name === 'electron') return { app, ipcMain, webContents: { fromId: () => null }, globalShortcut: { unregisterAll() {} } }
      if (name === 'node-pty') return pty
      if (name === './lib/tooling') return {
        ...tooling, SYSTEM_ROOT: root,
        prepareProfileDirectories: (tool, id) => tooling.prepareProfileDirectories(tool, id, root)
      }
      if (name === './lib/profile-sharing') return {
        ...localRequire(name),
        hydrateSharedProfileData: options.hydrate || (async () => {}),
        persistSharedProfileData: options.persist || (async () => {})
      }
      if (name === './lib/install-runtime') return { ...localRequire(name), terminateProcessTree: (proc) => { proc.kill(); return true } }
      return localRequire(name)
    },
    __dirname: path.dirname(sourcePath), process, console, URL, setTimeout, clearTimeout, setImmediate
  }, { filename: sourcePath })
  const event = (id = 1) => ({ sender: { id, isDestroyed: () => false } })
  return {
    root, spawned, app, install, event, quitCount: () => quitCount,
    invoke: (name, senderId, ...args) => handlers.get(name)(event(senderId), ...args),
    async create(name, settings) {
      const result = await handlers.get('profiles:create')(event(), 'codex', name, settings)
      assert.equal(result.ok, true, result.error)
      await install(result.profile.id)
      return result.profile
    }
  }
}

test('stopping while hydration is pending prevents a late PTY from spawning', async (t) => {
  const entered = deferred()
  const release = deferred()
  const h = await harness(t, { hydrate: async () => { entered.resolve(); await release.promise } })
  const start = h.invoke('terminal:start', 1, 'codex', 'default')
  await entered.promise
  const stop = h.invoke('terminal:stop', 1)
  release.resolve()
  assert.equal((await start).ok, false)
  assert.equal((await stop).ok, true)
  assert.equal(h.spawned.length, 0)
})

test('a superseding launch leaves exactly one live terminal', async (t) => {
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const h = await harness(t, { hydrate: async () => { if (++calls === 1) { entered.resolve(); await release.promise } } })
  const first = h.invoke('terminal:start', 1, 'codex', 'default')
  await entered.promise
  const second = h.invoke('terminal:start', 1, 'codex', 'default')
  release.resolve()
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, true)
  assert.equal(h.spawned.length, 1)
  await h.invoke('terminal:stop', 1)
})

test('stop and restart wait for exited profile data to finish publishing', async (t) => {
  const saving = deferred()
  const release = deferred()
  let hydrated = 0
  const h = await harness(t, {
    hydrate: async () => { hydrated += 1 },
    persist: async () => { saving.resolve(); await release.promise }
  })
  assert.equal((await h.invoke('terminal:start', 1, 'codex', 'default')).ok, true)
  const restart = h.invoke('terminal:start', 1, 'codex', 'default')
  await saving.promise
  assert.equal(hydrated, 1)
  release.resolve()
  assert.equal((await restart).ok, true)
  assert.equal(hydrated, 2)
  await h.invoke('terminal:stop', 1)
})

test('quit waits for the final profile write', async (t) => {
  const saving = deferred()
  const release = deferred()
  const h = await harness(t, { persist: async () => { saving.resolve(); await release.promise } })
  await h.invoke('terminal:start', 1, 'codex', 'default')
  let prevented = false
  h.app.emit('before-quit', { preventDefault: () => { prevented = true } })
  await saving.promise
  assert.equal(prevented, true)
  assert.equal(h.quitCount(), 0)
  release.resolve()
  await new Promise(setImmediate)
  assert.equal(h.quitCount(), 1)
})

test('independent profiles run together, shared writers cannot collide', async (t) => {
  const h = await harness(t)
  const independent = await h.create('Independent', {})
  assert.equal((await h.invoke('terminal:start', 1, 'codex', 'default')).ok, true)
  assert.equal((await h.invoke('terminal:start', 2, 'codex', independent.id)).ok, true)
  await Promise.all([h.invoke('terminal:stop', 1), h.invoke('terminal:stop', 2)])
  const first = await h.create('Shared A', { sharedSessions: true })
  const second = await h.create('Shared B', { sharedSessions: true })
  assert.equal((await h.invoke('terminal:start', 1, 'codex', first.id)).ok, true)
  const collision = await h.invoke('terminal:start', 2, 'codex', second.id)
  assert.equal(collision.ok, false)
  assert.match(collision.error, /shared data/)
  await h.invoke('terminal:stop', 1)
  assert.equal((await h.invoke('terminal:start', 2, 'codex', second.id)).ok, true)
  await h.invoke('terminal:stop', 2)
})

test('settings and deletion are rejected while a profile is starting', async (t) => {
  const entered = deferred()
  const release = deferred()
  const h = await harness(t, { hydrate: async () => { entered.resolve(); await release.promise } })
  const profile = await h.create('Work', {})
  const start = h.invoke('terminal:start', 1, 'codex', profile.id)
  await entered.promise
  assert.equal((await h.invoke('profiles:update-settings', 1, 'codex', profile.id, { fullPermission: true })).ok, false)
  assert.equal((await h.invoke('profiles:delete', 1, 'codex', profile.id)).ok, false)
  release.resolve()
  assert.equal((await start).ok, true)
  await h.invoke('terminal:stop', 1)
})

test('invalid profile identifiers return a structured terminal failure', async (t) => {
  const h = await harness(t)
  const result = await h.invoke('terminal:start', 1, 'codex', '../escape')
  assert.equal(result.ok, false)
  assert.match(result.error, /Invalid profile/)
  assert.equal(h.spawned.length, 0)
})
