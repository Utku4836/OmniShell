const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
  cleanInstallLine,
  createInstallReporter,
  findLatestInstallLog,
  findLatestInstallLogs,
  parseInstallProgressLine,
  terminateProcessTree
} = require('../lib/install-runtime')

test('installer output is cleaned for the UI but preserved in a local log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-log-'))
  const reporter = createInstallReporter({ id: 'demo', name: 'Demo' }, root, new Date('2026-08-25T10:00:00.000Z'))

  assert.equal(reporter.feed('stdout', '\u001b[32mDownloading\u001b[0m\r\n'), 'Downloading')
  assert.equal(reporter.feed('stderr', 'network failed\r\n'), 'network failed')
  assert.equal(reporter.failure('fallback'), 'network failed')
  reporter.finish('failed')

  const log = fs.readFileSync(reporter.logPath, 'utf8')
  assert.match(log, /Tool: Demo/)
  assert.match(log, /network failed/)
  assert.match(log, /Result: failed/)
})

test('cleanInstallLine strips control sequences and applies a length bound', () => {
  assert.equal(cleanInstallLine('\u001b[31mERROR\u001b[0m\x00', 4), 'ERRO')
})

test('structured installer progress is parsed and hidden from the display line', () => {
  assert.deepEqual(parseInstallProgressLine('OMNISHELL_PROGRESS:42:Downloading 8 / 20 MB'), {
    percent: 42,
    line: 'Downloading 8 / 20 MB'
  })
  assert.equal(parseInstallProgressLine('ordinary npm output'), null)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-progress-'))
  const reporter = createInstallReporter({ id: 'demo', name: 'Demo' }, root)
  assert.equal(reporter.feed('stdout', 'OMNISHELL_PROGRESS:37:Extracting archive\r\n'), 'Extracting archive')
  assert.equal(reporter.progress, 37)
  reporter.feed('stdout', 'OMNISHELL_PROG')
  assert.equal(reporter.progress, 37)
  reporter.feed('stdout', 'RESS:63:Copying command\r\n')
  assert.equal(reporter.progress, 63)
  assert.equal(reporter.lastLine, 'Copying command')
  reporter.feed('stdout', 'OMNISHELL_PROGRESS:18:stale update\r\n')
  assert.equal(reporter.progress, 63)
  reporter.finish('success')
})

test('Windows process cancellation targets the exact installer process tree', () => {
  const calls = []
  const proc = { pid: 4242, kill() {} }
  const result = terminateProcessTree(proc, 'win32', (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {} }
  })

  assert.equal(result, true)
  assert.deepEqual(calls[0].args, ['/pid', '4242', '/t', '/f'])
  assert.equal(calls[0].options.windowsHide, true)
})

test('latest installer log remains discoverable after an app restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-latest-log-'))
  const older = createInstallReporter({ id: 'demo', name: 'Demo' }, root, new Date('2026-08-24T10:00:00.000Z'))
  const newer = createInstallReporter({ id: 'demo', name: 'Demo' }, root, new Date('2026-08-25T10:00:00.000Z'))
  createInstallReporter({ id: 'other', name: 'Other' }, root, new Date('2026-08-26T10:00:00.000Z'))

  assert.notEqual(older.logPath, newer.logPath)
  assert.equal(findLatestInstallLog('demo', root), newer.logPath)
  assert.equal(findLatestInstallLogs(root).get('demo'), newer.logPath)
})

test('one-pass log discovery preserves hyphenated tool identifiers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-hyphen-log-'))
  const reporter = createInstallReporter({ id: 'cursor-agent', name: 'Cursor Agent' }, root, new Date('2026-08-26T10:00:00.000Z'))
  reporter.finish('success')
  assert.equal(findLatestInstallLogs(root).get('cursor-agent'), reporter.logPath)
})
