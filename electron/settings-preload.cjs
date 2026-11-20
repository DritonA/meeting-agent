// Bridge for the settings window: only these calls reach the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (changes) => ipcRenderer.invoke('settings:save', changes),
  pickFolder: (current) => ipcRenderer.invoke('settings:pick-folder', current),
  close: () => ipcRenderer.send('settings:close'),
});
