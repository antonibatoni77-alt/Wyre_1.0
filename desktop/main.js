// Wyre desktop shell for Windows (Electron).
//
// Responsibilities: window + tray, autostart, system notifications support,
// silent offline behaviour (never an error page — a calm splash plus silent
// reconnect), file logging, permissions for calls, and OS-level remote control
// input injection. All messenger logic stays in the web app served by the
// Wyre server.
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, session, desktopCapturer, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const logger = require('./logger');
const osControl = require('./os-control');

const startedHidden = process.argv.includes('--hidden');
const devMode = process.argv.includes('--dev');

const DEFAULT_CONFIG = {
  serverUrl: '',
  autostart: false,
  closeToTray: true,
  allowSelfSigned: false,
};

let config = { ...DEFAULT_CONFIG };
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let reconnectTimer = null;
let appOnline = false;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function normalizedServerUrl(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function iconPath() {
  // Packaged builds keep the icon in resources/ (outside app.asar); in dev it
  // sits next to the sources.
  if (app.isPackaged && process.resourcesPath) return path.join(process.resourcesPath, 'icon.png');
  return path.join(__dirname, 'build', 'icon.png');
}

function applyAutostart() {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(config.autostart), args: ['--hidden'] });
  } catch (error) {
    logger.warn(`Не удалось изменить автозапуск: ${error.message}`);
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function stopReconnect() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !config.serverUrl) return;
  reconnectTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return stopReconnect();
    logger.info(`Повторное подключение к ${config.serverUrl}`);
    mainWindow.loadURL(config.serverUrl).catch(() => undefined);
  }, 4000);
}

function loadApp() {
  if (!config.serverUrl) {
    openSettings();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => undefined);
    return;
  }
  mainWindow.loadURL(config.serverUrl).catch(() => undefined);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: '#0b0c12',
    show: !startedHidden,
    autoHideMenuBar: true,
    title: 'Wyre',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (config.closeToTray && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // The offline contract: never show the browser "site unavailable" page.
  // A calm splash is shown instead and the server is retried silently;
  // the web app itself restores its last state from the service worker
  // and the persisted query cache.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || mainWindow.isDestroyed()) return;
    if (validatedURL.startsWith('file://')) return;
    if (appOnline) logger.warn(`Соединение с сервером потеряно (${errorDescription}, код ${errorCode}). Пытаемся молча восстановить.`);
    appOnline = false;
    mainWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => undefined);
    scheduleReconnect();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (config.serverUrl && url.startsWith(config.serverUrl)) {
      appOnline = true;
      stopReconnect();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  loadApp();
}

function createTray() {
  try {
    tray = new Tray(iconPath());
  } catch (error) {
    logger.warn(`Не удалось создать значок в трее: ${error.message}`);
    return;
  }
  tray.setToolTip('Wyre');
  const updateMenu = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Wyre', click: showMainWindow },
      { label: 'Настройки', click: () => openSettings() },
      { type: 'separator' },
      { label: 'Выйти', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };
  updateMenu();
  tray.on('click', showMainWindow);
  return updateMenu;
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    maximizable: false,
    backgroundColor: '#0b0c12',
    title: 'Настройки Wyre',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html')).catch(() => undefined);
}

