const animations = new WeakMap()
function animateWindow(win, phase, done = () => {}) {
  if (!win || win.isDestroyed()) return
  const existing = animations.get(win)
  if (existing?.phase === phase) return
  if (existing) clearInterval(existing.timer)
  const duration = phase === 'show' ? 170 : 130
  const start = Date.now()
  const initial = phase === 'show' ? 0 : win.getOpacity()
  const target = phase === 'show' ? 1 : 0
  win.setOpacity(initial)
  win.webContents.send('window:visibility', { phase })
  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); animations.delete(win); return }
    const progress = Math.min(1, (Date.now() - start) / duration)
    const eased = 1 - (1 - progress) ** 3
    win.setOpacity(initial + (target - initial) * eased)
    if (progress === 1) { clearInterval(timer); animations.delete(win); done() }
  }, 16)
  animations.set(win, { timer, phase })
}
function clearWindowAnimation(win) {
  const animation = animations.get(win)
  if (animation) clearInterval(animation.timer)
  animations.delete(win)
}
module.exports = { animateWindow, clearWindowAnimation }
