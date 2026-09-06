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
const profileOverlay = $('profile-overlay')
const profileCard = profileOverlay.querySelector('.profile-card')
const profileTitle = $('profile-title')
const profileList = $('profile-list')
const profileEditor = $('profile-editor')
const profileEditorLabel = $('profile-editor-label')
const profileName = $('profile-name')
const profileCreateSettings = $('profile-create-settings')
const profileStatus = $('profile-status')
const profileNew = $('profile-new')
const profileRename = $('profile-rename')
const profileInstall = $('profile-install')
const profileSettingsOpen = $('profile-settings-open')
const profileSettings = $('profile-settings')
const profileSettingsOptions = $('profile-settings-options')
const profileSettingsSave = $('profile-settings-save')
const profileSettingsCancel = $('profile-settings-cancel')
const profileDelete = $('profile-delete')
const profileSave = $('profile-save')
const profileCancel = $('profile-cancel')

const ctxMenu = $('custom-context-menu')
const ctxNewCurrent = $('ctx-new-current')
const ctxNewCurrentLabel = $('ctx-new-current-label')
const ctxOpenOther = $('ctx-open-other')
const ctxSubMenu = $('ctx-sub-menu')
const ctxInstall = $('ctx-install')
const ctxInstallLabel = $('ctx-install-label')
const ctxCancelInstall = $('ctx-cancel-install')
const ctxRestart = $('ctx-restart')
const ctxOpenLog = $('ctx-open-log')
const ctxCopy = $('ctx-copy')
const ctxClose = $('ctx-close')
const ctxMinimize = $('ctx-minimize')

let tools = []
let toolById = new Map()
const states = new Map()
const rows = new Map()
const dirtyRows = new Set()
const pendingProgress = new Map()
const profilesCache = new Map()
const profileInstallStates = new Map()
const profileCapabilitiesCache = new Map()
const profileRows = new Map()
const submenuRows = new Map()
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let selectedToolId = null
let currentView = 'list'
let activeToolId = null
let activeProfileId = 'default'
let activeProfileName = 'Default'
let isAuxiliaryWindow = false
let profileDialogToolId = null
let profileDialogMode = 'current'
let selectedProfileId = null
let profileEditorMode = null
let profileSettingsDraft = null
let profileDeleteArmed = false
let terminal = null
let terminalEdges = null
let fitAddon = null
let webglAddon = null
let terminalLaunchToken = 0
let activeSessionId = null
let terminalExited = false
let terminalCursorVisible = false
let terminalCursorTimer = null
let terminalSurfaceTimer = null
let terminalSurfaceColor = '#000000'
let lastCols = 0
let lastRows = 0
let lastPixelWidth = 0
let lastPixelHeight = 0
let renderFrame = 0
let progressFrame = 0
let fitFrame = 0
let brandFitFrame = 0
let lastBrandFitKey = ''
let lastBrandStageKey = ''
let brandNaturalWidth = 0
let brandNaturalHeight = 0
let toastTimer = null
let toastCloseAnimation = null
let submenuCloseTimer = null
let profileCloseToken = 0
let contextCloseAnimation = null
let resizeState = null
let resizeFrame = 0
let pendingResizeBounds = null
let carouselFrame = 0
let carouselShouldCenter = false
let viewTransitionToken = 0
let viewAnimations = []

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

function hashBar(percent, width = 12) {
  const filled = Math.round((normalizePercent(percent) / 100) * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

function statusLabel(tool) {
  const value = stateFor(tool)
  if (value.state === 'installing') return `${hashBar(value.percent)} ${String(normalizePercent(value.percent)).padStart(3, ' ')}%`
  if (value.state === 'checking') return 'CHECKING'
  if (value.state === 'ready' || value.state === 'done') return ''
  if (value.state === 'confirm') return ''
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
  row.status.textContent = value.state === 'confirm' ? '' : statusLabel(tool)
  row.confirm.classList.toggle('hidden', value.state !== 'confirm')
  row.prompt.textContent = value.confirmPrompt || 'Install?'
  const choice = value.confirmChoice === 'no' ? 'no' : 'yes'
  row.yes.classList.toggle('active', choice === 'yes')
  row.no.classList.toggle('active', choice === 'no')
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

function flushCarousel() {
  carouselFrame = 0
  const selectedIndex = Math.max(0, tools.findIndex((tool) => tool.id === selectedToolId))
  for (let index = 0; index < tools.length; index += 1) {
    const row = rows.get(tools[index].id)
    if (!row) continue
    const distance = Math.abs(index - selectedIndex)
    row.item.dataset.distance = String(Math.min(2, distance))
    row.item.dataset.direction = index < selectedIndex ? 'above' : (index > selectedIndex ? 'below' : 'current')
  }
  if (carouselShouldCenter) {
    rows.get(selectedToolId)?.item.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reducedMotion.matches ? 'auto' : 'smooth'
    })
  }
  carouselShouldCenter = false
}

function queueCarousel(center = false) {
  carouselShouldCenter ||= center
  if (!carouselFrame) carouselFrame = requestAnimationFrame(flushCarousel)
}

function queueRows(ids = tools.map((tool) => tool.id)) {
  for (const id of ids) dirtyRows.add(id)
  if (!renderFrame) renderFrame = requestAnimationFrame(flushRows)
}

function setState(toolId, next) {
  const previous = states.get(toolId) || {}
  const percent = next.state === 'installing'
    ? Math.max(previous.state === 'installing' ? normalizePercent(previous.percent) : 0, normalizePercent(next.percent, 1))
    : normalizePercent(next.percent, next.state === 'ready' ? 100 : 0)
  states.set(toolId, { ...previous, ...next, percent })
  queueRows([toolId])
}

function buildToolGrid() {
  rows.clear()
  const fragment = document.createDocumentFragment()
  tools.forEach((tool, index) => {
    const item = document.createElement('div')
    item.className = 'cli-item'
    item.dataset.toolId = tool.id
    item.setAttribute('role', 'option')
    item.tabIndex = -1
    item.style.animationDelay = `${Math.min(index * 10, 80)}ms`

    const marker = document.createElement('span')
    marker.className = 'cli-marker'
    marker.textContent = '>'
    marker.setAttribute('aria-hidden', 'true')

    const name = document.createElement('span')
    name.className = 'cli-name'
    name.textContent = tool.name

    const status = document.createElement('span')
    status.className = 'cli-status'

    const confirm = document.createElement('span')
    confirm.className = 'cli-confirm hidden'
    const prompt = document.createElement('span')
    prompt.className = 'confirm-prompt'
    prompt.textContent = 'Install?'
    const yes = document.createElement('button')
    yes.type = 'button'
    yes.dataset.confirm = 'yes'
    yes.textContent = 'YES'
    const no = document.createElement('button')
    no.type = 'button'
    no.dataset.confirm = 'no'
    no.textContent = 'NO'
    confirm.append(prompt, yes, no)

    item.append(marker, name, status, confirm)
    fragment.appendChild(item)
    rows.set(tool.id, { item, status, confirm, prompt, yes, no })
  })
  listScroll.replaceChildren(fragment)
  queueRows()
  queueCarousel(true)
}

function selectTool(id, focus = false) {
  if (!toolById.has(id)) return
  const previous = selectedToolId
  if (previous === id) {
    if (focus) rows.get(id)?.item.focus({ preventScroll: true })
    queueCarousel(focus)
    return
  }
  if (previous && previous !== id && states.get(previous)?.state === 'confirm') {
    const previousState = states.get(previous)
    states.set(previous, {
      ...previousState,
      state: previousState.confirmReturnState || 'missing',
      percent: 0,
      confirmReturnState: null
    })
  }
  selectedToolId = id
  queueRows([previous, id].filter(Boolean))
  queueCarousel(focus)
  if (focus) rows.get(id)?.item.focus({ preventScroll: true })
}

function gridColumns() {
  return 1
}

function moveSelection(horizontal, vertical) {
  if (!tools.length) return
  const index = Math.max(0, tools.findIndex((tool) => tool.id === selectedToolId))
  const direction = vertical || horizontal
  const nextIndex = Math.max(0, Math.min(tools.length - 1, index + direction))
  selectTool(tools[nextIndex].id, true)
}

function showToast(message) {
  clearTimeout(toastTimer)
  toastCloseAnimation?.cancel()
  toastCloseAnimation = null
  toast.textContent = message
  toast.classList.remove('hidden')
  if (typeof toast.animate === 'function') {
    toast.animate(
      reducedMotion.matches
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: reducedMotion.matches ? 80 : 140, easing: 'cubic-bezier(0.2, 0.75, 0.2, 1)' }
    )
  }
  toastTimer = setTimeout(() => {
    if (typeof toast.animate !== 'function') {
      toast.classList.add('hidden')
      return
    }
    const animation = toast.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: reducedMotion.matches ? 70 : 100, easing: 'ease-in', fill: 'forwards' }
    )
    toastCloseAnimation = animation
    animation.finished.catch(() => {}).then(() => {
      if (toastCloseAnimation !== animation) return
      toast.classList.add('hidden')
      animation.cancel()
      toastCloseAnimation = null
    })
  }, 3200)
}

