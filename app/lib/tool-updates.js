const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { profileRuntimeDir, resolveLocalExecutable, createIsolatedEnvironment } = require('./tooling')
const { terminateProcessTree } = require('./install-runtime')

const CHECK_INTERVAL = 4 * 60 * 60 * 1000
const AGY_MANIFEST = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json'

function newerVersion(latest, installed) {
  if (!latest || !installed || latest === installed) return false
  const parse = (value) => String(value).replace(/^v/, '').split('+')[0].match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
  const left = parse(latest), right = parse(installed)
  if (!left || !right) return latest !== installed
  for (let i = 1; i <= 3; i += 1) {
    if (+left[i] !== +right[i]) return +left[i] > +right[i]
  }
  if (!left[4] && right[4]) return true
  if (left[4] && !right[4]) return false
  // Date-based Cursor releases include a commit hash, not a semver prerelease.
  if (+left[1] > 2000) return left[4] !== right[4]
  const a = left[4].replace(/^-/, '').split('.'), b = right[4].replace(/^-/, '').split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue
    if (a[i] === undefined) return false
    if (b[i] === undefined) return true
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i])
    if (an && bn) return +a[i] > +b[i]
    if (an !== bn) return !an
    return a[i] > b[i]
  }
  return false
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const partial = `${file}.${randomUUID()}.partial`
  try {
    await fs.writeFile(partial, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(partial, file)
  } finally { await fs.rm(partial, { force: true }).catch(() => {}) }
}

async function installedVersion(tool, systemRoot, profileId = 'default', options = {}) {
  const root = profileRuntimeDir(tool, profileId, systemRoot)
  if (tool.installer?.type === 'npm') {
    try {
      return JSON.parse(await fs.readFile(path.join(root, 'node_modules', tool.installer.package, 'package.json'), 'utf8')).version || null
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const executable = resolveLocalExecutable(tool, systemRoot, profileId)
  if (!executable) return null
  const stat = await fs.stat(executable)
  if (!options.fresh) {
    try {
      const stamp = JSON.parse(await fs.readFile(path.join(root, '.omnishell-install.json'), 'utf8'))
      if (stamp.mtimeMs === stat.mtimeMs && stamp.version) return stamp.version
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  const version = await new Promise((resolve, reject) => {
    let output = '', settled = false
    const wrapped = /\.(?:cmd|bat)$/i.test(executable)
    const proc = spawn(wrapped ? (process.env.ComSpec || 'cmd.exe') : executable,
      wrapped ? ['/d', '/s', '/c', 'call', executable, '--version'] : ['--version'],
      { cwd: root, env: createIsolatedEnvironment(tool, process.env, systemRoot, profileId), windowsHide: true })
    options.watch?.(proc.pid)
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.unwatch?.(proc.pid)
      if (error) reject(error); else resolve(result)
    }
    const timer = setTimeout(() => { terminateProcessTree(proc); finish(new Error(`${tool.name} version check timed out`)) }, 15000)
    const collect = (chunk) => { output = (output + chunk).slice(-16384) }
    proc.stdout.on('data', collect)
    proc.stderr.on('data', collect)
    proc.once('error', (error) => finish(error))
    proc.once('close', (code) => {
      const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      const match = clean.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?/)
      finish(code === 0 && match ? null : new Error(`${tool.name} did not report its installed version`), match?.[0])
    })
  })
  await writeJson(path.join(root, '.omnishell-install.json'), { version, mtimeMs: stat.mtimeMs })
  return version
}

class ReleaseResolver {
  constructor(fetcher = globalThis.fetch) { this.fetcher = fetcher; this.cache = new Map(); this.controller = new AbortController() }
  cancel() { this.controller.abort() }
  async request(url, json = true) {
    const response = await this.fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(20000), this.controller.signal]), headers: { 'User-Agent': 'OmniShell', 'Accept': json ? 'application/json' : 'text/plain' } })
    if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 4 * 1024 * 1024) throw new Error('Release metadata is too large')
    return json ? JSON.parse(text) : text
  }
  async resolve(tool, force = false) {
    const cached = this.cache.get(tool.id)
    if (!force && cached && cached.until > Date.now()) return cached.promise
    const promise = this.lookup(tool)
    this.cache.set(tool.id, { promise, until: Date.now() + 15 * 60 * 1000 })
    promise.catch(() => { if (this.cache.get(tool.id)?.promise === promise) this.cache.delete(tool.id) })
    return promise
  }
  async lookup(tool) {
    const installer = tool.installer
    let version
    if (installer.type === 'npm') {
      version = (await this.request(`https://registry.npmjs.org/${encodeURIComponent(installer.package)}/latest`)).version
    } else if (tool.id === 'agy') {
      version = (await this.request(installer.manifest || AGY_MANIFEST)).version
    } else if (tool.id === 'aider') {
      version = (await this.request('https://pypi.org/pypi/aider-chat/json')).info?.version
    } else if (installer.type === 'github-release') {
      version = (await this.request(`https://api.github.com/repos/${installer.repo}/releases/latest`)).tag_name?.replace(/^v/, '')
    } else if (installer.type === 'cursor-release') {
      const bootstrap = await this.request(installer.url, false)
      version = /\$version\s*=\s*['"]([^'"]+)['"]/.exec(bootstrap)?.[1]
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/.test(version)) {
      throw new Error(`Could not resolve the current ${tool.name} release`)
    }
    return { version }
  }
}

