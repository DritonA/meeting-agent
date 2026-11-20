// Desktop app (Windows): runs the same web server inside the app and shows the UI in its own window.
// Settings (API keys encrypted), the bot's Google profile and all meetings live in
// %APPDATA%\Meeting Agent, so the app works the same on any PC without a terminal or a project folder.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from './settings-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const APP_NAME = 'Meeting Agent';
// Settings that only apply on the next start (the server and meeting list are set up once).
const RESTART_KEYS = ['PORT', 'DATA_DIR'];

app.setName(APP_NAME);
// MEETING_AGENT_APPDATA: use another folder for settings and data (e.g. a separate test setup).
const customHome = process.env.MEETING_AGENT_APPDATA?.trim();
app.setPath('userData', customHome ? path.resolve(customHome) : path.join(app.getPath('appData'), APP_NAME));
if (process.platform === 'win32') app.setAppUserModelId('com.meetingagent.desktop');

const HOME = app.getPath('userData');
process.env.MEETING_AGENT_HOME = HOME;
fs.mkdirSync(HOME, { recursive: true });

let win = null;
let settingsWin = null;
let quitting = false; // set once it is safe to close (nothing left to save)
let store, startup, registry, config, applySettings, openSignInWindow;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox(APP_NAME, `Could not start: ${err.stack || err.message}`);
    app.exit(1);
  });
}

async function main() {
  // Settings first: config.js reads MEETING_AGENT_HOME when it loads, and the server's meeting list
  // is built from config.dataDir as soon as server.js is imported.
  store = new SettingsStore(HOME, path.join(APP_DIR, '.env.example'));
  await store.init();
  const firstRun = store.isNew;
  ({ config, applySettings } = await import('../src/config.js'));
  startup = store.resolved();
  applySettings(startup);
  const server = await import('../src/server.js');
  ({ openSignInWindow } = await import('../src/login.js'));
  registry = server.registry;

  // Use the configured port; if it is taken (e.g. the web version is running), any free port.
  let port;
  try {
    port = await server.startServer(config.port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    port = await server.startServer(0);
  }
  const appUrl = `http://127.0.0.1:${port}`;

  setUpSettingsIpc();
  Menu.setApplicationMenu(buildMenu());
  win = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 800,
    minHeight: 560,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(HERE, 'app-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links to other sites (e.g. a Meet link) open in the normal browser, not inside the app.
  const isAppUrl = (url) => url.startsWith(`${appUrl}/`) || url === appUrl;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    confirmQuit();
  });
  win.on('closed', () => (win = null));

  await win.loadURL(appUrl);
  if (firstRun || !config.anthropicConfigured) openSettingsWindow({ welcome: firstRun });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting || !registry) return;
  event.preventDefault();
  confirmQuit();
});

// ---------- settings window ----------

let welcomeOnce = false;
function openSettingsWindow({ welcome = false } = {}) {
  welcomeOnce = welcome;
  if (settingsWin) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    parent: win || undefined,
    modal: Boolean(win),
    width: 780,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    show: false,
    title: `Settings · ${APP_NAME}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => (settingsWin = null));
  settingsWin.loadFile(path.join(HERE, 'settings.html'));
}

function setUpSettingsIpc() {
  // Only the settings window may read or change settings; only the main window may open it.
  const fromSettings = (event) => settingsWin && event.sender === settingsWin.webContents;

  ipcMain.on('settings:open', (event) => {
    if (win && event.sender === win.webContents) openSettingsWindow();
  });
  ipcMain.on('settings:close', (event) => {
    if (fromSettings(event)) settingsWin.close();
  });

  ipcMain.handle('settings:load', (event) => {
    if (!fromSettings(event)) throw new Error('Not allowed');
    const welcome = welcomeOnce;
    welcomeOnce = false;
    return { ...store.forDisplay(), welcome };
  });

  ipcMain.handle('settings:pick-folder', async (event, current) => {
    if (!fromSettings(event)) throw new Error('Not allowed');
    const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin, {
      title: 'Folder for meetings',
      defaultPath: typeof current === 'string' && path.isAbsolute(current) ? current : config.dataDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('settings:save', async (event, changes) => {
    if (!fromSettings(event)) throw new Error('Not allowed');
    let restartKeys;
    try {
      restartKeys = await store.update(changes);
    } catch (err) {
      return { error: err.message };
    }
    // Use the new settings right away, except those that need a restart.
    const now = store.resolved();
    for (const key of RESTART_KEYS) now[key] = startup[key];
    applySettings(now);
    win?.webContents.send('settings:changed');

    const restartNeeded = RESTART_KEYS.some((key) => store.resolved()[key] !== startup[key]);
    if (restartKeys.length) {
      const { response } = await dialog.showMessageBox(settingsWin || win, {
        type: 'question',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: APP_NAME,
        message: 'Restart to use the new port or meetings folder?',
        detail: 'Your other changes are already in use.',
      });
      if (response === 0) setImmediate(() => confirmQuit({ relaunch: true }));
    }
    return { ok: true, restartNeeded };
  });
}

// ---------- quitting ----------

/** Meetings that still need the app running: the bot is in a call, or notes are being written. */
function busySessions() {
  if (!registry) return [];
  return [...registry.sessions.values()].filter((s) =>
    ['starting', 'joining', 'waiting_admission', 'in_meeting', 'leaving', 'processing'].includes(s.meta.status),
  );
}

let confirming = false;
async function confirmQuit({ relaunch = false } = {}) {
  if (confirming) return;
  const busy = busySessions();
  if (!busy.length) return quitNow(relaunch);
  confirming = true;
  try {
    const inCall = Boolean(registry.activeBot());
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [inCall ? 'Leave meeting and close' : 'Finish and close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: APP_NAME,
      message: inCall ? 'The bot is still in a meeting.' : 'Meeting notes are still being written.',
      detail: inCall
        ? 'The bot will leave the call, save the transcript and write the notes, then the app closes.'
        : 'The app will close as soon as the notes are saved.',
    });
    if (response !== 0) return;
    win?.setTitle(`${APP_NAME} — saving, closing soon…`);
    for (const s of busy) s.stop();
    await Promise.allSettled(busy.map((s) => s.done));
    quitNow(relaunch);
  } finally {
    confirming = false;
  }
}

function quitNow(relaunch) {
  quitting = true;
  if (relaunch) app.relaunch();
  app.quit();
}

// ---------- bot sign-in and menu ----------

async function signInBot() {
  if (registry.activeBot()) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: APP_NAME,
      message: 'The bot is in a meeting right now.',
      detail: 'Sign in after the meeting; the sign-in uses the same browser profile as the bot.',
    });
    return;
  }
  await dialog.showMessageBox(win, {
    type: 'info',
    title: APP_NAME,
    message: 'Sign the bot into a Google account',
    detail:
      "A browser window opens on the bot's own profile (separate from your personal browser). " +
      'Sign in to the account the bot should join meetings as, then close that window.\n\n' +
      'Tip: use a dedicated account (e.g. notetaker@yourcompany.com).',
  });
  try {
    await openSignInWindow({ log: () => {} });
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `Could not open the sign-in window: ${err.message}`);
  }
}

function buildMenu() {
  const openFolder = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  };
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { label: 'Open meetings folder', click: () => openFolder(config.dataDir) },
        { label: 'Restart', click: () => confirmQuit({ relaunch: true }) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => confirmQuit() },
      ],
    },
    {
      label: 'Bot',
      submenu: [
        { label: 'Sign in to Google account…', click: signInBot },
        { label: 'Open app data folder', click: () => openFolder(HOME) },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]);
}
