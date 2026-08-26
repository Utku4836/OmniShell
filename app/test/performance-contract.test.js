const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const appRoot = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8')
const tooling = fs.readFileSync(path.join(appRoot, 'lib', 'tooling.js'), 'utf8')
const installRuntime = fs.readFileSync(path.join(appRoot, 'lib', 'install-runtime.js'), 'utf8')
const renderer = fs.readFileSync(path.join(appRoot, 'renderer', 'renderer.js'), 'utf8')
const styles = fs.readFileSync(path.join(appRoot, 'renderer', 'styles.css'), 'utf8')

test('runtime performance invariants stay enabled', () => {
  const invariants = [
    ['constant-time tool lookup', tooling, /const TOOL_BY_ID = new Map/],
    ['lazy per-tool directory creation', tooling, /function prepareAllTools[^]*_install[^]*\n}/],
    ['one-pass installer log cache', main, /findLatestInstallLogs\(SYSTEM_ROOT\)/],
    ['64 KiB buffered installer logs', installRuntime, /pendingLog\.length >= 64 \* 1024/],
    ['coalesced installer IPC', main, /setTimeout\(\(\) => flushInstallProgress\(job\), 24\)/],
    ['coalesced PTY IPC', main, /session\.outputBuffer\.length >= 64 \* 1024[^]*setTimeout\(\(\) => flushPtyOutput/],
    ['keyed incremental row rendering', renderer, /const dirtyRows = new Set\(\)[^]*function flushRows/],
    ['animation-frame DOM batching', renderer, /requestAnimationFrame\(flushRows\)/],
    ['animation-frame progress batching', renderer, /requestAnimationFrame\(flushProgressEvents\)/],
    ['delegated grid interactions', renderer, /listScroll\.addEventListener\('click'/],
    ['single-frame terminal fitting', renderer, /fitFrame = requestAnimationFrame\(fitTerminal\)/],
    ['GPU terminal renderer with safe fallback', renderer, /WebglAddon[^]*onContextLoss/],
    ['renderer layout containment', styles, /contain: layout paint/]
  ]

  for (const [name, source, pattern] of invariants) {
    assert.match(source, pattern, name)
  }
})

test('xterm remains lazily initialized and resize-observed', () => {
  assert.match(renderer, /function initTerminal\(\)[^]*if \(terminal\) return/)
  assert.match(renderer, /new ResizeObserver\(scheduleFit\)/)
})
