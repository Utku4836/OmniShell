const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PROGRESS_PREFIX = 'OMNISHELL_PROGRESS:'

function cleanInstallLine(value, maxLength = 500) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, maxLength)
}

function parseInstallProgressLine(value) {
  const line = cleanInstallLine(value)
  if (!line.startsWith(PROGRESS_PREFIX)) return null
  const match = /^OMNISHELL_PROGRESS:(\d{1,3}):(.*)$/.exec(line)
  if (!match) return null
  return {
    percent: Math.max(0, Math.min(100, Number(match[1]))),
    line: cleanInstallLine(match[2]) || 'Working...'
  }
}

function createInstallReporter(tool, profileRoot, now = new Date()) {
  const logDirectory = path.join(profileRoot, 'logs')
  fs.mkdirSync(logDirectory, { recursive: true })
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logDirectory, `install-${timestamp}.log`)
  fs.writeFileSync(logPath, `OmniShell installer log\nTool: ${tool.name} (${tool.id})\nStarted: ${now.toISOString()}\n\n`, 'utf8')

  let pendingLog = ''
  let flushTimer = null
  const streamBuffers = new Map()
  const flush = () => {
    if (!pendingLog) return
    const value = pendingLog
    pendingLog = ''
    try { fs.appendFileSync(logPath, value, 'utf8') } catch (error) {}
  }
  const safeAppend = (value) => {
    pendingLog += value
    if (pendingLog.length >= 64 * 1024) {
      clearTimeout(flushTimer)
      flushTimer = null
      flush()
      return
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
      }, 120)
      flushTimer.unref?.()
    }
  }

  const reporter = {
    logPath,
    lastLine: '',
    progress: 0,
    stderrTail: [],
    feed(streamName, chunk) {
      const raw = String(chunk || '')
      safeAppend(`[${streamName}] ${raw}`)
      const combined = `${streamBuffers.get(streamName) || ''}${raw}`
      const lines = combined.split(/\r\n|\n|\r/)
      const terminated = /(?:\r\n|\n|\r)$/.test(combined)
      const remainder = terminated ? '' : (lines.pop() || '')
      streamBuffers.set(streamName, remainder.slice(-2048))
      const displayLines = []
      for (const rawLine of lines) {
        const line = cleanInstallLine(rawLine)
        if (!line) continue
        const progress = parseInstallProgressLine(line)
        if (progress) {
          reporter.progress = Math.max(reporter.progress, progress.percent)
          reporter.lastLine = progress.line
          continue
        }
        reporter.lastLine = line
        displayLines.push(line)
      }
      const partial = cleanInstallLine(remainder)
      if (partial && !PROGRESS_PREFIX.startsWith(partial) && !partial.startsWith(PROGRESS_PREFIX)) {
        reporter.lastLine = partial
      }
      if (streamName === 'stderr') reporter.stderrTail.push(...displayLines)
      reporter.stderrTail = reporter.stderrTail.slice(-5)
      return reporter.lastLine
    },
    failure(fallback) {
      const meaningfulStderr = [...reporter.stderrTail].reverse().find((line) => {
        return line && !line.startsWith('+') && !line.startsWith('At ') && !line.startsWith('char:')
      })
      return cleanInstallLine(meaningfulStderr || reporter.stderrTail.at(-1) || fallback || reporter.lastLine || 'Installation failed.', 300)
    },
    finish(result) {
      for (const [streamName, remainder] of streamBuffers) {
        const line = cleanInstallLine(remainder)
        if (!line) continue
        const progress = parseInstallProgressLine(line)
        if (progress) {
          reporter.progress = Math.max(reporter.progress, progress.percent)
          reporter.lastLine = progress.line
        } else {
          reporter.lastLine = line
          if (streamName === 'stderr') reporter.stderrTail.push(line)
        }
      }
      streamBuffers.clear()
      clearTimeout(flushTimer)
      flushTimer = null
      pendingLog += `\n\nFinished: ${new Date().toISOString()}\nResult: ${result}\n`
      flush()
    }
  }

  return reporter
}

function findLatestInstallLog(profileRoot) {
  const logDirectory = path.join(profileRoot, 'logs')
  if (!fs.existsSync(logDirectory)) return null
  const files = fs.readdirSync(logDirectory).filter((name) => name.startsWith('install-') && name.endsWith('.log')).sort()
  return files.length ? path.join(logDirectory, files.at(-1)) : null
}

function terminateProcessTree(proc, platform = process.platform, spawnProcess = spawn) {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) return false
  try {
    if (platform === 'win32') {
      const killer = spawnProcess('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      const fallback = () => { try { proc.kill() } catch (error) {} }
      killer?.once('error', fallback)
      killer?.once('exit', (code) => { if (code !== 0) fallback() })
      if (killer && typeof killer.unref === 'function') killer.unref()
    } else {
      proc.kill('SIGTERM')
    }
    return true
  } catch (error) {
    try { proc.kill() } catch (killError) {}
    return false
  }
}

function stopPtyGracefully(proc, exited, graceMs = 1500) {
  if (!exited) return terminateProcessTree(proc)
  let finished = false
  const interrupt = () => { if (!finished) { try { proc.write('\x03') } catch (error) {} } }
  interrupt()
  const second = setTimeout(interrupt, 250)
  const force = setTimeout(() => { if (!finished) terminateProcessTree(proc) }, graceMs)
  second.unref?.()
  force.unref?.()
  exited.then(() => { finished = true; clearTimeout(second); clearTimeout(force) })
  return true
}

module.exports = {
  PROGRESS_PREFIX,
  cleanInstallLine,
  createInstallReporter,
  findLatestInstallLog,
  parseInstallProgressLine,
  terminateProcessTree,
  stopPtyGracefully
}
