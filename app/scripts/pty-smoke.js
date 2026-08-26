const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const pty = require('node-pty')

const { createIsolatedEnvironment, findTool, toolDir } = require('../lib/tooling')

const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-pty-'))
const tool = findTool('opencode')
const expectedHome = toolDir(tool, systemRoot)
const env = createIsolatedEnvironment(tool, {
  ...process.env,
  OPENAI_API_KEY: 'must-not-leak',
  OPENCODE_CONFIG_DIR: 'C:\\global-opencode'
}, systemRoot)

const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: expectedHome,
  env
})

let collected = ''
let commandsSent = false
const timer = setTimeout(() => finish(new Error(`PTY timed out. Output: ${collected}`)), 7000)

terminal.onData((data) => {
  collected += data
  if (commandsSent) return
  commandsSent = true
  setTimeout(() => {
    terminal.write('echo OMNISHELL_HOME=%HOME%\r')
    terminal.write('echo OMNISHELL_CONFIG=%OPENCODE_CONFIG_DIR%\r')
    terminal.write('if defined OPENAI_API_KEY (echo OMNISHELL_SECRET=[%OPENAI_API_KEY%]) else (echo OMNISHELL_SECRET=[])\r')
    terminal.write('echo OMNISHELL_DONE\r')
    setTimeout(() => terminal.write('exit\r'), 800)
  }, 100)
})

terminal.onExit(() => finish())

function finish(error) {
  clearTimeout(timer)
  const output = collected.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  const escapedHome = expectedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const failures = []

  if (error) failures.push(error.message)
  if (!new RegExp(`OMNISHELL_HOME=${escapedHome}`, 'i').test(output)) failures.push('isolated HOME was not observed')
  if (!/OMNISHELL_SECRET=\[\]/i.test(output)) failures.push('provider secret was inherited')
  if (/must-not-leak/i.test(output)) failures.push('provider secret value leaked')
  if (/C:\\global-opencode/i.test(output)) failures.push('global OpenCode profile leaked')

  if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n${output}\n`)
    process.exit(1)
  }

  process.stdout.write('PTY isolation smoke test passed.\n')
  process.exit(0)
}