async function copyTerminalSelection() {
  if (!terminal?.hasSelection()) return false
  const result = await window.api.clipboardWriteText(terminal.getSelection())
  if (!result?.ok) {
    showToast(result?.error || 'Selection could not be copied.')
    return false
  }
  showToast('Copied to clipboard.')
  return true
}

async function pasteClipboard() {
  if (!terminal || currentView !== 'terminal' || terminalExited) return false
  const value = await window.api.clipboardReadText()
  if (typeof value !== 'string' || !value) return false
  terminal.paste(value.slice(0, 1024 * 1024))
  terminal.focus()
  return true
}

function showView(name, immediate = false) {
  const previousName = currentView
  const entering = name === 'list' ? viewList : viewTerminal
  const leaving = name === 'list' ? viewTerminal : viewList
  const token = ++viewTransitionToken
  for (const animation of viewAnimations) animation.cancel()
  viewAnimations = []
  currentView = name
  entering.classList.remove('hidden')
  if (name === 'list') {
    scheduleBrandFit()
    queueCarousel(true)
  } else {
    scheduleFit()
  }
  if (previousName === name || immediate || reducedMotion.matches || typeof entering.animate !== 'function') {
    leaving.classList.add('hidden')
    return Promise.resolve()
  }
  leaving.classList.remove('hidden')
  const direction = name === 'terminal' ? 1 : -1
  const enterAnimation = entering.animate([
    { opacity: 0, transform: `translateY(${direction * 10}px) scale(0.992)` },
    { opacity: 1, transform: 'translateY(0) scale(1)' }
  ], { duration: 190, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' })
  const leaveAnimation = leaving.animate([
    { opacity: 1, transform: 'translateY(0) scale(1)' },
    { opacity: 0, transform: `translateY(${direction * -6}px) scale(0.996)` }
  ], { duration: 125, easing: 'ease-in', fill: 'both' })
  viewAnimations = [enterAnimation, leaveAnimation]
  return Promise.allSettled([enterAnimation.finished, leaveAnimation.finished]).then(() => {
    if (token !== viewTransitionToken) return
    leaving.classList.add('hidden')
    enterAnimation.cancel()
    leaveAnimation.cancel()
    viewAnimations = []
    if (name === 'terminal') {
      scheduleFit()
      scheduleTerminalSurfaceSync()
      terminal?.focus()
    }
  })
}

function profileDialogTool() {
  return getTool(profileDialogToolId)
}

async function loadProfiles(tool, force = false) {
  if (!force && profilesCache.has(tool.id)) return profilesCache.get(tool.id)
  const result = await window.api.profiles(tool.id)
  if (!result?.ok) throw new Error(result?.error || 'Profiles could not be loaded')
  profilesCache.set(tool.id, result.profiles)
  for (const profile of result.profiles) {
    const key = `${tool.id}:${profile.id}`
    if (profile.installing) profileInstallStates.set(key, { ...profile, percent: profile.installPercent, line: profile.installLine })
    else if (profileInstallStates.get(key)?.installing) profileInstallStates.delete(key)
  }
  profileCapabilitiesCache.set(tool.id, result.capabilities || {})
  return result.profiles
}

function renderProfileList(profiles) {
  const ids = new Set(profiles.map((profile) => profile.id))
  for (const [id, row] of profileRows) {
    if (!ids.has(id)) {
      row.remove()
      profileRows.delete(id)
    }
  }

  const fragment = document.createDocumentFragment()
  for (const profile of profiles) {
    let row = profileRows.get(profile.id)
    if (!row) {
      row = document.createElement('button')
      row.type = 'button'
      row.className = 'profile-row'
      row.dataset.profileId = profile.id
      row.setAttribute('role', 'option')
      const marker = document.createElement('span')
      marker.className = 'profile-marker'
      marker.textContent = '>'
      const name = document.createElement('span')
      name.className = 'profile-row-name'
      row.append(marker, name)
      profileRows.set(profile.id, row)
    }
    row.querySelector('.profile-row-name').textContent = profile.name
    row.dataset.installed = String(Boolean(profile.installed))
    row.title = profile.installed ? profile.name : `${profile.name} — isolated CLI installation required`
    row.classList.toggle('selected', profile.id === selectedProfileId)
    row.setAttribute('aria-selected', String(profile.id === selectedProfileId))
    fragment.appendChild(row)
  }
  profileList.replaceChildren(fragment)
  updateProfileActions()
}

function selectedProfileRecord() {
  const profiles = profilesCache.get(profileDialogToolId) || []
  return profiles.find((profile) => profile.id === selectedProfileId) || null
}

const PROFILE_SETTING_LABELS = {
  fullPermission: 'FULL PERMISSION',
  sharedSessions: 'SHARED SESSIONS',
  sharedModels: 'SHARED MODELS',
  sharedConfig: 'SHARED CONFIG'
}

function normalizedSettings(settings = {}) {
  return Object.fromEntries(Object.keys(PROFILE_SETTING_LABELS).map((key) => [key, settings[key] === true]))
}

function renderSettingsOptions(container) {
  const capabilities = profileCapabilitiesCache.get(profileDialogToolId) || {}
  const fragment = document.createDocumentFragment()
  for (const [key, label] of Object.entries(PROFILE_SETTING_LABELS)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.setting = key
    const supported = key === 'fullPermission' || capabilities[key] !== false
    const enabled = supported && profileSettingsDraft?.[key] === true
    button.disabled = !supported
    button.setAttribute('aria-pressed', String(enabled))
    button.textContent = `${enabled ? '[x]' : '[ ]'} ${label}${supported ? '' : ' / N/A'}`
    fragment.appendChild(button)
  }
  container.replaceChildren(fragment)
}

function toggleProfileSetting(event) {
  const button = event.target.closest('[data-setting]')
  if (!button || button.disabled || !profileSettingsDraft) return
  profileSettingsDraft[button.dataset.setting] = !profileSettingsDraft[button.dataset.setting]
  renderSettingsOptions(button.parentElement)
  button.parentElement.querySelector(`[data-setting="${button.dataset.setting}"]`)?.focus({ preventScroll: true })
}

function hideProfileSettings() {
  profileSettingsDraft = null
  profileDeleteArmed = false
  profileDelete.textContent = 'DELETE'
  profileSettings.classList.add('hidden')
  profileStatus.textContent = ''
}

function showProfileSettings() {
  const profile = selectedProfileRecord()
  if (!profile) return
  hideProfileEditor()
  profileSettingsDraft = normalizedSettings(profile.settings)
  profileDeleteArmed = false
  profileDelete.textContent = 'DELETE'
  profileDelete.classList.toggle('hidden', profile.id === 'default')
  profileSettings.classList.remove('hidden')
  renderSettingsOptions(profileSettingsOptions)
  profileSettingsOptions.querySelector('button:not([disabled])')?.focus({ preventScroll: true })
}

function installStatusText(state) {
  const elapsed = state.elapsedSeconds ? ` ? ${state.elapsedSeconds}s` : ''
  return `${hashBar(state.percent)} ${normalizePercent(state.percent)}%${elapsed}\n${state.line || 'Preparing installer...'}`
}

function updateProfileActions() {
  const profile = selectedProfileRecord()
  const state = profileInstallStates.get(`${profileDialogToolId}:${profile?.id}`)
  profileRename.disabled = !profile || Boolean(state?.installing)
  profileSettingsOpen.disabled = !profile || Boolean(state?.installing)
  profileInstall.classList.toggle('hidden', !profile)
  profileInstall.disabled = !profile
  profileInstall.textContent = state?.installing ? 'CANCEL' : (profile?.installed ? 'UPDATE' : 'INSTALL')
  profileStatus.textContent = state?.installing ? installStatusText(state) : (state?.message || '')
}

function setSelectedProfile(profileId, focus = false) {
  if (!profileRows.has(profileId)) return
  const previousId = selectedProfileId
  selectedProfileId = profileId
  for (const id of new Set([previousId, profileId])) {
    const row = profileRows.get(id)
    if (!row) continue
    const selected = id === selectedProfileId
    row.classList.toggle('selected', selected)
    row.setAttribute('aria-selected', String(selected))
  }
  updateProfileActions()
  if (focus) profileRows.get(selectedProfileId)?.focus({ preventScroll: true })
}

function hideProfileEditor() {
  if (profileEditorMode === 'create') profileSettingsDraft = null
  profileEditorMode = null
  profileEditor.classList.add('hidden')
  profileCreateSettings.classList.add('hidden')
  profileName.value = ''
  profileStatus.textContent = ''
}

function closeProfilePicker(immediate = false) {
  if (profileOverlay.classList.contains('hidden')) return
  const token = ++profileCloseToken
  profileDialogToolId = null
  profileOverlay.classList.add('closing')

  const finish = () => {
    if (token !== profileCloseToken) return
    selectedProfileId = null
    profileList.replaceChildren()
    hideProfileEditor()
    hideProfileSettings()
    profileOverlay.classList.add('hidden')
    profileOverlay.classList.remove('closing')
    if (currentView === 'terminal') terminal?.focus()
    else rows.get(selectedToolId)?.item.focus({ preventScroll: true })
  }

  if (immediate || typeof profileOverlay.animate !== 'function') {
    finish()
    return
  }

  const duration = reducedMotion.matches ? 80 : 100
  const overlayAnimation = profileOverlay.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration, easing: 'ease-in', fill: 'forwards' }
  )
  const cardAnimation = profileCard.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration, easing: 'ease-in', fill: 'forwards' }
  )
  let finalized = false
  const finalizeAnimation = () => {
    if (finalized) return
    finalized = true
    overlayAnimation.cancel()
    cardAnimation.cancel()
    finish()
  }
  const fallbackTimer = setTimeout(finalizeAnimation, duration + 32)
  Promise.allSettled([overlayAnimation.finished, cardAnimation.finished]).then(() => {
    clearTimeout(fallbackTimer)
    finalizeAnimation()
  })
}

