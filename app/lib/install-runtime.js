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

function createInstallReporter(tool, systemRoot, now = new Date()) {
  const logDirectory = path.join(systemRoot, '_install', 'logs')
  fs.mkdirSync(logDirectory, { recursive: true })
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(logDirectory, `${tool.id}-${timestamp}.log`)
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
      return cleanInstallLine(reporter.stderrTail.at(-1) || fallback || reporter.lastLine || 'Installation failed.', 300)
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

function findLatestInstallLogs(systemRoot) {
  const logDirectory = path.join(systemRoot, '_install', 'logs')
  const latest = new Map()
  if (!fs.existsSync(logDirectory)) return latest
  for (const entry of fs.readdirSync(logDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    const match = /^(.+)-(\d{4}-\d{2}-\d{2}T.+)\.log$/.exec(entry.name)
    if (!match) continue
    const toolId = match[1]
    const current = latest.get(toolId)
    if (!current || entry.name.localeCompare(path.basename(current)) > 0) {
      latest.set(toolId, path.join(logDirectory, entry.name))
    }
  }
  return latest
}

function findLatestInstallLog(toolId, systemRoot) {
  return findLatestInstallLogs(systemRoot).get(toolId) || null
}

function terminateProcessTree(proc, platform = process.platform, spawnProcess = spawn) {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) return false
  try {
    if (platform === 'win32') {
      const killer = spawnProcess('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
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

module.exports = {
  PROGRESS_PREFIX,
  cleanInstallLine,
  createInstallReporter,
  findLatestInstallLog,
  findLatestInstallLogs,
  parseInstallProgressLine,
  terminateProcessTree
}
