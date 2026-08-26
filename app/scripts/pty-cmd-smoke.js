const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const pty = require('node-pty')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell cmd smoke '))
const launcher = path.join(root, 'tool launcher.cmd')
fs.writeFileSync(launcher, '@echo off\r\necho OMNISHELL_CMD_OK\r\n', 'utf8')

const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'call', launcher], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: root,
  env: process.env
})

let output = ''
const timer = setTimeout(() => finish(1, 'PTY command launcher timed out.'), 5000)

terminal.onData((data) => { output += data })
terminal.onExit(({ exitCode }) => {
  if (exitCode !== 0 || !output.includes('OMNISHELL_CMD_OK')) {
    finish(1, `Command launcher failed with ${exitCode}: ${output}`)
    return
  }
  finish(0, 'PTY command launcher smoke test passed.')
})

function finish(code, message) {
  clearTimeout(timer)
  const stream = code === 0 ? process.stdout : process.stderr
  stream.write(`${message}\n`)
  process.exit(code)
}
