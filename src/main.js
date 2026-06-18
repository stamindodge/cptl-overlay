require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, desktopCapturer } = require('electron');
const path = require('path');
const { parseScreenshot, predict } = require('./api');
const { computeSlotHashes, looksLikeLoadingScreen } = require('./phash');

const WORKER_URL = process.env.WORKER_URL || 'https://cptl.stamindodge.workers.dev';
const POLL_MS = 1000;
const DETECT_THUMBNAIL_SIZE = { width: 480, height: 270 }; // 1차 로딩화면 감지용 — 가볍게

/** @type {BrowserWindow | null} */
let overlayWin = null;
/** @type {Tray | null} */
let tray = null;
let wasLoadingScreen = false;

/** @param {{width:number, height:number}} size @returns {Promise<Electron.NativeImage|null>} */
async function captureScreen(size) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  return sources[0]?.thumbnail ?? null;
}

/** @returns {BrowserWindow} */
function createOverlay() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('overlay.html');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on('closed', () => { overlayWin = null; });
  return win;
}

/**
 * @param {string} base64
 * @param {Buffer} imageBuffer
 */
async function handleLoadingScreen(base64, imageBuffer) {
  const slots = await computeSlotHashes(imageBuffer).catch(() => null);
  const phashes = slots ? slots.map((s) => s.hash) : null;
  const slotImages = slots ? slots.map((s) => s.image) : null;
  const parsed = await parseScreenshot(WORKER_URL, base64, phashes, slotImages);
  if (!parsed?.ok) return;

  const team1 = parsed.team1 ?? [];
  const team2 = parsed.team2 ?? [];
  if (!team1.some(Boolean) && !team2.some(Boolean)) return;

  if (!overlayWin || overlayWin.isDestroyed()) {
    overlayWin = createOverlay();
    await new Promise(r => overlayWin.webContents.once('did-finish-load', r));
  }
  overlayWin.showInactive();
  overlayWin.webContents.send('teams', { team1, team2 });

  const result = await predict(WORKER_URL, team1, team2);
  if (!overlayWin?.isDestroyed()) {
    const estimates = Object.fromEntries(
      Object.entries(result.players ?? {}).map(([nick, p]) => [
        nick,
        p.ok ? { ok: true, currentRp: p.currentRp, estimatedSkillRp: p.estimatedSkillRp,
                  delta: (p.estimatedSkillRp ?? p.currentRp ?? 0) - (p.currentRp ?? 0),
                  components: { mode: p.mode } }
              : { ok: false }
      ])
    );
    const winPred = result.prob != null
      ? { prob: 100 - result.prob, t1Avg: result.t1Avg, t2Avg: result.t2Avg }
      : null;
    overlayWin.webContents.send('estimates', { estimates, winPred });
  }
}

app.whenReady().then(() => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('CPTL Addon');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'CPTL 사이퍼즈 오버레이', enabled: false },
    { type: 'separator' },
    {
      label: '테스트 (목 데이터)',
      click: async () => {
        const mockTeams = {
          team1: ['돌고래', '뚱2', '베타붕괴', '트라손', '두유리'],
          team2: ['ㅇㅈㅁㄹ', '김동욱', '까만깜이', 'Jennet', '도휘'],
        };
        if (!overlayWin || overlayWin.isDestroyed()) {
          overlayWin = createOverlay();
          await new Promise(r => overlayWin.webContents.once('did-finish-load', r));
        }
        overlayWin.showInactive();
        overlayWin.webContents.send('teams', mockTeams);

        predict(WORKER_URL, mockTeams.team1, mockTeams.team2).then(result => {
          if (overlayWin?.isDestroyed()) return;
          const estimates = Object.fromEntries(
            Object.entries(result.players ?? {}).map(([nick, p]) => [
              nick,
              p.ok ? { ok: true, currentRp: p.currentRp, estimatedSkillRp: p.estimatedSkillRp,
                        delta: (p.estimatedSkillRp ?? p.currentRp ?? 0) - (p.currentRp ?? 0),
                        components: { mode: p.mode } }
                    : { ok: false }
            ])
          );
          const winPred = result.prob != null
            ? { prob: 100 - result.prob, t1Avg: result.t1Avg, t2Avg: result.t2Avg }
            : null;
          overlayWin.webContents.send('estimates', { estimates, winPred });
        }).catch(() => {});
      },
    },
    { type: 'separator' },
    { label: '종료', role: 'quit' },
  ]));

  ipcMain.on('overlay:close', () => overlayWin?.hide());
  ipcMain.on('overlay:clickthrough', (_, on) => {
    overlayWin?.setIgnoreMouseEvents(on, { forward: true });
  });

  setInterval(async () => {
    const thumb = await captureScreen(DETECT_THUMBNAIL_SIZE).catch(() => null);
    if (!thumb || thumb.isEmpty()) return;

    const isLoading = await looksLikeLoadingScreen(thumb.toJPEG(70)).catch(() => false);

    if (isLoading && !wasLoadingScreen) {
      // 새로 나타난 로딩화면 — 그제서야 풀해상도로 다시 캡처해서 본 파이프라인 실행
      const full = await captureScreen({ width: 3840, height: 2160 }).catch(() => null);
      if (full && !full.isEmpty()) {
        const jpegBuffer = full.toJPEG(85);
        handleLoadingScreen(jpegBuffer.toString('base64'), jpegBuffer).catch(() => {});
      }
    } else if (!isLoading && wasLoadingScreen) {
      overlayWin?.hide(); // 로딩화면이 끝남(게임 시작) — 오버레이도 같이 끔
    }
    wasLoadingScreen = isLoading;
  }, POLL_MS);
});

app.on('window-all-closed', e => e.preventDefault());
