const assert = require('node:assert/strict')
const test = require('node:test')

const { collectTerminalResponses } = require('../lib/terminal-queries')

test('terminal dimension queries receive current cell and pixel sizes', () => {
  const result = collectTerminalResponses('', '\u001b[14t\u001b[16t\u001b[18t', 120, 40, 1188, 680)
  assert.deepEqual(result.responses, ['\u001b[4;680;1188t', '\u001b[6;17;10t', '\u001b[8;40;120t'])
})

test('OpenTUI palette query receives OmniShell absolute black', () => {
  const result = collectTerminalResponses('', '\u001b]4;0;?\u0007', 120, 40)
  assert.deepEqual(result.responses, ['\u001b]4;0;rgb:0000/0000/0000\u0007'])
})

test('split OSC color queries are buffered until complete', () => {
  const first = collectTerminalResponses('', '\u001b]11;', 120, 40)
  assert.deepEqual(first.responses, [])
  assert.equal(first.buffer, '\u001b]11;')

  const second = collectTerminalResponses(first.buffer, '?\u0007', 120, 40)
  assert.deepEqual(second.responses, ['\u001b]11;rgb:0000/0000/0000\u0007'])
  assert.equal(second.buffer, '')
})