class AutoUpdater {
  constructor({ tools, systemRoot, listProfiles, isBusy, install, resolver, now = Date.now, readVersion = installedVersion, isInstalled = resolveLocalExecutable }) {
    Object.assign(this, { tools, systemRoot, listProfiles, isBusy, install, resolver, now, readVersion, isInstalled })
    this.state = {}; this.running = false; this.stopped = false; this.timer = null
    this.file = path.join(systemRoot, '_updates', 'checks.json')
  }
  async start() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.state = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch (error) { this.state = {} }
    this.timer = setTimeout(() => this.tick().catch((error) => console.error(`[AUTO UPDATE] ${error.message}`)), 20000)
    this.timer.unref?.()
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
  async tick() {
    if (this.running || this.stopped) return
    clearTimeout(this.timer)
    this.running = true
    try {
      for (const tool of this.tools) {
        if (this.stopped) break
        const profiles = await this.listProfiles(tool.id)
        for (const profile of profiles) {
          if (this.stopped) break
          if (!this.isInstalled(tool, this.systemRoot, profile.id) || this.isBusy(tool.id, profile.id)) continue
          const key = `${tool.id}:${profile.id}`
          const previous = this.state[key]
          if (previous && this.now() - previous.checkedAt < (previous.error ? 15 * 60 * 1000 : CHECK_INTERVAL)) continue
          try {
            const current = await this.readVersion(tool, this.systemRoot, profile.id)
            const release = await this.resolver.resolve(tool)
            if (this.stopped || this.isBusy(tool.id, profile.id)) continue
            if (current && newerVersion(release.version, current)) {
              const result = await this.install(tool.id, profile.id, release)
              if (!result?.ok) {
                if (result?.busy) continue
                throw new Error(result?.error || 'Automatic update did not complete')
              }
            }
            this.state[key] = { checkedAt: this.now(), version: release.version }
          } catch (error) {
            this.state[key] = { checkedAt: this.now(), error: String(error.message || error) }
          }
          await writeJson(this.file, this.state)
        }
      }
    } finally {
      this.running = false
      if (!this.stopped) { this.timer = setTimeout(() => this.tick().catch((error) => console.error(`[AUTO UPDATE] ${error.message}`)), 60000); this.timer.unref?.() }
    }
  }
}

module.exports = { AutoUpdater, ReleaseResolver, installedVersion, newerVersion, AGY_MANIFEST }
