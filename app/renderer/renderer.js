const $ = (id) => document.getElementById(id)

const viewList = $('view-list')
const viewTerminal = $('view-terminal')
const listScroll = $('list-scroll')
const deckStatus = $('deck-status')
const termContainer = $('term-container')
const brandTitle = $('brand-title')
const brandStage = document.querySelector('.brand-stage')
const toast = $('toast')
const bootScreen = $('boot-screen')

const ctxMenu = $('custom-context-menu')
const ctxNewCurrent = $('ctx-new-current')
const ctxNewCurrentLabel = $('ctx-new-current-label')
const ctxBack = $('ctx-back')
const ctxOpenOther = $('ctx-open-other')
const ctxSubMenu = $('ctx-sub-menu')
const ctxInstall = $('ctx-install')
const ctxInstallLabel = $('ctx-install-label')
const ctxCancelInstall = $('ctx-cancel-install')
const ctxRestart = $('ctx-restart')
const ctxOpenLog = $('ctx-open-log')
const ctxClose = $('ctx-close')

let tools = []
let toolById = new Map()
const states = new Map()
const rows = new Map()
const dirtyRows = new Set()
const pendingProgress = new Map()
let selectedToolId = null
let currentView = 'list'
let activeToolId = null
let terminal = null
let fitAddon = null
let webglAddon = null
let terminalLaunchToken = 0
let activeSessionId = null
let terminalExited = false
let lastCols = 0
let lastRows = 0
let lastPixelWidth = 0
let lastPixelHeight = 0
let renderFrame = 0
let progressFrame = 0
let fitFrame = 0
let brandFitFrame = 0
let toastTimer = null
let submenuCloseTimer = null

function getTool(id) {
  return toolById.get(id) || null
}

function selectedTool() {
  return getTool(selectedToolId)
}

function stateFor(tool) {
  return states.get(tool.id) || { state: tool.installed ? 'ready' : 'missing', percent: 0 }
}

function normalizePercent(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback
}

