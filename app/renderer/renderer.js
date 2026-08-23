const listScroll = document.getElementById('list-scroll')
const viewList = document.getElementById('view-list')
const viewTerminal = document.getElementById('view-terminal')
const termContainer = document.getElementById('term-container')
const panel = document.getElementById('panel')
const ctxMenu = document.getElementById('custom-context-menu')
const ctxNewCurrent = document.getElementById('ctx-new-current')
const ctxNewCurrentLabel = document.getElementById('ctx-new-current-label')
const ctxBack = document.getElementById('ctx-back')
const ctxOpenOther = document.getElementById('ctx-open-other')
const ctxSubMenu = document.getElementById('ctx-sub-menu')
const ctxRestart = document.getElementById('ctx-restart')
const ctxClose = document.getElementById('ctx-close')

let tools = []
let states = {}
let rows = []
let selectedIndex = 0
let currentView = 'list'
let activeToolId = null
let terminal = null
let fitAddon = null
let lastCols = 0
let lastRows = 0
let fitTimer = null

function showView(name) {
  currentView = name
  viewList.classList.toggle('hidden', name !== 'list')
  viewTerminal.classList.toggle('hidden', name !== 'terminal')
}

function asciiBar(pct) {
  const width = 16
  const filled = Math.max(0, Math.min(width, Math.round((width * pct) / 100)))
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']'
}

function statusText(id) {
  const st = states[id]
  if (!st || st.state === 'idle') return ''
  if (st.state === 'checking') return 'CHECKING…'
  if (st.state === 'missing') return 'NOT INSTALLED · ENTER = INSTALL'
  if (st.state === 'installing') {
    const pct = Math.min(99, Math.round(st.percent || 0))
    return asciiBar(st.percent || 0) + ' ' + pct + '%'
  }
  if (st.state === 'manual') return 'MANUAL · ' + (st.hint || '')
  if (st.state === 'done') return 'INSTALLED ✓'
  if (st.state === 'failed') {
    const detail = st.err ? ' · ' + st.err.slice(0, 32) : ''
    return 'ERROR' + detail
  }
  return ''
}

let inputSource = 'keyboard'
let lastMouseX = -1
let lastMouseY = -1

document.addEventListener('mousemove', (e) => {
  if (Math.abs(e.clientX - lastMouseX) > 2 || Math.abs(e.clientY - lastMouseY) > 2) {
    lastMouseX = e.clientX
    lastMouseY = e.clientY
    inputSource = 'mouse'
  }
})

function buildList() {
  listScroll.innerHTML = ''
  rows = []

  let currentCategory = null

  tools.forEach((t, i) => {
    const cat = t.category === 'torrent' ? 'torrent' : 'ai'
    if (currentCategory && cat !== currentCategory) {
      const divider = document.createElement('div')
      divider.className = 'category-divider'
      listScroll.appendChild(divider)
    }
    currentCategory = cat

    const item = document.createElement('div')
    item.className = 'cli-item'
    item.style.animationDelay = (i * 15) + 'ms'

    const marker = document.createElement('span')
    marker.className = 'marker'
    marker.textContent = '>'

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = t.name

    const status = document.createElement('span')
    status.className = 'status'

    item.appendChild(marker)
    item.appendChild(name)
    item.appendChild(status)

    item.addEventListener('mouseenter', () => {
      if (inputSource !== 'mouse' || currentView !== 'list') return
      if (selectedIndex !== i) {
        selectedIndex = i
        updateRows()
      }
    })

    item.addEventListener('click', (e) => {
      e.stopPropagation()
      activateTool(i)
    })

    listScroll.appendChild(item)

    rows.push({ item, status })
  })
}

function updateRows() {
  tools.forEach((t, i) => {
    if (rows[i]) {
      rows[i].item.classList.toggle('selected', i === selectedIndex)
      rows[i].status.textContent = statusText(t.id)
    }
  })
}