function registerIpc() {
  ipcMain.handle('config:get', () => ({ ...config }));
  ipcMain.handle('config:set', (_event, patch) => {
    const previousUrl = config.serverUrl;
    if (patch.serverUrl !== undefined) config.serverUrl = normalizedServerUrl(patch.serverUrl);
    if (patch.autostart !== undefined) config.autostart = Boolean(patch.autostart);
    if (patch.closeToTray !== undefined) config.closeToTray = Boolean(patch.closeToTray);
    if (patch.allowSelfSigned !== undefined) config.allowSelfSigned = Boolean(patch.allowSelfSigned);
    saveConfig();
    applyAutostart();
    applyCertificatePolicy();
    if (mainWindow && !mainWindow.isDestroyed() && config.serverUrl && config.serverUrl !== previousUrl) {
      loadApp();
    }
    return { ...config };
  });
  ipcMain.on('app:open-settings', () => openSettings());
  ipcMain.on('app:open-logs', () => {
    const dir = logger.dir();
    if (dir) fs.mkdirSync(dir, { recursive: true });
    if (dir) void shell.openPath(dir);
  });
  ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.on('log', (_event, level, line) => {
    const safeLevel = ['INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO';
    logger[safeLevel.toLowerCase() === 'error' ? 'error' : safeLevel.toLowerCase() === 'warn' ? 'warn' : 'info'](`[renderer] ${line}`);
  });
  ipcMain.handle('os-control:available', () => osControl.available());
  // Remote-control events arrive as a fast stream. Pointer moves coalesce
  // (latest wins) so nut-js never builds a laggy backlog; clicks and keys keep
  // their order and flush the newest pending position first.
  const controlQueue = { pendingMove: null, chain: Promise.resolve() };
  ipcMain.handle('os-control:event', (_event, input) => {
    if (!input || typeof input !== 'object') return false;
    const bounds = screen.getPrimaryDisplay().bounds;
    const boundsArg = { width: bounds.width, height: bounds.height };
    if (input.type === 'pointer_move') {
      controlQueue.pendingMove = input;
      controlQueue.chain = controlQueue.chain.then(async () => {
        const move = controlQueue.pendingMove;
        if (!move) return;
        controlQueue.pendingMove = null;
        await osControl.inject(move, boundsArg).catch(() => undefined);
      });
      return Promise.resolve(true);
    }
    controlQueue.chain = controlQueue.chain.then(async () => {
      const move = controlQueue.pendingMove;
      if (move) {
        controlQueue.pendingMove = null;
        await osControl.inject(move, boundsArg).catch(() => undefined);
      }
      return osControl.inject(input, boundsArg);
    }).catch((error) => {
      logger.warn(`Ошибка управления ОС: ${error.message}`);
      return false;
    });
    return controlQueue.chain;
  });
}

function applyCertificatePolicy() {
  try {
    if (config.allowSelfSigned) {
      // Local development servers use a self-signed certificate generated by
      // the Wyre server itself; the user opts into trusting it explicitly.
      session.defaultSession.setCertificateVerifyProc((_request, callback) => callback(0));
    } else {
      session.defaultSession.setCertificateVerifyProc(null);
    }
  } catch (error) {
    logger.warn(`Не удалось обновить политику сертификатов: ${error.message}`);
  }
}

function applyPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(['media', 'notifications', 'fullscreen', 'pointerLock', 'mediaKeySystem', 'clipboard-sanitized-write'].includes(permission));
  });
  // Screen sharing inside calls: pick the primary screen without a picker.
  try {
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => callback(sources.length ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    });
  } catch (error) {
    logger.warn(`Обработчик демонстрации экрана недоступен: ${error.message}`);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('wyre.messenger.desktop');
    // No application menu at all: the messenger is not a document editor, and
    // the default menu made Alt open a hidden File/Edit/View bar.
    Menu.setApplicationMenu(null);
    logger.init(app.getPath('userData'));
    logger.info(`Wyre Desktop запущен (Electron ${process.versions.electron}, скрытый старт: ${startedHidden ? 'да' : 'нет'}).`);
    if (devMode) logger.warn('Режим разработки: проверка сертификатов ослаблена.');
    loadConfig();
    applyAutostart();
    applyPermissions();
    if (devMode || config.allowSelfSigned) applyCertificatePolicy();
    registerIpc();
    createMainWindow();
    createTray();
    if (startedHidden && mainWindow) mainWindow.hide();
    app.on('activate', () => showMainWindow());
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray; quitting is explicit via the tray or settings.
  });

  app.on('before-quit', () => {
    stopReconnect();
  });
}