function hashBar(percent, width = 16) {
  const filled = Math.round((normalizePercent(percent) / 100) * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

function statusLabel(tool) {
  const value = stateFor(tool)
  if (value.state === 'installing') return `${hashBar(value.percent)} ${String(normalizePercent(value.percent)).padStart(3, ' ')}%`
  if (value.state === 'checking') return 'CHECKING'
  if (value.state === 'ready' || value.state === 'done') return ''
  if (value.state === 'confirm') return 'Click again to install'
  if (value.state === 'manual') return 'MANUAL SETUP'
  if (value.state === 'failed') return value.cancelled ? 'CANCELLED' : 'INSTALL ERROR'
  return tool.installable === false ? 'MANUAL SETUP' : ''
}

function updateDeckStatus() {
  const installing = tools.find((tool) => stateFor(tool).state === 'installing')
  if (installing) {
    const value = stateFor(installing)
    deckStatus.textContent = `${installing.name.toUpperCase()}  ${hashBar(value.percent, 20)} ${normalizePercent(value.percent)}%  ${value.line || ''}`.trim()
    return
  }
  const ready = tools.reduce((count, tool) => count + Number(['ready', 'done'].includes(stateFor(tool).state)), 0)
  deckStatus.textContent = `${String(ready).padStart(2, '0')} READY / ${String(tools.length).padStart(2, '0')} TOTAL`
}

function renderRow(tool) {
  const row = rows.get(tool.id)
  if (!row) return
  const value = stateFor(tool)
  row.item.classList.toggle('selected', tool.id === selectedToolId)
  row.item.classList.toggle('ready', ['ready', 'done'].includes(value.state))
  row.item.classList.toggle('installing', value.state === 'installing')
  row.item.classList.toggle('failed', value.state === 'failed')
  row.item.classList.toggle('confirm', value.state === 'confirm')
  row.item.setAttribute('aria-selected', String(tool.id === selectedToolId))
  row.status.textContent = statusLabel(tool)
  const detail = value.line || value.err || tool.hint || tool.summary
  row.item.title = detail
}

function flushRows() {
  renderFrame = 0
  for (const id of dirtyRows) {
    const tool = getTool(id)
    if (tool) renderRow(tool)
  }
  dirtyRows.clear()
  updateDeckStatus()
}

function queueRows(ids = tools.map((tool) => tool.id)) {
  for (const id of ids) dirtyRows.add(id)
  if (!renderFrame) renderFrame = requestAnimationFrame(flushRows)
}

function setState(toolId, next) {
  const previous = states.get(toolId) || {}
  const percent = next.state === 'installing'
    ? Math.max(normalizePercent(previous.percent), normalizePercent(next.percent, previous.percent || 0))
    : normalizePercent(next.percent, next.state === 'ready' ? 100 : 0)
  states.set(toolId, { ...previous, ...next, percent })
  queueRows([toolId])
}

function buildToolGrid() {
  rows.clear()
  const fragment = document.createDocumentFragment()
  tools.forEach((tool, index) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'cli-item'
    item.dataset.toolId = tool.id
    item.setAttribute('role', 'option')
    item.style.animationDelay = `${Math.min(index * 14, 120)}ms`

    const marker = document.createElement('span')
    marker.className = 'cli-marker'
    marker.textContent = '>'
    marker.setAttribute('aria-hidden', 'true')

    const name = document.createElement('span')
    name.className = 'cli-name'
    name.textContent = tool.name

    const status = document.createElement('span')
    status.className = 'cli-status'

    item.append(marker, name, status)
    fragment.appendChild(item)
    rows.set(tool.id, { item, status })
  })
  listScroll.replaceChildren(fragment)
  queueRows()
}

function selectTool(id, focus = false) {
  if (!toolById.has(id)) return
  const previous = selectedToolId
  if (previous && previous !== id && states.get(previous)?.state === 'confirm') {
    states.set(previous, { ...states.get(previous), state: 'missing', percent: 0 })
  }
  selectedToolId = id
  queueRows([previous, id].filter(Boolean))
  if (focus) rows.get(id)?.item.focus({ preventScroll: true })
}

function gridColumns() {
  const template = getComputedStyle(listScroll).gridTemplateColumns
  return Math.max(1, template.split(' ').filter(Boolean).length)
}

function moveSelection(horizontal, vertical) {
  if (!tools.length) return
  const index = Math.max(0, tools.findIndex((tool) => tool.id === selectedToolId))
  const nextIndex = Math.max(0, Math.min(tools.length - 1, index + horizontal + (vertical * gridColumns())))
  selectTool(tools[nextIndex].id, true)
}

function showToast(message) {
  clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.remove('hidden')
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200)
}

function showView(name) {
  currentView = name
  viewList.classList.toggle('hidden', name !== 'list')
  viewTerminal.classList.toggle('hidden', name !== 'terminal')
}

async function activateTool(tool) {
  if (!tool) return
  selectTool(tool.id)
  const value = stateFor(tool)
  if (value.state === 'installing') {
    showToast(`${tool.name} is already installing at ${value.percent}%.`)
    return
  }
  if (value.state === 'confirm') {
    await beginInstall(tool)
    return
  }
  if (!['ready', 'done'].includes(value.state)) {
    setState(tool.id, { state: 'confirm', percent: 0 })
    return
  }

  setState(tool.id, { state: 'checking' })
  let result
  try {
    result = await window.api.checkTool(tool.id)
  } catch (error) {
    setState(tool.id, { state: 'failed', err: String(error.message || error) })
    return
  }

  if (result.installed) {
    setState(tool.id, { state: 'ready', percent: 100 })
    await openTerminal(tool)
  } else if (result.installable === false) {
    setState(tool.id, { state: 'manual', hint: result.hint || tool.hint })
    showToast(result.hint || tool.hint || 'Manual setup is required.')
  } else {
    setState(tool.id, { state: 'confirm', percent: 0 })
  }
}

