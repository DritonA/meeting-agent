// Bridge for the main window (the web UI): lets it open Settings and hear when they change.
// It carries no settings or keys.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingAgentDesktop', {
  openSettings: () => ipcRenderer.send('settings:open'),
  onSettingsChanged: (callback) => ipcRenderer.on('settings:changed', () => callback()),
});
