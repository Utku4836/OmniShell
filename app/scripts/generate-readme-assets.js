const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const Module = require('node:module')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const projectRoot = path.resolve(__dirname, '../..')
const output = path.join(projectRoot, 'docs/images')
const working = path.join(projectRoot, 'out/readme')
const deadline = setTimeout(() => { console.error('README capture timed out'); app.exit(1) }, 60000)

const css = `
*{box-sizing:border-box}body{margin:0;background:#090909;color:#eeeae6;font-family:'Segoe UI',Arial,sans-serif}
.canvas{position:relative;width:1600px;overflow:hidden;padding:64px 80px;background:#090909}
.eyebrow{font:18px Consolas,monospace;letter-spacing:2px;color:#aaa49e;text-transform:uppercase}
.orange{color:#ff6427}.top{display:flex;align-items:center;justify-content:space-between}
.mark{display:inline-block;width:12px;height:12px;background:#ff6427;margin-right:14px}
h1{font-size:46px;line-height:1.2;font-weight:500;letter-spacing:-1px;margin:24px 0 0}
p{font-size:23px;line-height:1.55;color:#aaa49e;margin:16px 0 0}
.rule{height:1px;background:#29231f}.footer{position:absolute;bottom:40px;left:80px;right:80px;font:17px Consolas,monospace;color:#a69e97}
.shot{display:block;width:1440px;border:1px solid #39302a;border-radius:12px;box-shadow:0 16px 44px #0008}
.ascii{margin:0;white-space:pre;font-family:'Cascadia Mono',Consolas,monospace;font-size:31px;font-weight:700;line-height:.96;color:#ff6427;font-variant-ligatures:none}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:44px}
.panel{height:700px;border:1px solid #29231f;border-radius:12px;background:#10100f;padding:30px}
.panel .label{font:18px Consolas,monospace;color:#bbb4ac;margin-bottom:28px}
.detail{display:block;margin:0 auto;max-width:100%;height:auto}
`

async function poster(name, height, body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="canvas" style="height:${height}px">${body}</div></body></html>`
  const file = path.join(working, `${name}.html`)
  await fs.writeFile(file, html)
  const win = new BrowserWindow({ width: 1600, height, useContentSize: true, show: false, frame: false,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(file)
  await win.webContents.executeJavaScript('document.fonts.ready')
  await delay(150)
  const image = await win.webContents.capturePage()
  await fs.writeFile(path.join(output, `${name}.png`), image.toPNG())
  win.destroy()
}

;(async () => {
  const scratch = process.env.OMNISHELL_CAPTURE_ROOT
  if (!scratch) throw new Error('Run this generator through npm run docs:assets')
  await fs.mkdir(output, { recursive: true })
  await fs.mkdir(working, { recursive: true })
  app.setPath('userData', path.join(scratch, 'userdata'))
  process.env.OMNISHELL_SYSTEM_ROOT = path.join(scratch, 'system')
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.showInactive = function () {}
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
  const win = BrowserWindow.getAllWindows()[0]
  const js = (code) => win.webContents.executeJavaScript(code)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await js('typeof tools !== "undefined" && tools.length && bootScreen.classList.contains("hidden")').catch(() => false)) break
    await delay(50)
  }
  win.setContentSize(1440, 850)
  await delay(250)
  await js('selectTool("codex"); fitBrandTitle()')
  const ascii = await js('brandTitle.textContent')
  const home = (await win.webContents.capturePage()).toDataURL()

  const personal = await js('window.api.createProfile("codex", "Personal", {})')
  const work = await js('window.api.createProfile("codex", "Work", {sharedSessions: true, sharedModels: true})')
  if (!personal.ok || !work.ok) throw new Error('Could not create demonstration profiles')
  // Empty command wrappers mark sample profiles as installed; no CLI is executed.
  for (const id of ['default', personal.profile.id, work.profile.id]) {
    const base = id === 'default' ? path.join(scratch, 'system/Codex') : path.join(scratch, 'system/Codex/profiles', id, 'runtime')
    await fs.mkdir(path.join(base, 'node_modules/.bin'), { recursive: true })
    await fs.writeFile(path.join(base, 'node_modules/.bin/codex.cmd'), '@echo off\r\n')
  }
  win.webContents.setZoomFactor(1.4)
  await js(`showView('terminal'); initTerminal(); applyTerminalSurface(getTool('codex')); openProfilePicker(getTool('codex'), ${JSON.stringify(work.profile.id)})`)
  await delay(250)
  async function captureCard() {
    const rect = await js('(() => { const r=profileCard.getBoundingClientRect(), z=1.4; return {x:Math.floor(r.x*z),y:Math.floor(r.y*z),width:Math.ceil(r.width*z),height:Math.ceil(r.height*z)} })()')
    return (await win.webContents.capturePage(rect)).toDataURL()
  }
  const picker = await captureCard()
  await js('showProfileSettings()')
  await delay(250)
  const settings = await captureCard()

  await poster('omnishell-banner', 620, `
    <div class="top eyebrow"><span><i class="mark"></i>OmniShell</span><span>Windows · Open source</span></div>
    <div class="rule" style="margin-top:30px"></div>
    <pre class="ascii" style="margin-top:80px">${escape(ascii)}</pre>
    <h1 style="margin-top:56px;font-size:38px">AI coding tools in one Windows terminal.</h1>
    <div class="footer">LOCAL INSTALLS <span class="orange">/</span> SEPARATE PROFILES <span class="orange">/</span> NATIVE TERMINAL SESSIONS</div>`)
  await poster('omnishell-overview', 1160, `
    <div class="top"><div><div class="eyebrow orange">The workspace</div><h1>Start with the tool you want to use.</h1></div><span class="eyebrow">OmniShell</span></div>
    <img class="shot" style="margin-top:40px" src="${home}" alt="OmniShell home screen">
    <div class="footer">Choose a CLI, select a profile, and open a terminal session.</div>`)
  await poster('omnishell-profiles', 1080, `
    <div class="eyebrow orange">Profile controls</div><h1>Keep accounts separate.</h1>
    <p>Choose how each profile starts and what it shares.</p>
    <div class="panels">
      <div class="panel"><div class="label">SELECT A PROFILE</div><img class="detail" style="width:500px;margin-top:60px" src="${picker}" alt="Profile picker"></div>
      <div class="panel"><div class="label">LAUNCH &amp; SHARING</div><img class="detail" style="width:450px" src="${settings}" alt="Profile settings"></div>
    </div>
    <div class="footer">Example profiles shown. Sign in to each account inside its CLI.</div>`)
  console.log('README artwork exported to docs/images')
  clearTimeout(deadline)
  win.destroy()
  app.exit(0)
})().catch((error) => { console.error(error); clearTimeout(deadline); app.exit(1) })
