class PtyRegistry {
  constructor(killProcess = null) {
    this.sessions = new Map()
    this.killProcess = killProcess || ((proc) => proc.kill())
  }

  get(senderId) {
    return this.sessions.get(senderId) || null
  }

  entries() {
    return [...this.sessions.entries()]
  }

  replace(senderId, session) {
    this.kill(senderId)
    this.sessions.set(senderId, session)
    return session
  }

  deleteIfCurrent(senderId, session) {
    if (this.sessions.get(senderId) !== session) return false
    this.sessions.delete(senderId)
    return true
  }

  kill(senderId) {
    const session = this.sessions.get(senderId)
    if (!session) return false
    this.sessions.delete(senderId)
    if (session.outputTimer) clearTimeout(session.outputTimer)
    session.outputTimer = null
    session.outputBuffer = ''
    try { this.killProcess(session.proc) } catch (error) {}
    return true
  }

  killAll() {
    for (const senderId of [...this.sessions.keys()]) this.kill(senderId)
  }
}

module.exports = { PtyRegistry }
