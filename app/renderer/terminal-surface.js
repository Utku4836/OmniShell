;(function (scope) {
  const paletteKeys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
  function paletteColor(index, theme) {
    if (index < 16) return theme[paletteKeys[index]] || theme.background || '#000000'
    if (index >= 232) { const shade = 8 + (index - 232) * 10; return `rgb(${shade},${shade},${shade})` }
    const levels = [0, 95, 135, 175, 215, 255], value = index - 16
    return `rgb(${levels[Math.floor(value / 36)]},${levels[Math.floor(value / 6) % 6]},${levels[value % 6]})`
  }
  function cellBackground(cell, theme) {
    if (!cell) return theme.background || '#000000'
    const prefix = cell.isInverse?.() ? 'Fg' : 'Bg'
    const color = cell[`get${prefix}Color`]()
    if (cell[`is${prefix}RGB`]()) return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
    if (cell[`is${prefix}Palette`]()) return paletteColor(color, theme)
    return (prefix === 'Fg' ? theme.foreground : theme.background) || '#000000'
  }
  class TerminalEdges {
    constructor(terminal, canvas, host) {
      Object.assign(this, { terminal, canvas, host })
      this.signature = ''
      this.canvases = { bottom: canvas }
      for (const side of ['top', 'left', 'right']) {
        const edge = canvas.ownerDocument.createElement('canvas')
        edge.className = 'terminal-edge'
        edge.setAttribute('aria-hidden', 'true')
        host.appendChild(edge)
        this.canvases[side] = edge
      }
    }
    paint() {
      const { terminal, canvas, host } = this
      const screen = terminal.element?.querySelector('.xterm-screen')
      if (!screen || !host.clientWidth || !host.clientHeight) return
      const hostRect = host.getBoundingClientRect(), rect = screen.getBoundingClientRect()
      const scaleX = hostRect.width / host.clientWidth || 1, scaleY = hostRect.height / host.clientHeight || 1
      const left = (rect.left - hostRect.left) / scaleX, top = (rect.top - hostRect.top) / scaleY
      const width = rect.width / scaleX, height = rect.height / scaleY
      if (width <= 0 || height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return
      const cellWidth = width / terminal.cols, cellHeight = height / terminal.rows
      const hostWidth = host.clientWidth, hostHeight = host.clientHeight
      const right = Math.min(hostWidth, left + width), bottom = Math.min(hostHeight, top + height)
      const theme = terminal.options.theme || {}, buffer = terminal.buffer.active
      const cell = buffer.getNullCell(), rectangles = []
      const colorAt = (column, row) => cellBackground(buffer.getLine(buffer.viewportY + row)?.getCell(column, cell), theme)
      const draw = (side, x, y, w, h, color) => { if (w > 0 && h > 0) rectangles.push([side, x, y, w, h, color]) }
      for (let row = 0; row < terminal.rows; row += 1) {
        const y = top + row * cellHeight
        draw('left', 0, y, left, cellHeight + 0.5, colorAt(0, row))
        draw('right', right, y, hostWidth - right, cellHeight + 0.5, colorAt(terminal.cols - 1, row))
      }
      for (let column = 0; column < terminal.cols; column += 1) {
        const x = left + column * cellWidth
        draw('top', x, 0, cellWidth + 0.5, top, colorAt(column, 0))
        draw('bottom', x, bottom, cellWidth + 0.5, hostHeight - bottom, colorAt(column, terminal.rows - 1))
      }
      draw('top', 0, 0, left, top, colorAt(0, 0))
      draw('top', right, 0, hostWidth - right, top, colorAt(terminal.cols - 1, 0))
      draw('bottom', 0, bottom, left, hostHeight - bottom, colorAt(0, terminal.rows - 1))
      draw('bottom', right, bottom, hostWidth - right, hostHeight - bottom, colorAt(terminal.cols - 1, terminal.rows - 1))
      const dpr = scope.devicePixelRatio || 1
      const signature = `${hostWidth}:${hostHeight}:${dpr}:${JSON.stringify(rectangles)}`
      if (signature === this.signature) return
      this.signature = signature
      // Four narrow backing stores avoid allocating another full-window texture.
      const regions = {
        top: [0, 0, hostWidth, top], bottom: [0, bottom, hostWidth, hostHeight - bottom],
        left: [0, top, left, height], right: [right, top, hostWidth - right, height]
      }
      for (const [side, [x, y, w, h]] of Object.entries(regions)) {
        const edge = this.canvases[side]
        edge.style.left = `${x}px`; edge.style.top = `${y}px`
        edge.style.width = `${Math.max(0, w)}px`; edge.style.height = `${Math.max(0, h)}px`
        edge.style.display = w > 0 && h > 0 ? 'block' : 'none'
        const bitmapWidth = Math.max(1, Math.ceil(w * dpr)), bitmapHeight = Math.max(1, Math.ceil(h * dpr))
        if (edge.width !== bitmapWidth) edge.width = bitmapWidth
        if (edge.height !== bitmapHeight) edge.height = bitmapHeight
        const context = edge.getContext('2d')
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, edge.width, edge.height)
        context.setTransform(dpr, 0, 0, dpr, -x * dpr, -y * dpr)
        for (const [target, rx, ry, rw, rh, color] of rectangles) {
          if (target !== side) continue
          context.fillStyle = color
          context.fillRect(rx, ry, rw + 1, rh + 1)
        }
      }
    }
    clear() {
      this.signature = ''
      for (const edge of Object.values(this.canvases)) {
        const context = edge.getContext('2d')
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, edge.width, edge.height)
      }
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { TerminalEdges, cellBackground, paletteColor }
  else scope.TerminalEdges = TerminalEdges
})(typeof window !== 'undefined' ? window : globalThis)
