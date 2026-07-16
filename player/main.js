// 6Signage Player — processo principal do Electron
// 1ª execução: abre o assistente de configuração (servidor + nome da tela).
// Execuções seguintes: abre direto o player em modo kiosk fullscreen.
// Atalhos: Ctrl+Shift+S = reconfigurar · Ctrl+Shift+Q = sair
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// Config: lê primeiro config.json ao lado do executável (implantação em massa),
// senão o config salvo pelo assistente em userData (sempre gravável).
const EXE_CONFIG = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, 'config.json');
const USER_CONFIG = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  for (const p of [EXE_CONFIG, USER_CONFIG()]) {
    try {
      if (fs.existsSync(p)) {
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (c.server) return c;
      }
    } catch { /* arquivo inválido: ignora e cai no assistente */ }
  }
  return null;
}

const KEY_PATH = () => path.join(app.getPath('userData'), 'device_key.txt');
function getDeviceKey() {
  const p = KEY_PATH();
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const key = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, key);
  return key;
}

let config = null;
let mainWin = null;
let setupWin = null;

// ---------- IPC ----------
ipcMain.handle('get-config', () => ({
  server: config ? config.server : '',
  deviceKey: getDeviceKey(),
  deviceName: (config && config.device_name) || os.hostname(),
  hostname: os.hostname()
}));

ipcMain.handle('test-server', async (ev, url) => {
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/api/health', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return { ok: r.ok && j.app === '6signage', version: j.version || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-config', (ev, newCfg) => {
  const cfg = { server: newCfg.server.replace(/\/+$/, ''), device_name: newCfg.device_name };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(USER_CONFIG(), JSON.stringify(cfg, null, 2));
  app.relaunch();
  app.exit(0);
});

const CACHE_DIR = () => {
  const d = path.join(app.getPath('userData'), 'cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

ipcMain.handle('cache-media', async (ev, { url, checksum }) => {
  const dest = path.join(CACHE_DIR(), checksum + path.extname(url));
  if (fs.existsSync(dest)) return 'file://' + dest;
  const res = await fetch(config.server + url);
  if (!res.ok) throw new Error('Falha ao baixar ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (checksum && hash !== checksum) throw new Error('Checksum inválido: ' + url);
  fs.writeFileSync(dest, buf);
  return 'file://' + dest;
});

// ---------- Janelas ----------
function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 460, height: 620, resizable: false,
    backgroundColor: '#0B0E14',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  setupWin.loadFile('setup.html');
}

function openPlayer() {
  const { width, height } = screen.getPrimaryDisplay().size;
  mainWin = new BrowserWindow({
    width, height, fullscreen: true, frame: false, kiosk: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false // permite file:// do cache local
    }
  });
  mainWin.loadFile('player.html');
  mainWin.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  config = loadConfig();
  globalShortcut.register('CommandOrControl+Shift+S', openSetup);
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.exit(0));
  if (config) openPlayer(); else openSetup();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
