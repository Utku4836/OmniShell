const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const appRoot = path.join(__dirname, '..')
const scriptsDirectory = path.join(appRoot, 'scripts')

test('every PowerShell installer parses on Windows PowerShell', { skip: process.platform !== 'win32' }, () => {
  const scripts = fs.readdirSync(scriptsDirectory)
    .filter((name) => name.endsWith('.ps1'))
    .map((name) => path.join(scriptsDirectory, name))

  for (const script of scripts) {
    const escaped = script.replace(/'/g, "''")
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `[void][scriptblock]::Create((Get-Content -Raw -LiteralPath '${escaped}'))`
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, `${path.basename(script)}\n${result.stderr}`)
  }
})

test('PowerShell progress helper emits the structured protocol', { skip: process.platform !== 'win32' }, () => {
  const helper = path.join(scriptsDirectory, 'install-common.ps1').replace(/'/g, "''")
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `. '${helper}'; Write-OmniProgress -Percent 42 -Message 'Downloading payload'`
  ], { encoding: 'utf8', windowsHide: true })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'OMNISHELL_PROGRESS:42:Downloading payload')
})
