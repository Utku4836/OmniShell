const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

test('a real interactive PTY receives input and uses the isolated profile', { timeout: 15000 }, () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pty-smoke.js')], {
    encoding: 'utf8',
    timeout: 12000,
    windowsHide: true
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PTY isolation smoke test passed/)
})

test('a cmd tool launches when its isolated path contains spaces', { timeout: 10000 }, () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pty-cmd-smoke.js')], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true
  })

  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PTY command launcher smoke test passed/)
})