async function openProfilePicker(tool, preferredProfileId = null, mode = 'current') {
  profileCloseToken += 1
  for (const animation of profileOverlay.getAnimations({ subtree: true })) animation.cancel()
  profileOverlay.classList.remove('closing')
  profileDialogToolId = tool.id
  profileDialogMode = mode
  profileTitle.textContent = mode === 'new-window' || mode === 'switch'
    ? `NEW ${tool.name.toUpperCase()} WINDOW`
    : `${tool.name.toUpperCase()} PROFILES`
  profileOverlay.classList.remove('hidden')
  hideProfileEditor()
  profileStatus.textContent = 'Loading profiles...'
  try {
    const profiles = await loadProfiles(tool, true)
    selectedProfileId = profiles.some((profile) => profile.id === preferredProfileId)
      ? preferredProfileId
      : (profiles[0]?.id || null)
    renderProfileList(profiles)
    const selected = profiles.find((profile) => profile.id === selectedProfileId)
    if (selected && !selected.installed && !profileInstallStates.get(`${tool.id}:${selected.id}`)?.installing) profileStatus.textContent = 'This profile needs its own CLI installation.'
    profileRows.get(selectedProfileId)?.focus({ preventScroll: true })
  } catch (error) {
    profileStatus.textContent = String(error.message || error)
  }
}

