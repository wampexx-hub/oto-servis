const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { fork, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Oto Servis Yönetim Sistemi - Masaüstü (Çevrimdışı) Çerçevesi
// Gömülü Node/Fastify sunucusu + yerel SQLite veritabanı ile tamamen
// internet bağlantısı olmadan çalışır. Veriler kullanıcı profilinde tutulur.
// ---------------------------------------------------------------------------

const isPackaged = app.isPackaged;
let PORT = parseInt(process.env.OTO_PORT || '3001', 10);
const HOST = process.env.OTO_HOST || '127.0.0.1';
// Yerel ağa açıkken (0.0.0.0) pencere/sağlık kontrolü loopback üzerinden bağlanır.
const CONNECT_HOST = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;

let mainWindow = null;

// Verilen aralıkta boş bir TCP portu bulur (başka uygulamalarla çakışmayı önler).
function findFreePort(startPort, endPort) {
  return new Promise((resolve) => {
    let port = startPort;
    const tryPort = () => {
      const srv = net.createServer();
      srv.once('error', () => {
        port += 1;
        if (port > endPort) resolve(startPort);
        else tryPort();
      });
      srv.once('listening', () => {
        srv.close(() => resolve(port));
      });
      srv.listen(port, HOST);
    };
    tryPort();
  });
}

// Tek örnek kilidi: aynı anda iki kopya açılıp portu meşgul etmesin.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function userDirs() {
  const base = app.getPath('userData');
  return {
    root: base,
    data: path.join(base, 'data'),
    uploads: path.join(base, 'uploads'),
    backups: path.join(base, 'backups')
  };
}

function resolveServerEntry() {
  if (isPackaged) {
    // Paketlenmiş uygulamada sunucu resources/server/index.cjs olarak yer alır.
    return path.join(process.resourcesPath, 'server', 'index.cjs');
  }
  return path.join(__dirname, '..', 'server', 'dist-bundle', 'index.cjs');
}

function resolveClientDir() {
  if (isPackaged) {
    return path.join(process.resourcesPath, 'client');
  }
  return path.join(__dirname, '..', 'client', 'dist');
}

let serverProcess = null;

function startEmbeddedServer() {
  const dirs = userDirs();
  for (const dir of Object.values(dirs)) {
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const entry = resolveServerEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`Gömülü sunucu dosyası bulunamadı: ${entry}`);
  }

  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: HOST,
    NODE_ENV: process.env.NODE_ENV || 'production',
    DATA_DIR: dirs.data,
    UPLOAD_DIR: dirs.uploads,
    BACKUP_DIR: dirs.backups,
    STATIC_DIR: resolveClientDir(),
    DISABLE_SWAGGER: '1',
    SEED_SAMPLE_DATA: '0',
    TZ: process.env.TZ || 'Europe/Istanbul'
  };

  console.log('[OTO] Gömülü sunucu başlatılıyor:', entry);

  if (isPackaged) {
    // Paketlenmiş: Electron'un kendi Node çalışma zamanı kullanılır.
    serverProcess = fork(entry, [], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
  } else {
    // Geliştirme: sistemdeki Node.js kullanılır (yerel modül ABI uyumu için).
    const nodeExec = process.platform === 'win32' ? 'node.exe' : 'node';
    serverProcess = spawn(nodeExec, [entry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  if (serverProcess.stdout) {
    serverProcess.stdout.on('data', (d) => process.stdout.write(`[SERVER] ${d}`));
  }
  if (serverProcess.stderr) {
    serverProcess.stderr.on('data', (d) => process.stderr.write(`[SERVER:ERR] ${d}`));
  }
  serverProcess.on('error', (err) => {
    console.error('[OTO] Sunucu süreç hatası:', err);
  });
  serverProcess.on('exit', (code, signal) => {
    console.log(`[OTO] Sunucu süreci kapandı (kod=${code}, sinyal=${signal}).`);
  });
}

function waitForServer(timeoutMs = 25000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: CONNECT_HOST, port: PORT, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

function setupDownloadHandling() {
  session.defaultSession.on('will-download', (event, item) => {
    const suggested = item.getFilename() || 'oto-servis-yedek';
    const isZip = suggested.toLowerCase().endsWith('.zip');
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      title: 'Kaydet',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: isZip
        ? [{ name: 'Oto Servis Yedeği (ZIP)', extensions: ['zip'] }]
        : [
            { name: 'SQLite Veritabanı', extensions: ['sqlite', 'db'] },
            { name: 'Tüm Dosyalar', extensions: ['*'] }
          ]
    });

    if (!savePath) {
      item.cancel();
      return;
    }

    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Kaydedildi',
          message: 'Dosya başarıyla kaydedildi.',
          detail: savePath,
          buttons: ['Tamam']
        });
      } else if (state === 'interrupted') {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'İndirme kesildi',
          message: 'Dosya kaydedilemedi veya işlem iptal edildi.'
        });
      }
    });
  });
}