async function beginInstall(tool) {
  if (!tool) return
  if (tool.installable === false) {
    setState(tool.id, { state: 'manual', hint: tool.hint })
    showToast(tool.hint || 'Manual setup is required.')
    return
  }
  setState(tool.id, { state: 'installing', line: 'Preparing isolated installer...', percent: 1 })
  try {
    const result = await window.api.installTool(tool.id)
    if (result?.manual) setState(tool.id, { state: 'manual', hint: tool.hint })
    else if (result?.ok === false) setState(tool.id, { state: 'failed', err: result.error || 'Installer could not start.' })
  } catch (error) {
    setState(tool.id, { state: 'failed', err: String(error.message || error) })
  }
}

async function cancelInstall(tool) {
  if (!tool) return
  const result = await window.api.cancelInstall(tool.id)
  if (!result.ok) showToast(result.error || 'Installer could not be cancelled.')
}

async function openInstallLog(tool) {
  if (!tool) return
  const result = await window.api.openToolFolder(tool.id, 'log')
  if (!result.ok) showToast(result.error || 'Folder could not be opened.')
}

function initTerminal() {
  if (terminal) return
  terminal = new Terminal({
    allowTransparency: false,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 15,
    fontWeight: '400',
    fontWeightBold: '600',
    lineHeight: 1,
    rescaleOverlappingGlyphs: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    smoothScrollDuration: 0,
    theme: {
      background: '#000000',
      foreground: '#e8e4e2',
      cursor: '#ff6a27',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255, 90, 31, 0.28)',
      black: '#000000',
      brightBlack: '#6c625e',
      red: '#ff5a45',
      brightRed: '#ff806e',
      green: '#7ed99b',
      brightGreen: '#a2f2bb',
      yellow: '#e6bd68',
      brightYellow: '#ffd98a',
      blue: '#86a9ef',
      brightBlue: '#abc5ff',
      magenta: '#c58be5',
      brightMagenta: '#e0aff8',
      cyan: '#68c6d8',
      brightCyan: '#8de3f3',
      white: '#c8c2bf',
      brightWhite: '#ffffff'
    }
  })
  fitAddon = new FitAddon.FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(termContainer)
  try {
    if (window.WebglAddon?.WebglAddon) {
      webglAddon = new window.WebglAddon.WebglAddon()
      terminal.loadAddon(webglAddon)
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose()
        webglAddon = null
      })
    }
  } catch (error) {
    webglAddon = null
  }
  terminal.onData((data) => {
    if (terminalExited) {
      if (data.includes('\r')) restartTerminal()
      return
    }
    window.api.ptyWrite(data)
  })
}

function fitTerminal() {
  fitFrame = 0
  if (!terminal || !fitAddon || currentView !== 'terminal') return
  try {
    fitAddon.fit()
    const cols = Math.max(11, terminal.cols)
    const rowsCount = Math.max(6, terminal.rows)
    const pixelWidth = Math.max(1, Math.round(termContainer.clientWidth))
    const pixelHeight = Math.max(1, Math.round(termContainer.clientHeight))
    if (cols !== lastCols || rowsCount !== lastRows || pixelWidth !== lastPixelWidth || pixelHeight !== lastPixelHeight) {
      lastCols = cols
      lastRows = rowsCount
      lastPixelWidth = pixelWidth
      lastPixelHeight = pixelHeight
      window.api.ptyResize(cols, rowsCount, pixelWidth, pixelHeight)
    }
  } catch (error) {}
}

function scheduleFit() {
  if (!fitFrame) fitFrame = requestAnimationFrame(fitTerminal)
}

function clearTerminalSurface() {
  if (!terminal) return
  terminal.reset()
  terminal.clear()
  terminal.refresh(0, Math.max(0, terminal.rows - 1))
}

