// build/icon.svg dosyasından uygulama ikonlarını üretir (Electron ile, ek araç gerektirmez):
//   build/icon.png      512x512   Windows ve Linux
//   build/icon-mac.png  1024x1024 macOS (Apple ölçüsü: kenarlarda boşluk ve hafif gölge)
// Kullanım: npm run icon
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, BrowserWindow } = require('electron')

const root = path.join(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8')

// Tek pencere kullanılır: ikinci bir ekran dışı pencere bazı sistemlerde sayfa yükleyemiyor
async function render(win, size, inner, out, shadow) {
  const pad = (size - inner) / 2
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;overflow:hidden;background:transparent}
    svg{display:block;width:${inner}px;height:${inner}px;margin:${pad}px;${shadow ? 'filter:drop-shadow(0 12px 22px rgba(0,0,0,.28))' : ''}}
  </style></head><body>${svg}</body></html>`
  const tmp = path.join(os.tmpdir(), `rowly-icon-${size}.html`)
  fs.writeFileSync(tmp, html)
  await win.loadFile(tmp)
  fs.rmSync(tmp, { force: true })
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  fs.writeFileSync(path.join(root, 'build', out), img.resize({ width: size, height: size }).toPNG())
  console.log('yazıldı:', out, img.getSize())
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  await render(win, 1024, 824, 'icon-mac.png', true)
  await render(win, 512, 512, 'icon.png', false)
  app.quit()
})
