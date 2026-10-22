const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

// Serve the app from a privileged custom scheme so ES modules, the pdf.js
// worker and fetch() of pdf.js font/cmap data all work (file:// blocks fetch).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let dirty = false;
let forceClose = false;

function fileFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.find((a) => a.toLowerCase().endsWith('.pdf')) || null;
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function buildMenu() {
  const cmd = (name) => () => send('menu', name);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveAs') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoomOut') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: cmd('fitWidth') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'PDF Editor',
    backgroundColor: '#2b2d31',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://local/src/index.html');

  win.on('close', async (e) => {
    if (!dirty || forceClose) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Save changes before closing?',
    });
    if (response === 0) send('menu', 'saveAndClose');
    else if (response === 1) { forceClose = true; win.close(); }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('dialog:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  return readPdf(filePaths[0]);
});

async function readPdf(filePath) {
  const bytes = await fs.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), bytes };
}
ipcMain.handle('file:read', (_e, filePath) => readPdf(filePath));

ipcMain.handle('file:save', async (_e, filePath, bytes) => {
  await fs.writeFile(filePath, Buffer.from(bytes));
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('dialog:saveAs', async (_e, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return canceled ? null : filePath;
});

ipcMain.handle('dialog:openImage', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const bytes = await fs.readFile(filePaths[0]);
  return { name: path.basename(filePaths[0]), ext: path.extname(filePaths[0]).slice(1).toLowerCase(), bytes };
});

// Unicode-capable fonts for text the PDF standard fonts can't encode.
const SYSTEM_FONTS = new Set(['arial.ttf', 'arialbd.ttf', 'times.ttf', 'timesbd.ttf', 'cour.ttf', 'courbd.ttf']);
ipcMain.handle('font:read', async (_e, name) => {
  if (!SYSTEM_FONTS.has(name)) return null;
  const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  try { return await fs.readFile(path.join(dir, name)); } catch { return null; }
});

ipcMain.on('app:setDirty', (_e, value) => { dirty = !!value; });
ipcMain.on('app:closeNow', () => { forceClose = true; win?.close(); });
ipcMain.handle('app:initialFile', () => fileFromArgv(process.argv));

app.whenReady().then(() => {
  const root = __dirname;
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const target = path.normalize(path.join(root, decodeURIComponent(pathname)));
    if (!target.startsWith(root)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
