const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('UI smoke timed out'); app.exit(1) }, 45000)
let root
const errors = []

;(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-ui-'))
  app.setPath('userData', path.join(root, 'userdata'))
  process.env.OMNISHELL_SYSTEM_ROOT = path.join(root, 'system')
  // Exercise the real renderer, preload, IPC and ConPTY without visible test windows.
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.showInactive = function () {}
  const executable = path.join(root, 'system/Codex/node_modules/.bin/codex.cmd')
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, '@echo off\r\necho OMNISHELL_TEST_READY\r\nset /p reply=\r\n', 'utf8')
  app.on('web-contents-created', (_event, contents) => {
    contents.setBackgroundThrottling(false)
    contents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 3) errors.push(event.message)
    })
  })
  const load = Module._load
  Module._load = function (name, parent, ...args) {
    const result = load.call(this, name, parent, ...args)
    if (name !== 'electron') return result
    return { ...result, BrowserWindow: class extends BrowserWindow {
      constructor(options) {
        super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } })
      }
    } }
  }
  try { require('../main') } finally { Module._load = load }
  await app.whenReady()
  let win
  for (let attempt = 0; attempt < 100; attempt += 1) {
    win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading()) {
      const ready = await win.webContents.executeJavaScript('typeof tools !== "undefined" && tools.length === 12 && bootScreen.classList.contains("hidden")').catch(() => false)
      if (ready) break
    }
    await delay(50)
  }
  assert.ok(win, 'main window created')
  const js = (code) => win.webContents.executeJavaScript(code)
  assert.equal(await js('tools.length'), 12)
  await js('openTerminal(getTool("codex"))')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await js('terminal.buffer.active.getLine(0)?.translateToString().includes("OMNISHELL_TEST_READY")')) break
    await delay(30)
  }
  assert.equal(await js('terminalExited'), false)
  await js('showContextMenu(600, 300); ctxOpenOther.dispatchEvent(new PointerEvent("pointerenter")); ctxOpenOther.click()')
  await delay(200)
  assert.equal(await js('getComputedStyle(ctxSubMenu).display'), 'block', 'hover followed by click keeps Switch CLI open')
  const menuBounds = await js('(() => { const r = ctxSubMenu.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, left: r.left, height: innerHeight, width: innerWidth } })()')
  assert.ok(menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height && menuBounds.left >= 0 && menuBounds.right <= menuBounds.width, `submenu fits in window: ${JSON.stringify(menuBounds)}`)
  const outputDir = path.resolve(__dirname, '../../out/review')
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(path.join(outputDir, 'switch-cli.png'), (await win.webContents.capturePage()).toPNG())
  await js('ctxSubMenu.querySelector("[data-tool-id=opencode]").click()')
  await delay(100)
  assert.equal(await js('profileDialogToolId'), 'opencode', 'Switch CLI opens the selected profile picker')
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await js('closeProfilePicker(true); hideContextMenu(); clearTerminalSurface()')
  await js('new Promise(resolve => terminal.write("\\x1b[48;2;160;20;20m" + " ".repeat(terminal.cols * terminal.rows) + "\\x1b[0m", resolve))')
  await js('detectDominantTerminalBackground()')
  assert.equal(await js('terminalSurfaceColor'), '#000000', 'diff background cannot recolor the terminal surface')
  for (const [width, height] of [[480, 340], [1100, 720]]) {
    win.setSize(width, height)
    await delay(100)
    await js('showContextMenu(innerWidth - 12, innerHeight - 12); openSubmenu()')
    const bounds = await js('(() => { const r = ctxSubMenu.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: innerHeight, width: innerWidth } })()')
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.left >= 0 && bounds.right <= bounds.width, `submenu fits ${width}x${height}`)
  }
  await js('hideContextMenu(); leaveTerminal()')
  assert.equal(await js('currentView'), 'list')
  await js('openProfilePicker(getTool("codex"))')
  await delay(100)
  assert.equal(await js('profileList.children.length'), 1)
  await fs.writeFile(path.join(outputDir, 'profiles.png'), (await win.webContents.capturePage()).toPNG())
  const { DatabaseSync } = require('node:sqlite')
  const databasePath = path.join(root, 'system/Codex/.codex/state_5.sqlite')
  await fs.mkdir(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  database.exec("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('shared-session')")
  database.close()
  assert.equal((await js('window.api.updateProfileSettings("codex", "default", {sharedSessions: true})')).ok, true)
  await js('closeProfilePicker(true); openTerminal(getTool("codex"))')
  await js('leaveTerminal()')
  const shared = new DatabaseSync(path.join(root, 'system/Codex/_shared/sharedSessions/.codex/state_5.sqlite'), { readOnly: true })
  try { assert.equal(shared.prepare('SELECT id FROM sessions').get().id, 'shared-session') } finally { shared.close() }
  assert.deepEqual(errors, [])
  console.log('PASS Electron: real ConPTY start/stop, Switch CLI hover+click, profile picker, diff colors, responsive submenu, SQLite sharing')
  clearTimeout(timeout)
  win.destroy()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  app.exit(0)
})().catch(async (error) => {
  console.error(error)
  clearTimeout(timeout)
  for (const win of BrowserWindow.getAllWindows()) {
    await win.webContents.executeJavaScript('window.api.terminalStop()').catch(() => {})
  }
  app.exit(1)
})
