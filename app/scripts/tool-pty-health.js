const pty = require('node-pty')
const {
  TOOLS,
  createIsolatedEnvironment,
  resolveLocalExecutable,
  toolDir
} = require('../lib/tooling')
const { terminateProcessTree } = require('../lib/install-runtime')

function clean(value) {
  return String(value || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function checkTool(tool) {
  return new Promise((resolve) => {
    const executable = resolveLocalExecutable(tool)
    if (!executable) {
      resolve({ tool, ok: false, output: 'local executable missing' })
      return
    }

    const isCommandWrapper = /\.(?:cmd|bat)$/i.test(executable)
    const command = isCommandWrapper ? (process.env.ComSpec || 'cmd.exe') : executable
    const args = isCommandWrapper
      ? ['/d', '/s', '/c', 'call', executable, '--version']
      : ['--version']
    let output = ''
    let settled = false
    const processHandle = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: toolDir(tool),
      env: createIsolatedEnvironment(tool)
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminateProcessTree(processHandle)
      resolve({ tool, ok: false, output: 'timed out after 30 seconds' })
    }, 30000)

    processHandle.onData((data) => {
      output = (output + data).slice(-8192)
    })
    processHandle.onExit(({ exitCode }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        tool,
        ok: exitCode === 0,
        output: clean(output).slice(0, 220) || `exit ${exitCode}`
      })
    })
  })
}

;(async () => {
  let failed = 0
  for (const tool of TOOLS) {
    const result = await checkTool(tool)
    if (!result.ok) failed += 1
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}\t${tool.name}\t${result.output}\n`)
  }
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