function buildMenu() {
  const dirs = userDirs();

  const template = [
    {
      label: 'Dosya',
      submenu: [
        {
          label: 'Yedek Klasörünü Aç',
          click: () => shell.openPath(dirs.backups)
        },
        {
          label: 'Veri (Veritabanı) Klasörünü Aç',
          click: () => shell.openPath(dirs.data)
        },
        {
          label: 'Fotoğraflar Klasörünü Aç',
          click: () => shell.openPath(dirs.uploads)
        },
        { type: 'separator' },
        { role: 'quit', label: 'Çıkış' }
      ]
    },
    {
      label: 'Düzen',
      submenu: [
        { role: 'undo', label: 'Geri Al' },
        { role: 'redo', label: 'Yinele' },
        { type: 'separator' },
        { role: 'cut', label: 'Kes' },
        { role: 'copy', label: 'Kopyala' },
        { role: 'paste', label: 'Yapıştır' },
        { role: 'selectAll', label: 'Tümünü Seç' }
      ]
    },
    {
      label: 'Görünüm',
      submenu: [
        { role: 'reload', label: 'Yenile' },
        { role: 'forceReload', label: 'Önbelleği Temizleyip Yenile' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Normal Boyut' },
        { role: 'zoomIn', label: 'Yakınlaştır' },
        { role: 'zoomOut', label: 'Uzaklaştır' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tam Ekran' }
      ]
    },
    {
      label: 'Yardım',
      submenu: [
        {
          label: 'Veri Klasörü Yolu',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Veri Konumu',
              message: 'Uygulama verileri bu klasörde saklanır:',
              detail: dirs.root,
              buttons: ['Tamam']
            });
          }
        },
        {
          label: 'Hakkında',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Hakkında',
              message: 'Oto Servis Yönetim Sistemi',
              detail: `Sürüm: ${app.getVersion()}\nÇevrimdışı masaüstü sürümü (yerel SQLite veritabanı).`,
              buttons: ['Tamam']
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 480,
    minHeight: 600,
    title: 'Oto Servis Yönetim Sistemi',
    backgroundColor: '#0f2a5c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://${CONNECT_HOST}:${PORT}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('oto:get-paths', () => userDirs());
ipcMain.handle('oto:open-data-folder', () => shell.openPath(userDirs().data));
ipcMain.handle('oto:open-backups-folder', () => shell.openPath(userDirs().backups));

app.whenReady().then(async () => {
  let startupError = null;

  try {
    PORT = await findFreePort(PORT, PORT + 50);
    startEmbeddedServer();
  } catch (err) {
    startupError = err;
    console.error('[OTO] Sunucu başlatma hatası:', err);
  }

  setupDownloadHandling();
  buildMenu();

  const ready = startupError ? false : await waitForServer();

  createWindow();

  if (!ready) {
    dialog.showErrorBox(
      'Sunucu Başlatılamadı',
      `Gömülü sunucu başlatılamadı.\n\n${startupError ? startupError.message : 'Zaman aşımı.'}`
    );
  }

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

app.on('will-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {}
  }
});

process.on('uncaughtException', (err) => {
  console.error('[OTO] Beklenmeyen hata:', err);
});