function scrollToSelected() {
  if (!rows.length || !rows[selectedIndex]) return
  const el = rows[selectedIndex].item
  const top = el.offsetTop - listScroll.clientHeight / 2 + el.clientHeight / 2
  listScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

function moveSelection(delta) {
  if (!tools.length) return
  selectedIndex = (selectedIndex + delta + tools.length) % tools.length
  updateRows()
  scrollToSelected()
}

async function activateTool(index) {
  selectedIndex = index
  const tool = tools[selectedIndex]
  if (!tool) return
  activeToolId = tool.id

  const curr = states[tool.id]
  if (curr && (curr.state === 'missing' || curr.state === 'failed')) {
    beginInstall(tool)
    return
  }
  if (curr && curr.state === 'installing') {
    return
  }

  states[tool.id] = { state: 'checking' }
  updateRows()

  const result = await window.api.checkTool(tool.id)
  if (activeToolId !== tool.id) return

  if (result.installed) {
    delete states[tool.id]
    updateRows()
    openTerminal(tool)
  } else {
    states[tool.id] = { state: 'missing', hint: result.hint }
    updateRows()
  }
}

function beginInstall(tool) {
  activeToolId = tool.id
  states[tool.id] = { state: 'installing', percent: 6, line: 'Starting installation...' }
  updateRows()
  window.api.installTool(tool.id)
}

function initTerminal() {
  if (terminal) return
  terminal = new Terminal({
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "JetBrains Mono", monospace',
    fontSize: 15,
    lineHeight: 1.0,
    cursorBlink: true,
    cursorStyle: 'bar',
    theme: {
      background: '#000000',
      foreground: '#e6e6e6',
      cursor: '#ffffff',
      selectionBackground: 'rgba(255, 255, 255, 0.25)',
      black: '#000000',
      brightBlack: '#666666',
      red: '#ff5555',
      brightRed: '#ff6e6e',
      green: '#50fa7b',
      brightGreen: '#69ff94',
      yellow: '#f1fa8c',
      brightYellow: '#ffffa5',
      blue: '#bd93f9',
      brightBlue: '#d6acff',
      magenta: '#ff79c6',
      brightMagenta: '#ff92df',
      cyan: '#8be9fd',
      brightCyan: '#a4ffff',
      white: '#bfbfbf',
      brightWhite: '#ffffff'
    },
    allowProposedApi: true
  })

  fitAddon = new FitAddon.FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(termContainer)

  terminal.onData((data) => {
    window.api.ptyWrite(data)
  })
}

function fitTerminal() {
  if (!terminal || !fitAddon || currentView !== 'terminal') return
  try {
    const dims = fitAddon.proposeDimensions()
    if (dims && dims.cols && dims.rows) {
      const safeCols = Math.max(10, dims.cols)
      const safeRows = Math.max(5, dims.rows)
      if (terminal.cols !== safeCols || terminal.rows !== safeRows) {
        terminal.resize(safeCols, safeRows)
      }
      if (safeCols !== lastCols || safeRows !== lastRows) {
        lastCols = safeCols
        lastRows = safeRows
        window.api.ptyResize(safeCols, safeRows)
      }
    } else {
      fitAddon.fit()
      if (terminal.cols > 10 && terminal.rows > 5 && (terminal.cols !== lastCols || terminal.rows !== lastRows)) {
        lastCols = terminal.cols
        lastRows = terminal.rows
        window.api.ptyResize(terminal.cols, terminal.rows)
      }
    }
  } catch (e) {}
}

function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer)
  fitTimer = setTimeout(fitTerminal, 30)
}

async function openTerminal(tool) {
  activeToolId = tool.id
  showView('terminal')

  initTerminal()
  terminal.reset()

  requestAnimationFrame(async () => {
    fitTerminal()
    const cols = (terminal && terminal.cols > 10) ? terminal.cols : 90
    const rows = (terminal && terminal.rows > 5) ? terminal.rows : 28

    const res = await window.api.terminalStart(tool.id, cols, rows)
    if (!res.ok) {
      terminal.writeln('\x1b[31m[ERROR] ' + (res.error || 'Failed to start tool') + '\x1b[0m\r\n')
      terminal.writeln('\x1b[90mRight-click and select "Back to Menu" to return to the tool list.\x1b[0m')
    } else {
      setTimeout(fitTerminal, 40)
      setTimeout(fitTerminal, 140)
      setTimeout(fitTerminal, 350)
      terminal.focus()
    }
  })
}

async function leaveTerminal() {
  await window.api.terminalStop()
  showView('list')
  if (terminal) {
    terminal.reset()
  }
  updateRows()
  scrollToSelected()
}

function setupIpcListeners() {
  window.api.onInstallProgress((d) => {
    const st = states[activeToolId]
    if (!st || st.state !== 'installing') return
    st.percent = d.percent
    st.line = d.line
    updateRows()
  })

  window.api.onInstallDone((d) => {
    const st = states[activeToolId]
    if (!st) return
    if (d.manual) {
      states[activeToolId] = { state: 'manual', hint: d.hint || '' }
      updateRows()
      return
    }
    if (d.ok) {
      states[activeToolId] = { state: 'done', percent: 100 }
      updateRows()
      setTimeout(() => {
        const tool = tools.find(t => t.id === activeToolId)
        if (tool && currentView === 'list') {
          openTerminal(tool)
        }
      }, 500)
    } else {
      states[activeToolId] = {
        state: 'failed',
        err: (st.line || '').replace(/^\s*\[?\d+\/\d+\]?\s*/, '').slice(0, 50)
      }
      updateRows()
    }
  })

  window.api.onPtyData((data) => {
    if (terminal && currentView === 'terminal') {
      terminal.write(data)
    }
  })

  window.api.onPtyExit(({ exitCode }) => {
    if (terminal && currentView === 'terminal') {
      terminal.writeln('\r\n\x1b[90m[Session ended (Exit code: ' + exitCode + '). Right-click to return to menu]\x1b[0m')
    }
  })
}

