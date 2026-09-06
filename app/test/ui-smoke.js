const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('UI smoke timed out'); app.exit(1) }, 45000)
const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'omnishell-ui-'))
process.env.OMNISHELL_DISABLE_AUTO_UPDATE = '1'
process.env.OMNISHELL_SYSTEM_ROOT = path.join(root, 'system')
app.setPath('userData', path.join(root, 'userdata'))
const errors = []

;(async () => {
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
  assert.equal(await js('gridColumns()'), 1)
  assert.ok(await js('listScroll.getBoundingClientRect().right < brandStage.getBoundingClientRect().right'), 'tool list is left of the wordmark')
  assert.deepEqual(await js('[rows.get("claude").item.dataset.distance, rows.get("codex").item.dataset.distance, rows.get("opencode").item.dataset.distance]'), ['0', '1', '2'])
  assert.ok(await js('rows.get("claude").item.getBoundingClientRect().width > rows.get("codex").item.getBoundingClientRect().width && rows.get("codex").item.getBoundingClientRect().width > rows.get("opencode").item.getBoundingClientRect().width'), 'focus size falls off with distance')
  await js('selectTool("codex", true)')
  await delay(240)
  assert.deepEqual(await js('[rows.get("claude").item.dataset.distance, rows.get("codex").item.dataset.distance, rows.get("opencode").item.dataset.distance]'), ['1', '0', '1'])
  const carouselCost = await js('(() => { const start=performance.now(); for(let index=0;index<200;index++) selectTool(tools[index%tools.length].id); return {elapsed:performance.now()-start, frame:carouselFrame} })()')
  assert.ok(carouselCost.elapsed < 50, `selection updates took ${carouselCost.elapsed}ms`)
  assert.notEqual(carouselCost.frame, 0, 'selection updates share one animation frame')
  await js('selectTool("codex", true)')
  await delay(240)
  const outputDir = path.resolve(__dirname, '../../out/review')
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(path.join(outputDir, 'focus-carousel.png'), (await win.webContents.capturePage()).toPNG())
  const viewAnimation = js('(() => { const pending=showView("terminal"); window.__viewTransitionActive=viewTerminal.getAnimations().length>0; return pending.then(()=>window.__viewTransitionActive) })()')
  assert.equal(await viewAnimation, true, 'opening the terminal uses the view transition')
  await js('showView("list", true)')
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
  await fs.writeFile(path.join(outputDir, 'switch-cli.png'), (await win.webContents.capturePage()).toPNG())
  await js('ctxSubMenu.querySelector("[data-tool-id=opencode]").click()')
  await delay(100)
  assert.equal(await js('profileDialogToolId'), 'opencode', 'Switch CLI opens the selected profile picker')
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await js('closeProfilePicker(true); hideContextMenu(); clearTerminalSurface()')
  await js('new Promise(resolve => terminal.write("\\x1b[48;2;160;20;20m" + " ".repeat(terminal.cols * terminal.rows) + "\\x1b[0m", resolve))')
  await js('paintTerminalEdges()')
  assert.equal(await js('terminalSurfaceColor'), '#000000', 'diff background cannot recolor the terminal surface')
  await js('new Promise(resolve => { let data="\\x1b[2J"; for(let row=1;row<=terminal.rows;row++) data += "\\x1b["+row+";1H\\x1b[48;2;32;31;39m"+" ".repeat(terminal.cols); terminal.write(data+"\\x1b[0m", resolve) })')
  await js('paintTerminalEdges()')
  assert.equal(await js('terminal.options.theme.background'), '#000000', 'neutral gray cells do not change the theme')
  const bottom = await js('Array.from($("terminal-edges").getContext("2d").getImageData(Math.floor($("terminal-edges").width/2),$("terminal-edges").height-1,1,1).data)')
  assert.deepEqual(bottom, [32,31,39,255], 'bottom padding matches the actual terminal edge')
  await js('new Promise(resolve => terminal.write("\\r\\n".repeat(150), resolve))')
  const scrollbarWidth = await js('parseFloat(getComputedStyle(terminal.element.querySelector(".scrollbar.vertical")).width)')
  assert.ok(scrollbarWidth <= 5.1, 'terminal scrollbar remains narrow')
  assert.ok(await js('(() => { const screen=terminal.element.querySelector(".xterm-screen"),r=screen.getBoundingClientRect(); for(let p=screen.parentElement;p && p!==viewTerminal;p=p.parentElement){const b=p.getBoundingClientRect(),s=getComputedStyle(p);if(["hidden","clip"].includes(s.overflowX) && r.right>b.right+1)return false;if(["hidden","clip"].includes(s.overflowY) && r.bottom>b.bottom+1)return false;}return true })()'), 'terminal grid fits its clipping ancestors')
  for (const [width, height] of [[480, 340], [1100, 720]]) {
    win.setSize(width, height)
    await delay(100)
    await js('showContextMenu(innerWidth - 12, innerHeight - 12); openSubmenu()')
    const bounds = await js('(() => { const r = ctxSubMenu.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: innerHeight, width: innerWidth } })()')
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.left >= 0 && bounds.right <= bounds.width, `submenu fits ${width}x${height}`)
  }
  await js('hideContextMenu(); leaveTerminal()')
  assert.equal(await js('currentView'), 'list')
  await js('openProfilePicker(getTool("copilot"))')
  win.webContents.send('install:progress', {toolId:'copilot',profileId:'default',percent:42,line:'Downloading packages',elapsedSeconds:8})
  await delay(50)
  assert.match(await js('profileStatus.textContent'), /42%/)
  assert.equal(await js('profileInstall.textContent'), 'CANCEL')
  win.webContents.send('install:done', {toolId:'copilot',profileId:'default',ok:true})
  await delay(50)
  assert.equal(await js('profileInstall.textContent'), 'UPDATE')
  assert.match(await js('profileStatus.textContent'), /ready/)
  await js('closeProfilePicker(true)')
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
  const secondary = await js('window.api.createProfile("codex", "Second window", {})')
  const secondaryExe = path.join(root,'system/Codex/profiles',secondary.profile.id,'runtime/node_modules/.bin/codex.cmd')
  await fs.mkdir(path.dirname(secondaryExe),{recursive:true})
  await fs.copyFile(executable,secondaryExe)
  await js('openTerminal(getTool("codex"))')
  const parentSession = await js('activeSessionId')
  await js(`openProfilePicker(getTool('codex'), ${JSON.stringify(secondary.profile.id)}, 'switch');`)
  await js('openSelectedProfile()')
  let extra
  for(let attempt=0;attempt<100;attempt++) {
    extra=BrowserWindow.getAllWindows().find(w=>w.id!==win.id)
    if(extra && await extra.webContents.executeJavaScript('typeof terminal !== "undefined" && activeSessionId !== null && terminal.buffer.active.getLine(0)?.translateToString().includes("OMNISHELL_TEST_READY")').catch(()=>false)) break
    await delay(30)
  }
  assert.ok(extra,'Switch CLI creates an auxiliary window')
  assert.equal(await js('activeSessionId'),parentSession,'original session is preserved')
  assert.equal(await extra.webContents.executeJavaScript('isAuxiliaryWindow'),true)
  await extra.webContents.executeJavaScript('window.api.ptyWrite("done" + String.fromCharCode(13))')
  for(let attempt=0;attempt<100 && !await extra.webContents.executeJavaScript('terminalExited');attempt++) await delay(30)
  assert.equal(extra.isDestroyed(),false,'auxiliary window remains available after its CLI exits')
  assert.match(await extra.webContents.executeJavaScript('Array.from({length:terminal.rows},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString()).join("\\n")'), /Session ended \/ exit 0/)
  extra.webContents.executeJavaScript('window.api.closeWindow()')
  for(let attempt=0;attempt<100 && !extra.isDestroyed();attempt++) await delay(30)
  assert.equal(extra.isDestroyed(),true,'auxiliary window closes through the animated window action')
  await js('window.api.ptyWrite("done" + String.fromCharCode(13))')
  for(let attempt=0;attempt<100 && !await js('terminalExited');attempt++) await delay(30)
  assert.equal(await js('currentView'),'terminal')
  assert.match(await js('Array.from({length:terminal.rows},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString()).join("\\n")'), /Session ended \/ exit 0/)
  await js('leaveTerminal()')
  assert.equal(await js('currentView'),'list')
  win.setSize(480,340)
  await delay(100)
  await js('selectTool("kimi",true)')
  await delay(240)
  assert.ok(await js('(() => { const r=rows.get("kimi").item.getBoundingClientRect(),g=listScroll.getBoundingClientRect(); return r.top>=g.top-1 && r.bottom<=g.bottom+1 })()'), 'keyboard navigation reveals the last item in a short window')
  assert.deepEqual(errors, [])
  console.log('PASS Electron: real ConPTY start/stop, Switch CLI hover+click, profile picker, diff colors, responsive submenu, SQLite sharing')
  clearTimeout(timeout)
  win.destroy()
  await delay(250)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  app.quit()
})().catch(async (error) => {
  console.error(error)
  clearTimeout(timeout)
  for (const win of BrowserWindow.getAllWindows()) {
    await win.webContents.executeJavaScript('window.api.terminalStop()').catch(() => {})
  }
  app.exit(1)
})