function showProfileEditor(mode) {
  const tool = profileDialogTool()
  if (!tool) return
  const profiles = profilesCache.get(tool.id) || []
  const selected = profiles.find((profile) => profile.id === selectedProfileId)
  if (mode === 'rename' && !selected) return
  hideProfileSettings()
  profileEditorMode = mode
  profileEditorLabel.textContent = mode === 'create' ? 'NEW PROFILE NAME' : 'RENAME PROFILE'
  profileName.value = mode === 'rename' ? selected.name : ''
  profileEditor.classList.remove('hidden')
  if (mode === 'create') {
    profileSettingsDraft = normalizedSettings()
    profileCreateSettings.classList.remove('hidden')
    renderSettingsOptions(profileCreateSettings)
  } else {
    profileCreateSettings.classList.add('hidden')
  }
  profileStatus.textContent = ''
  profileName.focus()
  profileName.select()
}

async function saveProfileEditor() {
  const tool = profileDialogTool()
  if (!tool || !profileEditorMode) return
  const name = profileName.value
  profileSave.disabled = true
  profileStatus.textContent = profileEditorMode === 'create' ? 'Creating profile...' : 'Renaming profile...'
  try {
    const result = profileEditorMode === 'create'
      ? await window.api.createProfile(tool.id, name, profileSettingsDraft)
      : await window.api.renameProfile(tool.id, selectedProfileId, name)
    if (!result?.ok) throw new Error(result?.error || 'Profile could not be saved')
    const profiles = await loadProfiles(tool, true)
    selectedProfileId = result.profile.id
    hideProfileEditor()
    renderProfileList(profiles)
    profileRows.get(selectedProfileId)?.focus({ preventScroll: true })
    const selected = profiles.find((profile) => profile.id === selectedProfileId)
    if (selected && !selected.installed) profileStatus.textContent = 'This profile needs its own CLI installation.'
  } catch (error) {
    profileStatus.textContent = String(error.message || error)
  } finally {
    profileSave.disabled = false
  }
}

async function saveProfileSettings() {
  const tool = profileDialogTool()
  const profile = selectedProfileRecord()
  if (!tool || !profile || !profileSettingsDraft) return
  profileSettingsSave.disabled = true
  profileStatus.textContent = 'Saving profile settings...'
  try {
    const result = await window.api.updateProfileSettings(tool.id, profile.id, profileSettingsDraft)
    if (!result?.ok) throw new Error(result?.error || 'Profile settings could not be saved')
    const profiles = await loadProfiles(tool, true)
    selectedProfileId = result.profile.id
    hideProfileSettings()
    renderProfileList(profiles)
    profileRows.get(selectedProfileId)?.focus({ preventScroll: true })
  } catch (error) {
    profileStatus.textContent = String(error.message || error)
  } finally {
    profileSettingsSave.disabled = false
  }
}

async function deleteSelectedProfile() {
  const tool = profileDialogTool()
  const profile = selectedProfileRecord()
  if (!tool || !profile || profile.id === 'default') return
  if (!profileDeleteArmed) {
    profileDeleteArmed = true
    profileDelete.textContent = 'DELETE AGAIN'
    profileStatus.textContent = 'Press DELETE AGAIN to move this profile to recoverable trash.'
    return
  }
  profileDelete.disabled = true
  try {
    const result = await window.api.deleteProfile(tool.id, profile.id)
    if (!result?.ok) throw new Error(result?.error || 'Profile could not be deleted')
    profilesCache.delete(tool.id)
    const profiles = await loadProfiles(tool, true)
    selectedProfileId = profiles[0]?.id || null
    hideProfileSettings()
    renderProfileList(profiles)
    profileStatus.textContent = 'Profile moved to recoverable trash.'
    profileRows.get(selectedProfileId)?.focus({ preventScroll: true })
  } catch (error) {
    profileDeleteArmed = false
    profileDelete.textContent = 'DELETE'
    profileStatus.textContent = String(error.message || error)
  } finally {
    profileDelete.disabled = false
  }
}

async function openSelectedProfile() {
  const tool = profileDialogTool()
  const profiles = tool ? (profilesCache.get(tool.id) || []) : []
  const profile = profiles.find((candidate) => candidate.id === selectedProfileId)
  if (!tool || !profile) return
  if (profileInstallStates.get(`${tool.id}:${profile.id}`)?.installing) { updateProfileActions(); return }
  if (!profile.installed) {
    await beginProfileInstall()
    return
  }
  const mode = profileDialogMode
  closeProfilePicker(true)
  if (mode === 'new-window' || mode === 'switch') {
    const result = await window.api.openToolWindow(tool.id, profile.id)
    if (!result?.ok) showToast(result?.error || 'The profile window could not be opened.')
  } else {
    await openTerminal(tool, profile)
  }
}

async function beginProfileInstall() {
  const tool = profileDialogTool()
  const profile = selectedProfileRecord()
  if (!tool || !profile || profileInstall.disabled) return
  const key = `${tool.id}:${profile.id}`
  if (profileInstallStates.get(key)?.installing) {
    const result = await window.api.cancelInstall(tool.id, profile.id)
    if (!result?.ok) showToast(result?.error || 'Installer could not be cancelled.')
    return
  }
  profileInstallStates.set(key, { installing: true, percent: 1, line: 'Preparing installer...' })
  updateProfileActions()
  try {
    const result = await window.api.installTool(tool.id, profile.id)
    if (!result?.ok) throw new Error(result?.error || 'Installer could not start.')
  } catch (error) {
    profileInstallStates.set(key, { installing: false, message: String(error.message || error) })
    updateProfileActions()
  }
}

function moveProfileSelection(delta) {
  const tool = profileDialogTool()
  const profiles = tool ? (profilesCache.get(tool.id) || []) : []
  if (!profiles.length) return
  const index = Math.max(0, profiles.findIndex((profile) => profile.id === selectedProfileId))
  setSelectedProfile(profiles[(index + delta + profiles.length) % profiles.length].id, true)
}

function trapProfileFocus(event) {
  if (event.key !== 'Tab') return false
  const focusable = [...profileOverlay.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.classList.contains('hidden') && element.getClientRects().length > 0)
  if (!focusable.length) return false
  const currentIndex = focusable.indexOf(document.activeElement)
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1)
  event.preventDefault()
  focusable[nextIndex].focus({ preventScroll: true })
  return true
}

function setInstallConfirmation(tool, choice = 'yes') {
  const current = stateFor(tool)
  setState(tool.id, {
    state: 'confirm',
    percent: 0,
    confirmChoice: choice === 'no' ? 'no' : 'yes',
    confirmPrompt: current.state === 'failed' ? 'Retry?' : 'Install?',
    confirmReturnState: current.state === 'confirm' ? (current.confirmReturnState || 'missing') : current.state
  })
}