function fitBrandTitle() {
  brandFitFrame = 0
  brandTitle.style.fontSize = '24px'
  const widthScale = (brandStage.clientWidth * 0.94) / Math.max(1, brandTitle.scrollWidth)
  const heightScale = (brandStage.clientHeight * 0.68) / Math.max(1, brandTitle.scrollHeight)
  const fontSize = Math.max(8, Math.min(72, 24 * Math.min(widthScale, heightScale)))
  brandTitle.style.fontSize = `${fontSize.toFixed(2)}px`
}

function scheduleBrandFit() {
  if (!brandFitFrame) brandFitFrame = requestAnimationFrame(fitBrandTitle)
}

async function openTerminal(tool) {
  const launchToken = ++terminalLaunchToken
  activeToolId = tool.id
  activeSessionId = null
  terminalExited = false
  showView('terminal')
  initTerminal()
  clearTerminalSurface()

  fitTerminal()
  await new Promise((resolve) => setTimeout(resolve, 0))
  fitTerminal()

  let result
  try {
    result = await window.api.terminalStart(
      tool.id,
      terminal.cols || 90,
      terminal.rows || 28,
      Math.max(1, Math.round(termContainer.clientWidth)),
      Math.max(1, Math.round(termContainer.clientHeight))
    )
  } catch (error) {
    result = { ok: false, error: String(error.message || error) }
  }
  if (launchToken !== terminalLaunchToken) return
  if (!result.ok) {
    terminalExited = true
    terminal.writeln(`\x1b[31m[ERROR] ${result.error || 'Failed to start tool'}\x1b[0m\r\n`)
    terminal.writeln('\x1b[38;2;255;100;39mPress Enter to retry or Esc to return.\x1b[0m')
    return
  }
  activeSessionId = result.sessionId
  scheduleFit()
  requestAnimationFrame(scheduleFit)
  terminal.focus()
}

async function leaveTerminal() {
  terminalLaunchToken += 1
  activeSessionId = null
  terminalExited = false
  await window.api.terminalStop()
  showView('list')
  clearTerminalSurface()
  queueRows()
  rows.get(selectedToolId)?.item.focus({ preventScroll: true })
}

function restartTerminal() {
  const tool = getTool(activeToolId)
  if (tool) openTerminal(tool)
}

function flushProgressEvents() {
  progressFrame = 0
  for (const [toolId, data] of pendingProgress) {
    const previous = stateFor(getTool(toolId) || { id: toolId })
    setState(toolId, {
      state: 'installing',
      line: data.line || previous.line || 'Installing...',
      percent: normalizePercent(data.percent, previous.percent || 1),
      logAvailable: data.logAvailable ?? previous.logAvailable
    })
  }
  pendingProgress.clear()
}

function setupIpcListeners() {
  window.api.onInstallProgress((data) => {
    pendingProgress.set(data.toolId, data)
    if (!progressFrame) progressFrame = requestAnimationFrame(flushProgressEvents)
  })

  window.api.onInstallDone((data) => {
    pendingProgress.delete(data.toolId)
    const tool = getTool(data.toolId)
    if (!tool) return
    if (data.manual) setState(data.toolId, { state: 'manual', hint: data.hint, logAvailable: data.logAvailable })
    else if (data.ok) setState(data.toolId, { state: 'ready', percent: 100, logAvailable: data.logAvailable })
    else setState(data.toolId, { state: 'failed', cancelled: data.cancelled, err: data.error || 'Installation failed.', logAvailable: data.logAvailable })

    if (data.ok) showToast(`${tool.name} installed and verified locally.`)
    else showToast(data.cancelled ? `${tool.name} installation cancelled.` : `${tool.name} failed. Open the install log from the right-click menu.`)

  })

  window.api.onPtyData(({ sessionId, data }) => {
    if (!terminal || currentView !== 'terminal') return
    if (activeSessionId === null) activeSessionId = sessionId
    if (sessionId === activeSessionId) terminal.write(data)
  })

  window.api.onPtyExit(({ sessionId, exitCode }) => {
    if (!terminal || currentView !== 'terminal') return
    if (activeSessionId !== null && sessionId !== activeSessionId) return
    activeSessionId = null
    terminalExited = true
    terminal.writeln(`\r\n\x1b[38;2;255;100;39m[Session ended / exit ${exitCode}]\x1b[0m`)
    terminal.writeln('\x1b[90mPress Enter to restart or Esc to return to OmniShell.\x1b[0m')
  })
}

