const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-readme-'))
env.OMNISHELL_CAPTURE_ROOT = scratch
const child = spawn(require('electron'), ['--force-device-scale-factor=1', path.join(__dirname, 'generate-readme-assets.js')], {
  env, windowsHide: true, stdio: 'inherit'
})
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
child.on('exit', async (code) => {
  process.exitCode = code ?? 1
  await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch((error) => console.error(`Could not clean temporary capture files: ${error.message}`))
})