async function resolveInstallConfirmation(tool, choice) {
  if (!tool) return
  if (choice === 'no') {
    const current = stateFor(tool)
    setState(tool.id, {
      state: current.confirmReturnState || 'missing',
      percent: 0,
      confirmChoice: 'yes',
      confirmReturnState: null
    })
    return
  }
  await beginInstall(tool)
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
    await resolveInstallConfirmation(tool, value.confirmChoice || 'yes')
    return
  }
  if (!['ready', 'done'].includes(value.state)) {
    setInstallConfirmation(tool)
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
    await openProfilePicker(tool)
  } else if (result.installable === false) {
    setState(tool.id, { state: 'manual', hint: result.hint || tool.hint })
    showToast(result.hint || tool.hint || 'Manual setup is required.')
  } else {
    setInstallConfirmation(tool)
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
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    fontSize: 15,
    fontWeight: '400',
    fontWeightBold: '700',
    lineHeight: 1.1,
    rescaleOverlappingGlyphs: true,
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none',
    scrollback: 5000,
    smoothScrollDuration: reducedMotion.matches ? 0 : 70,
    theme: {
      scrollbarSliderBackground: '#6f625844',
      scrollbarSliderHoverBackground: '#8b7d7066',
      scrollbarSliderActiveBackground: '#ad9c8999',
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
  terminalEdges = new TerminalEdges(terminal, $('terminal-edges'), viewTerminal)
  terminal.onRender(scheduleTerminalSurfaceSync)
  terminal.onScroll(scheduleTerminalSurfaceSync)
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
    const dimensions = terminal._core?._renderService?.dimensions?.css?.cell
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
      fitAddon.fit()
      return
    }
    const terminalStyle = getComputedStyle(terminal.element)
    const horizontalPadding = parseFloat(terminalStyle.paddingLeft) + parseFloat(terminalStyle.paddingRight)
    const verticalPadding = parseFloat(terminalStyle.paddingTop) + parseFloat(terminalStyle.paddingBottom)
    const cols = Math.max(11, Math.floor((termContainer.clientWidth - horizontalPadding - 8) / dimensions.width))
    const rowsCount = Math.max(6, Math.floor((termContainer.clientHeight - verticalPadding) / dimensions.height))
    if (terminal.cols !== cols || terminal.rows !== rowsCount) terminal.resize(cols, rowsCount)
    const pixelWidth = Math.max(1, Math.round(cols * dimensions.width))
    const pixelHeight = Math.max(1, Math.round(rowsCount * dimensions.height))
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
  terminalEdges?.clear()
  terminal.reset()
  terminal.clear()
  terminal.refresh(0, Math.max(0, terminal.rows - 1))
}

function applyTerminalSurface(tool) {
  const background = tool.terminalBackground || '#000000'
  terminalSurfaceColor = background
  paintTerminalSurface(background)
  if (terminal) {
    terminal.options.theme = {
      ...terminal.options.theme,
      background,
      black: background,
      cursor: terminalCursorVisible ? '#ff6a27' : background,
      cursorAccent: background
    }
  }
}

function paintTerminalSurface(background) {
  document.documentElement.style.setProperty('--terminal-bg', background)
  viewTerminal.style.backgroundColor = background
  termContainer.style.backgroundColor = background
  if (terminal?.element) terminal.element.style.backgroundColor = background
  const viewport = termContainer.querySelector('.xterm-viewport')
  if (viewport) viewport.style.backgroundColor = background
}

function paintTerminalEdges() {
  terminalSurfaceTimer = null
  if (currentView === 'terminal') terminalEdges?.paint()
}

function scheduleTerminalSurfaceSync() {
  if (terminalSurfaceTimer === null) terminalSurfaceTimer = requestAnimationFrame(paintTerminalEdges)
}

function revealTerminalCursor() {
  if (!terminal || terminalCursorVisible) return
  terminalCursorVisible = true
  terminal.options.theme = {
    ...terminal.options.theme,
    cursor: '#ff6a27',
    cursorAccent: terminalSurfaceColor
  }
}

function terminalDataHasVisibleText(data) {
  return String(data || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x20\x7f-\x9f]/g, '')
    .length > 0
}

function fitBrandTitle() {
  brandFitFrame = 0
  if (currentView !== 'list') return
  const stageWidth = brandStage.clientWidth
  const stageHeight = brandStage.clientHeight
  if (stageWidth <= 0 || stageHeight <= 0) return
  const stageKey = `${stageWidth}x${stageHeight}`
  if (stageKey === lastBrandStageKey) return
  lastBrandStageKey = stageKey
  const stageStyle = getComputedStyle(brandStage)
  const contentWidth = Math.max(1, stageWidth - parseFloat(stageStyle.paddingLeft) - parseFloat(stageStyle.paddingRight))
  const contentHeight = Math.max(1, stageHeight - parseFloat(stageStyle.paddingTop) - parseFloat(stageStyle.paddingBottom))
  const fitKey = `${contentWidth.toFixed(1)}x${contentHeight.toFixed(1)}`
  if (fitKey === lastBrandFitKey) return
  lastBrandFitKey = fitKey

  if (!brandNaturalWidth || !brandNaturalHeight) {
    brandTitle.style.fontSize = '24px'
    brandNaturalWidth = Math.max(1, brandTitle.offsetWidth)
    brandNaturalHeight = Math.max(1, brandTitle.offsetHeight)
  }

  const widthScale = (contentWidth * 0.98) / brandNaturalWidth
  const heightScale = (contentHeight * 0.9) / brandNaturalHeight
  const fontSize = Math.max(6, Math.min(72, 24 * Math.min(widthScale, heightScale)))
  brandTitle.style.fontSize = `${fontSize.toFixed(2)}px`
}

function scheduleBrandFit() {
  if (!brandFitFrame) brandFitFrame = requestAnimationFrame(fitBrandTitle)
}