function hideContextMenu() {
  clearTimeout(submenuCloseTimer)
  ctxOpenOther.classList.remove('submenu-open')
  ctxOpenOther.setAttribute('aria-expanded', 'false')
  ctxMenu.classList.add('hidden')
}

function openSubmenu() {
  clearTimeout(submenuCloseTimer)
  ctxOpenOther.classList.add('submenu-open')
  ctxOpenOther.setAttribute('aria-expanded', 'true')
}

function scheduleSubmenuClose() {
  clearTimeout(submenuCloseTimer)
  submenuCloseTimer = setTimeout(() => {
    ctxOpenOther.classList.remove('submenu-open')
    ctxOpenOther.setAttribute('aria-expanded', 'false')
  }, 420)
}

function contextTool() {
  return currentView === 'terminal' ? getTool(activeToolId) : selectedTool()
}

function populateSubmenu() {
  const fragment = document.createDocumentFragment()
  for (const tool of tools) {
    if (currentView === 'terminal' && tool.id === activeToolId) continue
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'sub-item'
    item.dataset.toolId = tool.id
    const sigil = document.createElement('span')
    sigil.textContent = `[${tool.sigil}]`
    const name = document.createElement('span')
    name.textContent = tool.name
    item.append(sigil, name)
    fragment.appendChild(item)
  }
  ctxSubMenu.replaceChildren(fragment)
}

function showContextMenu(x, y) {
  const tool = contextTool()
  const value = tool ? stateFor(tool) : null
  const installing = value?.state === 'installing'
  ctxNewCurrent.classList.toggle('hidden', !tool)
  ctxNewCurrentLabel.textContent = tool ? `Open ${tool.name} in New Window` : 'Open CLI in New Window'
  ctxBack.classList.toggle('hidden', currentView !== 'terminal')
  ctxRestart.classList.toggle('hidden', currentView !== 'terminal')
  ctxOpenOther.classList.toggle('hidden', currentView !== 'terminal')
  ctxInstall.classList.toggle('hidden', !tool || tool.installable === false || installing || currentView === 'terminal')
  ctxInstallLabel.textContent = ['ready', 'done'].includes(value?.state) ? 'Update / Reinstall' : 'Install CLI'
  ctxCancelInstall.classList.toggle('hidden', !tool || !installing)
  ctxOpenLog.classList.toggle('hidden', !tool || value?.state !== 'failed' || !value?.logAvailable)
  if (currentView === 'terminal') populateSubmenu()
  ctxOpenOther.classList.remove('submenu-open')
  ctxMenu.classList.remove('hidden')

  const menuWidth = ctxMenu.offsetWidth || 236
  const menuHeight = ctxMenu.offsetHeight || 230
  const submenuWidth = 215
  ctxMenu.classList.toggle('open-left', x + menuWidth + submenuWidth + 16 > window.innerWidth)
  ctxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8))}px`
  ctxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))}px`
}

