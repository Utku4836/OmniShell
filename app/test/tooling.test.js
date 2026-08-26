const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')

const {
  TOOLS,
  createInstallEnvironment,
  createInstallPlan,
  createIsolatedEnvironment,
  executableCandidates,
  externalScriptPath,
  findTool,
  prepareToolDirectories,
  resolveLocalExecutable
} = require('../lib/tooling')

test('tool identifiers and display names are unique', () => {
  assert.equal(new Set(TOOLS.map((tool) => tool.id)).size, TOOLS.length)
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length)
  assert.equal(new Set(TOOLS.map((tool) => tool.sigil)).size, TOOLS.length)
  assert.ok(TOOLS.every((tool) => /^[A-Z]{2}$/.test(tool.sigil)))
  assert.ok(TOOLS.every((tool) => /^#[0-9a-f]{6}$/i.test(tool.accent)))
  assert.ok(TOOLS.every((tool) => typeof tool.summary === 'string' && tool.summary.length > 10))
  assert.equal(TOOLS.length, 12)
  assert.equal(findTool('kilo'), undefined)
  assert.equal(findTool('webtorrent'), undefined)
  assert.equal(findTool('torlink'), undefined)
})

test('every automatic installer produces a local install plan', () => {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-plan-'))
  for (const tool of TOOLS.filter((item) => item.installer)) {
    const plan = createInstallPlan(tool, path.join(__dirname, '..'), systemRoot)
    assert.ok(plan, `${tool.id} should have an install plan`)
    assert.equal(plan.cwd, path.join(systemRoot, tool.dir))
    assert.ok(plan.command)
    assert.ok(plan.args.length)
  }
})

test('every listed tool has a real automatic installer', () => {
  const missing = TOOLS.filter((tool) => !tool.installer).map((tool) => tool.id)
  assert.deepEqual(missing, [])
})

test('Windows npm installers use the PowerShell bridge instead of spawning npm.cmd', () => {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-npm-plan-'))
  const npmTools = TOOLS.filter((tool) => tool.installer && tool.installer.type === 'npm')

  for (const tool of npmTools) {
    const plan = createInstallPlan(tool, path.join(__dirname, '..'), systemRoot)
    if (process.platform === 'win32') {
      assert.equal(plan.command, 'powershell.exe')
      assert.ok(plan.args.some((argument) => argument.endsWith('install-npm.ps1')))
    }
    assert.ok(plan.args.includes(tool.installer.package))
  }
})

test('packaged installers resolve PowerShell scripts outside app.asar', () => {
  const appRoot = path.join('C:\\Program Files', 'OmniShell', 'resources', 'app.asar')
  assert.equal(
    externalScriptPath(appRoot, 'install-npm.ps1'),
    path.join('C:\\Program Files', 'OmniShell', 'resources', 'app.asar.unpacked', 'scripts', 'install-npm.ps1')
  )
})

test('all npm tools declare their current command-producing packages', () => {
  const packages = new Map(TOOLS.filter((tool) => tool.installer?.type === 'npm').map((tool) => [tool.id, tool.installer.package]))
  assert.equal(packages.has('kilo'), false)
  assert.equal(packages.get('crush'), '@charmland/crush')
  assert.equal(packages.get('continue'), '@continuedev/cli')
  assert.equal(packages.has('cursor-agent'), false)
  assert.equal([...packages.values()].includes('@charmbracelet/crush'), false)
  assert.equal([...packages.values()].includes('cursor-agent'), false)
  assert.equal([...packages.values()].includes('goose-ai'), false)
})

test('Cursor uses the official native Windows bootstrap instead of an unrelated npm package', () => {
  const cursor = findTool('cursor-agent')
  assert.equal(cursor.installer.type, 'cursor-release')
  assert.equal(cursor.installer.url, 'https://cursor.com/install?win32=true')
  const plan = createInstallPlan(cursor, path.join(__dirname, '..'), fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-cursor-')))
  assert.ok(plan.args.some((argument) => argument.endsWith('install-cursor.ps1')))
  assert.ok(plan.args.includes(cursor.installer.url))
})

test('isolated environments do not inherit provider secrets or global CLI profiles', () => {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-env-'))
  const tool = findTool('opencode')
  const env = createIsolatedEnvironment(tool, {
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH: 'C:\\Windows\\System32',
    HOME: 'C:\\Users\\global',
    OPENCODE_CONFIG_DIR: 'C:\\Users\\global\\.config\\opencode',
    NVIDIA_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret'
  }, systemRoot)

  assert.equal(env.HOME, path.join(systemRoot, tool.dir))
  assert.equal(env.OPENCODE_CONFIG_DIR, path.join(systemRoot, tool.dir, '.config', 'opencode'))
  assert.equal(env.GIT_CEILING_DIRECTORIES, path.join(systemRoot, tool.dir))
  assert.equal(env.NVIDIA_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.ok(env.PROCESSOR_ARCHITECTURE)
})

test('Aider installer is pinned to local uv directories', () => {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-aider-'))
  const root = path.join(systemRoot, 'Aider')
  const env = createInstallEnvironment(findTool('aider'), {}, systemRoot)
  assert.equal(env.UV_TOOL_BIN_DIR, path.join(root, 'bin'))
  assert.equal(env.UV_TOOL_DIR, path.join(root, 'uv', 'tools'))
  assert.equal(env.UV_NO_MODIFY_PATH, '1')
  assert.equal(env.AIDER_GIT, 'false')
  assert.equal(env.AIDER_GITIGNORE, 'false')
})

test('Continue CLI keeps its global state inside the isolated profile', () => {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-continue-'))
  const tool = findTool('continue')
  const root = prepareToolDirectories(tool, systemRoot)
  const env = createIsolatedEnvironment(tool, {}, systemRoot)
  assert.equal(env.CONTINUE_GLOBAL_DIR, path.join(root, '.continue'))
})

test('local executable detection never falls back to a global PATH binary', () => {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnishell-bin-'))
  const tool = findTool('codex')
  assert.equal(resolveLocalExecutable(tool, systemRoot), null)

  const candidate = executableCandidates(tool, systemRoot)[0]
  fs.mkdirSync(path.dirname(candidate), { recursive: true })
  fs.writeFileSync(candidate, '@echo off\r\n', 'utf8')
  assert.equal(resolveLocalExecutable(tool, systemRoot), candidate)
})