async function openTerminal(tool, profile = { id: 'default', name: 'Default' }) {
  const launchToken = ++terminalLaunchToken
  activeToolId = tool.id
  activeProfileId = profile.id
  activeProfileName = profile.name
  activeSessionId = null
  terminalExited = false
  terminalCursorVisible = false
  clearTimeout(terminalCursorTimer)
  terminalCursorTimer = null
  cancelAnimationFrame(terminalSurfaceTimer)
  terminalSurfaceTimer = null
  showView('terminal')
  initTerminal()
  terminal.blur()
  applyTerminalSurface(tool)
  clearTerminalSurface()

  fitTerminal()
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (launchToken !== terminalLaunchToken) return
  fitTerminal()

  let result
  try {
    result = await window.api.terminalStart(
      tool.id,
      profile.id,
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
    terminal.writeln('\x1b[38;2;255;100;39mPress Enter to retry or use right-click Close CLI.\x1b[0m')
    return
  }
  if (terminalExited) return
  activeSessionId = result.sessionId
  terminalCursorTimer = setTimeout(revealTerminalCursor, 1000)
  scheduleFit()
  requestAnimationFrame(scheduleFit)
  terminal.focus()
}

async function leaveTerminal() {
  terminalLaunchToken += 1
  activeSessionId = null
  terminalExited = false
  clearTimeout(terminalCursorTimer)
  terminalCursorTimer = null
  cancelAnimationFrame(terminalSurfaceTimer)
  terminalSurfaceTimer = null
  const stop = window.api.terminalStop()
  if (isAuxiliaryWindow) {
    window.api.closeWindow()
    return
  }
  const transition = showView('list')
  await Promise.allSettled([stop, transition])
  clearTerminalSurface()
  queueRows()
  queueCarousel(true)
  rows.get(selectedToolId)?.item.focus({ preventScroll: true })
}

function restartTerminal() {
  const tool = getTool(activeToolId)
  if (tool) openTerminal(tool, { id: activeProfileId, name: activeProfileName })
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
  let visibilityAnimation = null
  window.api.onWindowVisibility(({ phase }) => {
    visibilityAnimation?.cancel()
    const panel = $('panel')
    const hidden = reducedMotion.matches ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px) scale(0.988)' }
    const visible = { opacity: 1, transform: 'none' }
    const animation = panel.animate(phase === 'show' ? [hidden, visible] : [visible, hidden], {
      duration: phase === 'show' ? 170 : 130, easing: 'cubic-bezier(0.2, 0.75, 0.2, 1)', fill: 'forwards'
    })
    visibilityAnimation = animation
    animation.finished.then(() => {
      if (phase === 'show' && visibilityAnimation === animation) { animation.cancel(); visibilityAnimation = null; scheduleFit(); scheduleTerminalSurfaceSync() }
    }).catch(() => {})
  })
  window.api.onInstallProgress((data) => {
    const profileId = data.profileId || 'default'
    profileInstallStates.set(`${data.toolId}:${profileId}`, { ...data, installing: true })
    if (profileDialogToolId === data.toolId && selectedProfileId === profileId) updateProfileActions()
    if (profileId !== 'default') return
    pendingProgress.set(data.toolId, data)
    if (!progressFrame) progressFrame = requestAnimationFrame(flushProgressEvents)
  })

  window.api.onInstallDone((data) => {
    const profileId = data.profileId || 'default'
    const profiles = profilesCache.get(data.toolId) || []
    const profile = profiles.find((candidate) => candidate.id === profileId)
    if (profile) {
      if (data.ok) profile.installed = true
      profile.installing = false
    }
    profileInstallStates.set(`${data.toolId}:${profileId}`, {
      installing: false,
      message: data.ok ? 'CLI ready. Select a profile to open it.'
        : (data.cancelled ? 'Installation cancelled.' : (data.error || 'Installation failed.'))
    })
    if (profileDialogToolId === data.toolId) renderProfileList(profiles)
    const tool = getTool(data.toolId)
    if (!tool) return
    if (profileId === 'default') {
      pendingProgress.delete(data.toolId)
      if (data.manual) setState(data.toolId, { state: 'manual', hint: data.hint, logAvailable: data.logAvailable })
      else if (data.ok || data.installed) setState(data.toolId, { state: 'ready', percent: 100, err: data.error || '', logAvailable: data.logAvailable })
      else setState(data.toolId, { state: 'failed', cancelled: data.cancelled, err: data.error || 'Installation failed.', logAvailable: data.logAvailable })
    }
    showToast(data.ok ? `${tool.name} is ready.` : (data.cancelled ? `${tool.name} installation cancelled.` : `${tool.name}: ${data.error || 'Installation failed.'}`))
  })

  window.api.onPtyData(({ sessionId, data }) => {
    if (!terminal || currentView !== 'terminal') return
    if (activeSessionId === null) activeSessionId = sessionId
    if (sessionId === activeSessionId) {
      terminal.write(data, scheduleTerminalSurfaceSync)
      if (!terminalCursorVisible && terminalDataHasVisibleText(data)) {
        clearTimeout(terminalCursorTimer)
        terminalCursorTimer = setTimeout(revealTerminalCursor, 80)
      }
    }
  })

  window.api.onPtyExit(({ sessionId, exitCode }) => {
    if (!terminal || currentView !== 'terminal') return
    if (activeSessionId !== null && sessionId !== activeSessionId) return
    activeSessionId = null
    terminalExited = true
    clearTimeout(terminalCursorTimer)
    terminalCursorTimer = null
    const closeHint = isAuxiliaryWindow ? 'right-click Close window' : 'right-click Close CLI'
    terminal.write(
      `\r\n\x1b[38;2;255;100;39m[Session ended / exit ${exitCode}]\x1b[0m\r\n` +
      `\x1b[90mPress Enter to restart or ${closeHint}.\x1b[0m\r\n`,
      scheduleTerminalSurfaceSync
    )
  })
}

function hideContextMenu() {
  clearTimeout(submenuCloseTimer)
  closeSubmenu()
  if (ctxMenu.classList.contains('hidden')) return
  contextCloseAnimation?.cancel()
  if (typeof ctxMenu.animate !== 'function') {
    ctxMenu.classList.add('hidden')
    return
  }
  const animation = ctxMenu.animate(
    reducedMotion.matches
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-2px)' }],
    { duration: reducedMotion.matches ? 70 : 85, easing: 'ease-in', fill: 'forwards' }
  )
  contextCloseAnimation = animation
  animation.finished.catch(() => {}).then(() => {
    if (contextCloseAnimation !== animation) return
    ctxMenu.classList.add('hidden')
    animation.cancel()
    contextCloseAnimation = null
  })
}

function openSubmenu() {
  clearTimeout(submenuCloseTimer)
  ctxOpenOther.classList.add('submenu-open')
  ctxOpenOther.setAttribute('aria-expanded', 'true')
  ctxSubMenu.classList.remove('hidden')
  const parent = ctxOpenOther.getBoundingClientRect()
  ctxSubMenu.style.maxHeight = `${Math.max(1, window.innerHeight - 16)}px`
  const width = ctxSubMenu.offsetWidth
  const height = ctxSubMenu.offsetHeight
  const preferredLeft = parent.right + width + 13 <= window.innerWidth
    ? parent.right + 5
    : parent.left - width - 5
  const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(parent.top - 6, window.innerHeight - height - 8))
  ctxSubMenu.style.left = `${left}px`
  ctxSubMenu.style.right = 'auto'
  ctxSubMenu.style.top = `${top}px`
}

