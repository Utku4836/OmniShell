const assert = require('node:assert/strict')
const test = require('node:test')

const { PtyRegistry } = require('../lib/pty-registry')

function fakeSession(id) {
  return {
    id,
    proc: {
      killed: false,
      kill() { this.killed = true }
    }
  }
}

test('a stale PTY exit cannot remove its replacement session', () => {
  const registry = new PtyRegistry()
  const oldSession = fakeSession('old')
  const newSession = fakeSession('new')

  registry.replace(7, oldSession)
  registry.replace(7, newSession)

  assert.equal(oldSession.proc.killed, true)
  assert.equal(registry.deleteIfCurrent(7, oldSession), false)
  assert.equal(registry.get(7), newSession)
  assert.equal(registry.deleteIfCurrent(7, newSession), true)
  assert.equal(registry.get(7), null)
})
