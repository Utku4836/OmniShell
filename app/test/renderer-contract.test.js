const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const appRoot = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(appRoot, 'renderer', 'index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(appRoot, 'renderer', 'renderer.js'), 'utf8')
const preload = fs.readFileSync(path.join(appRoot, 'preload.js'), 'utf8')
const main = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8')

test('every renderer element lookup exists in the HTML shell', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]))
  const lookups = new Set([...renderer.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]))
  const missing = [...lookups].filter((id) => !ids.has(id))
  assert.deepEqual(missing, [])
})

test('every renderer API call is exposed by the sandboxed preload', () => {
  const exposed = new Set([...preload.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]+):/gm)].map((match) => match[1]))
  const calls = new Set([...renderer.matchAll(/window\.api\.([A-Za-z][A-Za-z0-9]+)/g)].map((match) => match[1]))
  const missing = [...calls].filter((name) => !exposed.has(name))
  assert.deepEqual(missing, [])
})

test('new windows wait for styling and context menus do not use the broken visibility probe', () => {
  assert.match(main, /show:\s*false/)
  assert.match(main, /setFullScreen\(true\)/)
  assert.doesNotMatch(renderer, /ctxMenu\.style\.visibility/)
  assert.match(renderer, /setTimeout\([^]*420\)/)
})

test('OmniShell shell stays minimal without decorative microcopy or titlebar buttons', () => {
  assert.match(html, /<pre id="brand-title" class="brand-title" aria-label="OmniShell">[^]*██████╗/)
  assert.match(renderer, /function fitBrandTitle\(\)/)
  assert.doesNotMatch(html, /matrix-field|brand-kicker|brand-meta|cyber-divider/)
  assert.doesNotMatch(html, /id="win-(?:minimize|maximize|close)"/)
  assert.match(renderer, /background:\s*'#000000'/)
  assert.match(renderer, /'#'\.repeat\(filled\)/)
})

test('completed installs wait for an explicit second launch and exited CLIs can restart', () => {
  assert.doesNotMatch(renderer, /pendingLaunchToolId/)
  assert.match(renderer, /value\.state === 'confirm'[^]*Click again to install/)
  assert.match(renderer, /terminalExited[^]*Press Enter to restart/)
})

test('context menu can open the selected CLI in a new window', () => {
  assert.match(html, /id="ctx-new-current"/)
  assert.match(renderer, /window\.api\.openToolWindow\(tool\.id\)/)
})

test('terminal IPC includes real pixel dimensions', () => {
  assert.match(preload, /terminalStart: \(id, cols, rows, pixelWidth, pixelHeight\)/)
  assert.match(preload, /ptyResize: \(cols, rows, pixelWidth, pixelHeight\)/)
  assert.match(main, /session\.pixelWidth/)
  assert.match(main, /session\.pixelHeight/)
})
