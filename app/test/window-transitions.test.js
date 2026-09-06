const assert = require('node:assert/strict')
const { test } = require('node:test')
const { animateWindow, clearWindowAnimation } = require('../lib/window-transitions')

function fakeWindow() {
  const events = []
  return {
    events,
    isDestroyed: () => false,
    setOpacity: (value) => events.push(['opacity', value]),
    webContents: { send: (channel, payload) => events.push([channel, payload]) }
  }
}

test('window entrance delegates motion to the renderer and avoids per-frame window updates', async () => {
  const win = fakeWindow()
  let completed = false
  animateWindow(win, 'show', () => { completed = true })
  assert.deepEqual(win.events, [
    ['window:visibility', { phase: 'show' }],
    ['opacity', 1]
  ])
  await new Promise((resolve) => setTimeout(resolve, 190))
  assert.equal(completed, true)
})

test('a new window action interrupts the previous completion callback', async () => {
  const win = fakeWindow()
  const completed = []
  animateWindow(win, 'show', () => completed.push('show'))
  animateWindow(win, 'hide', () => completed.push('hide'))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(completed, ['hide'])
  clearWindowAnimation(win)
})
