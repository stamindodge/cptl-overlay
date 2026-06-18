const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onTeams:      cb => ipcRenderer.on('teams',     (_, d) => cb(d)),
  onEstimates:  cb => ipcRenderer.on('estimates', (_, d) => cb(d)),
  close:        ()  => ipcRenderer.send('overlay:close'),
  setClickthrough: on => ipcRenderer.send('overlay:clickthrough', on),
});
