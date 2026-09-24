const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { AutoUpdater, ReleaseResolver, installedVersion, newerVersion } = require('../lib/tool-updates')
const { DEFAULT_PROFILE, findTool, createInstallPlan, createIsolatedEnvironment, profileRuntimeDir } = require('../lib/tooling')
const { prepareProfileLaunch, finalizeProfileLaunch } = require('../lib/profile-launch')

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omnishell-update-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('installation plans explicitly select the resolved version instead of retaining an old pin', async (t) => {
  const root = await temp(t), tool = findTool('codex')
  const plan = createInstallPlan(tool, path.resolve(__dirname, '..'), root, DEFAULT_PROFILE, '1.2.3')
  if (process.platform === 'win32') assert.equal(plan.args[plan.args.indexOf('-PackageVersion') + 1], '1.2.3')
  else assert.ok(plan.args.includes('@openai/codex@1.2.3'))
  const script = await fs.readFile(path.join(__dirname, '../scripts/install-npm.ps1'), 'utf8')
  assert.match(script, /PackageName, \$PackageVersion/)
})

test('CLI self-updates and normal installs target the shared tool root', async (t) => {
  const root = await temp(t), tool = findTool('codex'), profile = { id: `p_${'1'.repeat(32)}`, name: 'Work' }
  const env = createIsolatedEnvironment(tool, { PATH: '/system-bin', npm_config_prefix: 'global-prefix' }, root, profile)
  assert.equal(env.npm_config_prefix, profileRuntimeDir(tool, profile, root))
  assert.notEqual(env.HOME, env.npm_config_prefix)
})

test('release lookups share one request between profiles', async () => {
  let requests = 0
  const resolver = new ReleaseResolver(async (url) => {
    requests += 1
    assert.match(url, /registry\.npmjs\.org\/.*codex\/latest/)
    return { ok: true, text: async () => '{"version":"1.2.3"}' }
  })
  const [left, right] = await Promise.all([resolver.resolve(findTool('codex')), resolver.resolve(findTool('codex'))])
  assert.equal(requests, 1)
  assert.equal(left.version, right.version)
})

test('a failed release lookup can recover without retaining a rejected cache entry', async () => {
  let requests = 0
  const resolver = new ReleaseResolver(async () => ++requests === 1
    ? { ok: false, status: 503 }
    : { ok: true, text: async () => '{"version":"2.0.0"}' })
  await assert.rejects(resolver.resolve(findTool('codex')), /503/)
  assert.equal((await resolver.resolve(findTool('codex'))).version, '2.0.0')
})

test('automatic updates defer active profiles, skip missing tools, and reuse the check interval', async (t) => {
  const root = await temp(t), tool = findTool('codex')
  let busy = true, now = 1000000
  const installed = []
  const updater = new AutoUpdater({
    tools: [tool], systemRoot: root, listProfiles: async () => [{id:'default'},{id:'missing'}],
    isBusy: () => busy, isInstalled: (_tool, _root, profile) => profile.id === 'default',
    readVersion: async () => '1.0.0', resolver: { resolve: async () => ({version:'2.0.0'}) },
    install: async (_tool, id) => { installed.push(id); return {ok:true} }, now: () => now
  })
  t.after(() => updater.stop())
  await updater.tick()
  assert.deepEqual(installed, [])
  busy = false
  await updater.tick()
  assert.deepEqual(installed, ['default'])
  await updater.tick()
  assert.deepEqual(installed, ['default'])
  now += 4 * 60 * 60 * 1000
  await updater.tick()
  assert.deepEqual(installed, ['default','default'])
})

test('automatic updates check a shared CLI only once with several profiles', async (t) => {
  const root = await temp(t), tool = findTool('codex')
  let checks = 0, installs = 0
  const updater = new AutoUpdater({
    tools: [tool], systemRoot: root,
    listProfiles: async () => [{ id: 'default' }, { id: `p_${'a'.repeat(32)}`, name: 'Work' }],
    isBusy: () => false, isInstalled: () => true,
    readVersion: async () => { checks += 1; return '1.0.0' },
    resolver: { resolve: async () => ({ version: '2.0.0' }) },
    install: async () => { installs += 1; return { ok: true } }
  })
  t.after(() => updater.stop())
  await updater.tick()
  assert.equal(checks, 1)
  assert.equal(installs, 1)
  assert.deepEqual(Object.keys(updater.state), ['codex'])
})

test('an update discovered while a profile becomes busy is deferred', async (t) => {
  const root = await temp(t)
  let busy = false, installs = 0
  const updater = new AutoUpdater({
    tools: [findTool('codex')], systemRoot: root, listProfiles: async () => [{id:'default'}],
    isBusy: () => busy, isInstalled: () => true, readVersion: async () => '1.0.0',
    resolver: { resolve: async () => { busy = true; return {version:'2.0.0'} } },
    install: async () => { installs += 1; return {ok:true} }
  })
  t.after(() => updater.stop())
  await updater.tick()
  assert.equal(installs,0)
  assert.deepEqual(updater.state,{})
})

test('update comparison does not downgrade stable or newer installations', () => {
  assert.equal(newerVersion('1.2.0','1.3.0'),false)
  assert.equal(newerVersion('1.2.0-beta','1.2.0'),false)
  assert.equal(newerVersion('1.2.0','1.2.0-beta'),true)
  assert.equal(newerVersion('1.10.0','1.9.9'),true)
})

test('the installed package version is shared by every profile', async (t) => {
  const root = await temp(t), tool = findTool('codex')
  const file = path.join(profileRuntimeDir(tool,DEFAULT_PROFILE,root),'node_modules/@openai/codex/package.json')
  await fs.mkdir(path.dirname(file),{recursive:true})
  await fs.writeFile(file,'{"version":"1.2.3"}')
  assert.equal(await installedVersion(tool,root),'1.2.3')
  assert.equal(await installedVersion(tool,root,{ id: `p_${'2'.repeat(32)}`, name: 'Other' }),'1.2.3')
})

test('Claude resumes the persisted effort without replacing other configuration', async (t) => {
  const root = await temp(t), file = path.join(root,'.claude/settings.json')
  await fs.mkdir(path.dirname(file),{recursive:true})
  await fs.writeFile(file,'{"effortLevel":"high","theme":"dark"}')
  const result = await prepareProfileLaunch(findTool('claude'),{settings:{fullPermission:true}},root,{})
  assert.ok(result.args.includes('--dangerously-skip-permissions'))
  assert.deepEqual(result.args.slice(-2),['--effort','high'])
  assert.equal(await fs.readFile(file,'utf8'),'{"effortLevel":"high","theme":"dark"}')
})

test('Amp keeps preference changes from a full-permission session without persisting the injected permission', async (t) => {
  const root = await temp(t), config = path.join(root,'.config/amp/settings.json')
  await fs.mkdir(path.dirname(config),{recursive:true})
  await fs.writeFile(config,'{"theme":"dark"}')
  const launch = await prepareProfileLaunch(findTool('amp'),{settings:{fullPermission:true}},root,{})
  await fs.writeFile(launch.env.AMP_SETTINGS_FILE,'{"theme":"light","amp.dangerouslyAllowAll":true}')
  await finalizeProfileLaunch(findTool('amp'),root)
  assert.deepEqual(JSON.parse(await fs.readFile(config,'utf8')),{theme:'light'})
})