function setupKeyboardEvents() {
  window.addEventListener('keydown', (e) => {
    inputSource = 'keyboard'
    // In terminal view, ESC and keys are passed directly to terminal without interruption
    if (currentView !== 'list') return

    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      moveSelection(-1)
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      moveSelection(1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const tool = tools[selectedIndex]
      if (!tool) return
      const st = states[tool.id]
      if (st && (st.state === 'missing' || st.state === 'failed')) {
        beginInstall(tool)
      } else if (!st || st.state === 'idle' || st.state === 'done') {
        activateTool(selectedIndex)
      }
    }
  })
}

function hideContextMenu() {
  if (ctxMenu) {
    ctxMenu.classList.add('hidden')
  }
}

function showContextMenu(x, y) {
  if (!ctxMenu) return

  // Show "Open in New Window (Current Tool)"
  if (ctxNewCurrent) {
    if (currentView === 'terminal' && activeToolId) {
      const curTool = tools.find(t => t.id === activeToolId)
      const tName = curTool ? curTool.name : 'Current Tool'
      if (ctxNewCurrentLabel) ctxNewCurrentLabel.textContent = `New Window (${tName})`
      ctxNewCurrent.classList.remove('hidden')
    } else {
      if (ctxNewCurrentLabel) ctxNewCurrentLabel.textContent = 'Open New Window'
      ctxNewCurrent.classList.remove('hidden')
    }
  }

  // In terminal view show back & restart; in list view hide them
  if (ctxBack) ctxBack.classList.toggle('hidden', currentView !== 'terminal')
  if (ctxRestart) ctxRestart.classList.toggle('hidden', currentView !== 'terminal')

  // Populate submenu with other tools excluding the active tool
  if (ctxSubMenu) {
    ctxSubMenu.innerHTML = ''
    const availableTools = tools.filter(t => currentView !== 'terminal' || t.id !== activeToolId)
    availableTools.forEach((t) => {
      const subItem = document.createElement('div')
      subItem.className = 'sub-item'
      subItem.textContent = t.name
      subItem.addEventListener('click', (e) => {
        e.stopPropagation()
        hideContextMenu()
        window.api.openToolWindow(t.id)
      })
      ctxSubMenu.appendChild(subItem)
    })
  }

  ctxMenu.classList.remove('hidden')

  // Adjust positioning to stay within viewport
  const menuWidth = 200
  const menuHeight = ctxMenu.offsetHeight || 160
  const winW = window.innerWidth
  const winH = window.innerHeight

  const posX = (x + menuWidth > winW) ? Math.max(10, x - menuWidth) : x
  const posY = (y + menuHeight > winH) ? Math.max(10, y - menuHeight) : y

  ctxMenu.style.left = posX + 'px'
  ctxMenu.style.top = posY + 'px'
}

function setupContextMenu() {
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY)
  })

  window.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) {
      hideContextMenu()
    }
  })

  if (ctxNewCurrent) {
    ctxNewCurrent.addEventListener('click', (e) => {
      e.stopPropagation()
      hideContextMenu()
      if (currentView === 'terminal' && activeToolId) {
        window.api.openToolWindow(activeToolId)
      } else {
        window.api.openToolWindow(null)
      }
    })
  }

  if (ctxBack) {
    ctxBack.addEventListener('click', (e) => {
      e.stopPropagation()
      hideContextMenu()
      leaveTerminal()
    })
  }

  if (ctxRestart) {
    ctxRestart.addEventListener('click', (e) => {
      e.stopPropagation()
      hideContextMenu()
      if (activeToolId) {
        const tool = tools.find(t => t.id === activeToolId)
        if (tool) openTerminal(tool)
      }
    })
  }

  if (ctxClose) {
    ctxClose.addEventListener('click', (e) => {
      e.stopPropagation()
      hideContextMenu()
      window.api.closeWindow()
    })
  }
}

function buildResizeHandles() {
  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  dirs.forEach((d) => {
    const el = document.createElement('div')
    el.className = 'rh rh-' + d
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      window.api.resizeStart(d, ev.screenX, ev.screenY)
      const onMove = (e2) => window.api.resizeMove(e2.screenX, e2.screenY)
      const onUp = () => {
        window.api.resizeEnd()
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
    panel.appendChild(el)
  })
}

;(async function init() {
  setupIpcListeners()
  setupKeyboardEvents()
  setupContextMenu()
  buildResizeHandles()
  window.addEventListener('resize', scheduleFit)

  if (window.ResizeObserver && termContainer) {
    const ro = new ResizeObserver(() => {
      if (currentView === 'terminal') {
        scheduleFit()
      }
    })
    ro.observe(termContainer)
    if (panel) ro.observe(panel)
  }

  tools = await window.api.tools()
  buildList()
  updateRows()

  // Check if launched directly with an initial tool
  const initialToolId = await window.api.getInitialTool()
  if (initialToolId) {
    const tool = tools.find(t => t.id === initialToolId)
    if (tool) {
      openTerminal(tool)
    }
  }
})()


