const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

let win;
let tray;

function createWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height, x, y } = primaryDisplay.bounds;

  const isDev = !app.isPackaged;
  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: true,
    enableLargerThanScreen: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // macOS specific: stay above dock and menu bar, and be visible on all workspaces
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    // app.dock.hide(); // Allow dock icon so it's easier to quit via macOS menu
  }

  // Mouse passthrough logic
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.setIgnoreMouseEvents(ignore, options);
  });

  // Quit application logic
  ipcMain.on('quit-app', () => {
    app.quit();
  });

  // In development, load from the Vite dev server
  // In production, load the built index.html
  if (isDev) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  // Create Tray Icon
  const icon = nativeImage.createEmpty(); // Transparent dummy icon
  tray = new Tray(icon);
  tray.setTitle('✎'); // Use a pen emoji/symbol for the tray title
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'ProAnnotate', enabled: false },
    { type: 'separator' },
    { label: 'Toggle Toolbar', click: () => win.webContents.send('toggle-toolbar') },
    { label: 'Clear All', click: () => win.webContents.send('clear-canvas') },
    { label: 'Undo', click: () => win.webContents.send('undo-stroke') },
    { type: 'separator' },
    { label: 'Quit ProAnnotate', click: () => app.quit() }
  ]);
  
  tray.setContextMenu(contextMenu);

  // Also update the main App Menu for macOS
  const template = [
    {
      label: 'ProAnnotate',
      submenu: [
        { label: 'About ProAnnotate', role: 'about' },
        { type: 'separator' },
        { label: 'Toggle Toolbar', accelerator: 'CmdOrCtrl+T', click: () => win.webContents.send('toggle-toolbar') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => win.webContents.send('undo-stroke') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => win.webContents.send('redo-stroke') },
        { type: 'separator' },
        { label: 'Clear All', accelerator: 'CmdOrCtrl+K', click: () => win.webContents.send('clear-canvas') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
