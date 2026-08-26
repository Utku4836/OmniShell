const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

function createIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(images.length * 16)
  let offset = header.length + entries.length
  images.forEach(({ size, data }, index) => {
    const position = index * 16
    entries.writeUInt8(size >= 256 ? 0 : size, position)
    entries.writeUInt8(size >= 256 ? 0 : size, position + 1)
    entries.writeUInt8(0, position + 2)
    entries.writeUInt8(0, position + 3)
    entries.writeUInt16LE(1, position + 4)
    entries.writeUInt16LE(32, position + 6)
    entries.writeUInt32LE(data.length, position + 8)
    entries.writeUInt32LE(offset, position + 12)
    offset += data.length
  })

  return Buffer.concat([header, entries, ...images.map(({ data }) => data)])
}

app.whenReady().then(async () => {
  const assetDirectory = path.join(__dirname, '..', 'assets')
  const source = path.join(assetDirectory, 'omnishell-icon.svg')
  const renderWindow = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: true,
    frame: false,
    opacity: 0.01,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, backgroundThrottling: false }
  })
  await renderWindow.loadFile(source)
  await renderWindow.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )

  let vector = null
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      vector = await renderWindow.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
      if (!vector.isEmpty()) break
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 140))
  }
  renderWindow.destroy()
  if (!vector || vector.isEmpty()) throw new Error(`Could not render ${source}: ${lastError?.message || 'empty image'}`)

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map((size) => ({
    size,
    data: vector.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))

  fs.writeFileSync(path.join(assetDirectory, 'omnishell.png'), vector.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
  fs.writeFileSync(path.join(assetDirectory, 'omnishell-tray.png'), images.find(({ size }) => size === 32).data)
  fs.writeFileSync(path.join(assetDirectory, 'omnishell.ico'), createIco(images))
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
