import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { getEditionByDate, openDb } from './db'
import { localDate } from './edition'
import { prefetchThreads } from './thread'
import { snapshotIfStale } from './backup'
import { registerIpc } from './ipc'
import { applyProxy, XBrowser } from './x/browser'
import { startScheduler } from './scheduler'
import { runSmoke } from './smoke'
import { loadSettings } from './settings'

app.setName('filtered-twitter')
app.setPath('userData', join(app.getPath('appData'), 'filtered-twitter'))

let mainWindow: BrowserWindow | null = null
let browser: XBrowser

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    appendFileSync(join(app.getPath('userData'), 'app.log'), line)
  } catch {
    /* ignore */
  }
  if (!app.isPackaged) process.stdout.write(line)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 500,
    title: 'Filtered Twitter',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#f6f4ef',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  // Present as a normal Chrome to x.com
  app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ filtered-twitter\/\S+/, '')
  openDb()
  await applyProxy(loadSettings().proxyUrl, log)
  browser = new XBrowser(log)
  registerIpc(browser, () => mainWindow, log)
  createWindow()
  startScheduler(browser, log)
  snapshotIfStale(log)
  // Warm today's discussions so opening one is instant; a little later, so the session check goes first.
  setTimeout(() => {
    const today = getEditionByDate(localDate(new Date()))
    if (today) void prefetchThreads(browser, today.items.filter((x) => x.tweet.replies > 0 || x.tweet.inReplyToId).map((x) => x.tweet.id), log)
  }, 15_000)
  if (process.env.FT_SMOKE) setTimeout(() => void runSmoke(browser, log), 1500)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
app.on('before-quit', () => browser?.close())