function setupContextMenu() {
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const row = event.target.closest?.('[data-tool-id]')
    if (currentView === 'list' && row?.dataset.toolId) selectTool(row.dataset.toolId)
    showContextMenu(event.clientX, event.clientY)
  })
  window.addEventListener('pointerdown', (event) => {
    if (!ctxMenu.contains(event.target)) hideContextMenu()
  })
  ctxOpenOther.addEventListener('pointerenter', openSubmenu)
  ctxOpenOther.addEventListener('pointerleave', scheduleSubmenuClose)
  ctxSubMenu.addEventListener('pointerenter', openSubmenu)
  ctxSubMenu.addEventListener('pointerleave', scheduleSubmenuClose)
  ctxOpenOther.addEventListener('click', (event) => {
    event.stopPropagation()
    if (ctxOpenOther.classList.contains('submenu-open')) scheduleSubmenuClose()
    else openSubmenu()
  })
  ctxSubMenu.addEventListener('click', (event) => {
    const item = event.target.closest('.sub-item')
    if (!item) return
    event.stopPropagation()
    hideContextMenu()
    window.api.openToolWindow(item.dataset.toolId)
  })
  ctxNewCurrent.addEventListener('click', () => {
    const tool = contextTool()
    hideContextMenu()
    if (tool) window.api.openToolWindow(tool.id)
  })
  ctxBack.addEventListener('click', () => { hideContextMenu(); leaveTerminal() })
  ctxRestart.addEventListener('click', () => { hideContextMenu(); restartTerminal() })
  ctxInstall.addEventListener('click', () => { const tool = contextTool(); hideContextMenu(); beginInstall(tool) })
  ctxCancelInstall.addEventListener('click', () => { const tool = contextTool(); hideContextMenu(); cancelInstall(tool) })
  ctxOpenLog.addEventListener('click', () => { const tool = contextTool(); hideContextMenu(); openInstallLog(tool) })
  ctxClose.addEventListener('click', () => { hideContextMenu(); window.api.closeWindow() })
}

function setupControls() {
  listScroll.addEventListener('pointerover', (event) => {
    const item = event.target.closest('.cli-item')
    if (item?.dataset.toolId) selectTool(item.dataset.toolId)
  })
  listScroll.addEventListener('click', (event) => {
    const item = event.target.closest('.cli-item')
    if (!item) return
    const tool = getTool(item.dataset.toolId)
    if (tool) activateTool(tool)
  })

  window.addEventListener('keydown', (event) => {
    if (!ctxMenu.classList.contains('hidden') && event.key === 'Escape') {
      event.preventDefault()
      hideContextMenu()
      return
    }
    if (currentView === 'terminal') {
      if (event.key === 'Escape') {
        event.preventDefault()
        leaveTerminal()
      }
      return
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(-1, 0) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveSelection(1, 0) }
    else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') { event.preventDefault(); moveSelection(0, -1) }
    else if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') { event.preventDefault(); moveSelection(0, 1) }
    else if (event.key === 'Enter') { event.preventDefault(); activateTool(selectedTool()) }
    else if (event.key.toLowerCase() === 'n') { event.preventDefault(); window.api.openToolWindow(null) }
    else if (event.key.toLowerCase() === 'u') { event.preventDefault(); beginInstall(selectedTool()) }
  })
}

;(async function init() {
  setupIpcListeners()
  setupContextMenu()
  setupControls()
  window.addEventListener('resize', () => {
    scheduleFit()
    scheduleBrandFit()
  }, { passive: true })
  if (window.ResizeObserver) new ResizeObserver(scheduleFit).observe(termContainer)

  tools = await window.api.tools()
  toolById = new Map(tools.map((tool) => [tool.id, tool]))
  for (const tool of tools) {
    states.set(tool.id, tool.installing
      ? { state: 'installing', line: 'Installer is running...', percent: tool.installPercent || 1, logAvailable: tool.hasLog }
      : { state: tool.installed ? 'ready' : (tool.installable === false ? 'manual' : 'missing'), percent: tool.installed ? 100 : 0, hint: tool.hint, logAvailable: tool.hasLog })
  }
  selectedToolId = tools[0]?.id || null
  buildToolGrid()
  await document.fonts.ready
  fitBrandTitle()

  bootScreen.classList.add('ready')
  setTimeout(() => bootScreen.classList.add('hidden'), 200)

  const initialToolId = await window.api.getInitialTool()
  const initialTool = getTool(initialToolId)
  if (initialTool) {
    selectTool(initialTool.id)
    activateTool(initialTool)
  }
})().catch((error) => {
  deckStatus.textContent = `BOOT ERROR / ${String(error.message || error).toUpperCase()}`
  bootScreen.classList.add('hidden')
})