function closeSubmenu() {
  clearTimeout(submenuCloseTimer)
  ctxOpenOther.classList.remove('submenu-open')
  ctxOpenOther.setAttribute('aria-expanded', 'false')
  ctxSubMenu.classList.add('hidden')
}

function scheduleSubmenuClose() {
  clearTimeout(submenuCloseTimer)
  submenuCloseTimer = setTimeout(() => {
    closeSubmenu()
  }, 90)
}

function contextTool() {
  return currentView === 'terminal' ? getTool(activeToolId) : selectedTool()
}

function populateSubmenu() {
  if (submenuRows.size !== tools.length) {
    submenuRows.clear()
    const fragment = document.createDocumentFragment()
    for (const tool of tools) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'sub-item'
      item.dataset.toolId = tool.id
      const name = document.createElement('span')
      name.textContent = tool.name
      item.append(name)
      submenuRows.set(tool.id, item)
      fragment.appendChild(item)
    }
    ctxSubMenu.replaceChildren(fragment)
  }

}

function showContextMenu(x, y) {
  const tool = contextTool()
  const value = tool ? stateFor(tool) : null
  const installing = value?.state === 'installing'
  const terminalContext = currentView === 'terminal' && Boolean(tool)
  ctxNewCurrent.classList.toggle('hidden', !tool)
  ctxNewCurrentLabel.textContent = tool
    ? (currentView === 'terminal'
        ? `New Window · ${activeProfileName}`
        : `Profiles · ${tool.name}`)
    : 'New Window'
  ctxRestart.classList.toggle('hidden', currentView !== 'terminal')
  ctxOpenOther.classList.toggle('hidden', currentView !== 'terminal')
  ctxInstall.classList.toggle('hidden', !tool || tool.installable === false || installing || currentView === 'terminal')
  ctxInstallLabel.textContent = ['ready', 'done'].includes(value?.state) ? 'Update' : 'Install'
  ctxCancelInstall.classList.toggle('hidden', !tool || !installing)
  ctxOpenLog.classList.toggle('hidden', !tool || value?.state !== 'failed' || !value?.logAvailable)
  ctxCopy.classList.toggle('hidden', currentView !== 'terminal' || !terminal?.hasSelection())
  ctxClose.textContent = terminalContext ? `Close ${tool.name}` : 'Close OmniShell'
  ctxClose.classList.toggle('menu-session-close', terminalContext)
  ctxClose.classList.toggle('menu-danger', !terminalContext)
  if (currentView === 'terminal') populateSubmenu()
  closeSubmenu()
  contextCloseAnimation?.cancel()
  contextCloseAnimation = null
  ctxMenu.classList.remove('hidden')

  ctxMenu.style.maxHeight = `${Math.max(1, window.innerHeight - 16)}px`
  const menuWidth = ctxMenu.offsetWidth
  const menuHeight = ctxMenu.offsetHeight || 230
  const submenuWidth = 220
  ctxMenu.classList.toggle('open-left', x + menuWidth + submenuWidth + 16 > window.innerWidth)
  ctxMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8))}px`
  ctxMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8))}px`
}

function setupContextMenu() {
  // Keep the submenu outside clipped or transformed parent elements.
  document.body.append(ctxSubMenu)
  ctxSubMenu.classList.add('hidden')
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const row = event.target.closest?.('[data-tool-id]')
    if (currentView === 'list' && row?.dataset.toolId) selectTool(row.dataset.toolId)
    showContextMenu(event.clientX, event.clientY)
  })
  window.addEventListener('pointerdown', (event) => {
    if (!ctxMenu.contains(event.target) && !ctxSubMenu.contains(event.target)) hideContextMenu()
  })
  ctxOpenOther.addEventListener('pointerenter', openSubmenu)
  ctxOpenOther.addEventListener('pointerleave', (event) => {
    if (!ctxSubMenu.contains(event.relatedTarget)) scheduleSubmenuClose()
  })
  ctxSubMenu.addEventListener('pointerenter', openSubmenu)
  ctxSubMenu.addEventListener('pointerleave', (event) => {
    if (!ctxOpenOther.contains(event.relatedTarget)) scheduleSubmenuClose()
  })
  ctxOpenOther.addEventListener('click', (event) => {
    event.stopPropagation()
    openSubmenu()
  })
  ctxOpenOther.addEventListener('keydown', (event) => {
    if (event.target !== ctxOpenOther || !['Enter', ' ', 'ArrowRight', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    openSubmenu()
    ctxSubMenu.querySelector('.sub-item:not(.hidden)')?.focus()
  })
  ctxSubMenu.addEventListener('click', (event) => {
    const item = event.target.closest('.sub-item')
    if (!item) return
    event.stopPropagation()
    hideContextMenu()
    const tool = getTool(item.dataset.toolId)
    if (tool) openProfilePicker(tool, null, 'switch')
  })
  ctxNewCurrent.addEventListener('click', () => {
    const tool = contextTool()
    const terminalContext = currentView === 'terminal'
    hideContextMenu()
    if (tool) {
      openProfilePicker(tool, terminalContext ? activeProfileId : null, terminalContext ? 'new-window' : 'current')
    }
  })
  ctxRestart.addEventListener('click', () => { hideContextMenu(); restartTerminal() })
  ctxInstall.addEventListener('click', () => { const tool = contextTool(); hideContextMenu(); beginInstall(tool) })
  ctxCancelInstall.addEventListener('click', () => { const tool = contextTool(); hideContextMenu(); cancelInstall(tool) })
  ctxOpenLog.addEventListener('click', () => { const tool = contextTool(); hideContextMenu(); openInstallLog(tool) })
  ctxCopy.addEventListener('click', () => { hideContextMenu(); copyTerminalSelection() })
  ctxMinimize.addEventListener('click', () => { hideContextMenu(); window.api.minimizeWindow() })
  ctxClose.addEventListener('click', () => {
    const closeSession = currentView === 'terminal'
    hideContextMenu()
    if (closeSession) leaveTerminal()
    else window.api.closeWindow()
  })
}

function setupProfileControls() {
  profileList.addEventListener('pointerover', (event) => {
    const row = event.target.closest('.profile-row')
    if (row) setSelectedProfile(row.dataset.profileId)
  })
  profileList.addEventListener('click', (event) => {
    const row = event.target.closest('.profile-row')
    if (!row) return
    setSelectedProfile(row.dataset.profileId)
    openSelectedProfile()
  })
  profileNew.addEventListener('click', () => showProfileEditor('create'))
  profileRename.addEventListener('click', () => showProfileEditor('rename'))
  profileSettingsOpen.addEventListener('click', showProfileSettings)
  profileInstall.addEventListener('click', beginProfileInstall)
  profileSave.addEventListener('click', saveProfileEditor)
  profileCancel.addEventListener('click', hideProfileEditor)
  profileCreateSettings.addEventListener('click', toggleProfileSetting)
  profileSettingsOptions.addEventListener('click', toggleProfileSetting)
  profileSettingsSave.addEventListener('click', saveProfileSettings)
  profileSettingsCancel.addEventListener('click', hideProfileSettings)
  profileDelete.addEventListener('click', deleteSelectedProfile)
  profileOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === profileOverlay) closeProfilePicker()
  })
}

