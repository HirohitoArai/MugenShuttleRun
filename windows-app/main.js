// 無限シャトルラン Windows 版（Electron ラッパー）
// Web 版の dist をローカル HTTP サーバーで配信して表示する。
// ffmpeg.wasm が必要とする MIME (application/wasm) を正しく返すことが目的で、
// file:// 直開きの制約を受けないようにしている。
const { app, BrowserWindow, powerSaveBlocker } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = path.join(DIST, path.normalize(urlPath));
        if (!filePath.startsWith(DIST)) {
          res.writeHead(403);
          res.end();
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(data);
        });
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

app.whenReady().then(async () => {
  // 配信中の画面スリープ／ディスプレイオフを防ぐ
  powerSaveBlocker.start('prevent-display-sleep');
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: '無限シャトルラン',
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => app.quit());
