const { spawn } = require('node:child_process')
const { externalScriptPath } = require('./tooling')

class ConsoleWindowGuard {
  constructor(appRoot) { this.appRoot = appRoot; this.proc = null; this.pending = null }
  ready() {
    if (process.platform !== 'win32' || process.env.OMNISHELL_DISABLE_CONSOLE_GUARD === '1') return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = new Promise((resolve) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', externalScriptPath(this.appRoot, 'console-window-guard.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = proc
      let ready = false
      const done = () => { if (ready) return; ready = true; clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { console.error('[CONSOLE GUARD] Initialization timed out'); this.stop(); done() }, 8000)
      proc.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) done() })
      proc.stderr.on('data', (chunk) => console.error(`[CONSOLE GUARD] ${String(chunk).slice(0, 300)}`))
      proc.on('error', (error) => { console.error(`[CONSOLE GUARD] ${error.message}`); done() })
      proc.once('exit', () => { if (this.proc === proc) { this.proc = null; this.pending = null }; done() })
      proc.stdin.on('error', () => {})
      proc.unref()
    })
    return this.pending
  }
  watch(pid) { if (Number.isInteger(pid) && pid > 0 && this.proc?.stdin.writable) this.proc.stdin.write(`${pid}\n`) }
  unwatch(pid) { if (Number.isInteger(pid) && pid > 0 && this.proc?.stdin.writable) this.proc.stdin.write(`${-pid}\n`) }
  stop() { this.proc?.stdin.end(); this.pending = null }
}
module.exports = { ConsoleWindowGuard }