function flushWindowResize() {
  resizeFrame = 0
  if (!pendingResizeBounds) return
  window.api.setWindowBounds(pendingResizeBounds)
  pendingResizeBounds = null
}

function setupResizeControls() {
  for (const handle of document.querySelectorAll('[data-resize]')) {
    handle.addEventListener('pointerdown', async (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const state = {
        edge: handle.dataset.resize,
        pointerId: event.pointerId,
        startX: event.screenX,
        startY: event.screenY,
        bounds: null,
        handle
      }
      resizeState = state
      handle.setPointerCapture(event.pointerId)
      const bounds = await window.api.windowBounds()
      if (resizeState === state && bounds) state.bounds = bounds
    })
  }

  window.addEventListener('pointermove', (event) => {
    const state = resizeState
    if (!state?.bounds || event.pointerId !== state.pointerId) return
    const deltaX = event.screenX - state.startX
    const deltaY = event.screenY - state.startY
    let { x, y, width, height } = state.bounds
    if (state.edge.includes('e')) width = Math.max(480, width + deltaX)
    if (state.edge.includes('s')) height = Math.max(340, height + deltaY)
    if (state.edge.includes('w')) {
      const nextWidth = Math.max(480, width - deltaX)
      x += width - nextWidth
      width = nextWidth
    }
    if (state.edge.includes('n')) {
      const nextHeight = Math.max(340, height - deltaY)
      y += height - nextHeight
      height = nextHeight
    }
    pendingResizeBounds = { x, y, width, height }
    if (!resizeFrame) resizeFrame = requestAnimationFrame(flushWindowResize)
  }, { passive: true })

  const endResize = (event) => {
    if (!resizeState || event.pointerId !== resizeState.pointerId) return
    if (resizeFrame) cancelAnimationFrame(resizeFrame)
    flushWindowResize()
    try { resizeState.handle.releasePointerCapture(event.pointerId) } catch (error) {}
    resizeState = null
  }
  window.addEventListener('pointerup', endResize)
  window.addEventListener('pointercancel', endResize)
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
    if (!tool) return
    const confirmation = event.target.closest('[data-confirm]')
    if (confirmation) {
      event.stopPropagation()
      resolveInstallConfirmation(tool, confirmation.dataset.confirm)
      return
    }
    activateTool(tool)
  })

  window.addEventListener('keydown', (event) => {
    if (!profileOverlay.classList.contains('hidden')) {
      if (trapProfileFocus(event)) return
      if (!profileSettings.classList.contains('hidden')) {
        if (event.key === 'Escape') { event.preventDefault(); hideProfileSettings() }
        return
      }
      if (!profileEditor.classList.contains('hidden')) {
        if (event.key === 'Enter' && !event.target.closest('[data-setting]')) { event.preventDefault(); saveProfileEditor() }
        else if (event.key === 'Escape') { event.preventDefault(); hideProfileEditor() }
        return
      }
      if (event.key === 'Escape') { event.preventDefault(); closeProfilePicker() }
      else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') { event.preventDefault(); moveProfileSelection(-1) }
      else if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') { event.preventDefault(); moveProfileSelection(1) }
      else if (event.key === 'Enter') { event.preventDefault(); openSelectedProfile() }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); showProfileEditor('create') }
      else if (event.key.toLowerCase() === 'r') { event.preventDefault(); showProfileEditor('rename') }
      else if (event.key.toLowerCase() === 's') { event.preventDefault(); showProfileSettings() }
      else if (event.key.toLowerCase() === 'i') { event.preventDefault(); beginProfileInstall() }
      return
    }
    if (!ctxMenu.classList.contains('hidden') && event.key === 'Escape') {
      event.preventDefault()
      hideContextMenu()
      return
    }
    if (currentView === 'terminal') {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        event.stopPropagation()
        pasteClipboard()
      } else if (modifier && event.key.toLowerCase() === 'c' && (event.shiftKey || terminal?.hasSelection())) {
        event.preventDefault()
        event.stopPropagation()
        copyTerminalSelection()
      }
      return
    }
    const selected = selectedTool()
    if (selected && stateFor(selected).state === 'confirm') {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const choice = event.key === 'ArrowLeft' ? 'yes' : 'no'
        setInstallConfirmation(selected, choice)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        resolveInstallConfirmation(selected, 'no')
        return
      }
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(-1, 0) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveSelection(1, 0) }
    else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') { event.preventDefault(); moveSelection(0, -1) }
    else if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') { event.preventDefault(); moveSelection(0, 1) }
    else if (event.key === 'Enter') { event.preventDefault(); activateTool(selectedTool()) }
    else if (event.key.toLowerCase() === 'u') { event.preventDefault(); beginInstall(selectedTool()) }
  }, { capture: true })
}

;(async function init() {
  setupIpcListeners()
  setupContextMenu()
  setupProfileControls()
  setupResizeControls()
  setupControls()
  window.addEventListener('resize', () => {
    scheduleFit()
    scheduleBrandFit()
    if (!ctxMenu.classList.contains('hidden')) {
      const wasOpen = ctxOpenOther.classList.contains('submenu-open')
      showContextMenu(parseFloat(ctxMenu.style.left) || 8, parseFloat(ctxMenu.style.top) || 8)
      if (wasOpen) openSubmenu()
    }
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
  brandNaturalWidth = 0
  brandNaturalHeight = 0
  lastBrandFitKey = ''
  lastBrandStageKey = ''
  fitBrandTitle()

  bootScreen.classList.add('ready')
  setTimeout(() => bootScreen.classList.add('hidden'), 200)

  const initialContext = await window.api.getInitialContext()
  isAuxiliaryWindow = Boolean(initialContext?.auxiliary)
  const initialTool = getTool(initialContext?.toolId)
  if (initialTool) {
    selectTool(initialTool.id)
    if (initialContext.profileId) {
      const profiles = await loadProfiles(initialTool)
      const profile = profiles.find((candidate) => candidate.id === initialContext.profileId)
      if (profile) await openTerminal(initialTool, profile)
      else await openProfilePicker(initialTool)
    } else {
      activateTool(initialTool)
    }
  }
})().catch((error) => {
  deckStatus.textContent = `BOOT ERROR / ${String(error.message || error).toUpperCase()}`
  bootScreen.classList.add('hidden')
})
