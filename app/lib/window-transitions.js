const animations = new WeakMap()
function animateWindow(win, phase, done = () => {}) {
  if (!win || win.isDestroyed()) return
  const existing = animations.get(win)
  if (existing?.phase === phase) return
  if (existing) clearTimeout(existing.timer)
  const duration = phase === 'show' ? 170 : 130
  win.webContents.send('window:visibility', { phase })
  if (phase === 'show') win.setOpacity(1)
  const timer = setTimeout(() => {
    animations.delete(win)
    if (!win.isDestroyed()) done()
  }, duration)
  timer.unref?.()
  animations.set(win, { timer, phase })
}
function clearWindowAnimation(win) {
  const animation = animations.get(win)
  if (animation) clearTimeout(animation.timer)
  animations.delete(win)
}
module.exports = { animateWindow, clearWindowAnimation }
