require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// 포터블 앱이라 유저 프로필(AppData)이 아니라 exe 옆에 설정/로그를 둔다 — 폴더째 옮기거나
// USB에 들고 다녀도 흔적이 안 남고 데이터가 따라다님. 개발 모드(`electron .`)에서는
// exe가 없으니 기본 동작(AppData) 그대로 둔다.
if (app.isPackaged) {
  app.setPath('userData', path.join(path.dirname(process.execPath), 'data'));
}

const { parseScreenshot, predict, fetchMatches } = require('./api');
const { computeSlotHashes, looksLikeLoadingScreen } = require('./phash');
const logger = require('./logger');

// 원격 데스크톱 세션에서는 GPU 프로세스가 제대로 안 떠서 transparent/always-on-top 창이
// "보임" 상태인데도 실제 화면엔 합성이 안 되는 경우가 있음(로컬 스크린샷으로 직접 확인됨).
// 하드웨어 가속을 꺼서 소프트웨어 렌더링으로 강제하면 이 케이스에서 안정적으로 그려짐.
app.disableHardwareAcceleration();

const WORKER_URL = process.env.WORKER_URL || 'https://cptl.stamindodge.workers.dev';
// 평소엔 1초 간격으로 가볍게 돌다가(캡처 부하/스터터 줄임), 한 번이라도 VS 비슷한 게
// 잡히면 0.5초 간격으로 빠르게 전환해서 LOADING_CONFIRM_FRAMES만큼 재확인한다.
const IDLE_POLL_MS = 500;
const FAST_POLL_MS = 250;
const DETECT_THUMBNAIL_SIZE = { width: 480, height: 270 }; // 1차 로딩화면 감지용 — 가볍게
const FULL_CAPTURE_SIZE = { width: 3840, height: 2160 }; // 확정 후 OCR/phash용 본 캡처
// 단순히 'cyphers'로 찾으면 이 저장소 폴더명("cyphers-team-luck")이 들어간 VS Code/터미널
// 창이 먼저 매칭돼버리는 사고가 실측으로 확인됨 — 실제 게임 창 제목("Neople Cyphers")으로 좁힘.
const GAME_WINDOW_NAME_HINT = 'neople cyphers'; // 창 제목에 이 문자열이 들어가면 게임 창으로 인식 (대소문자 무시)
const THEMES = [
  { id: 'default', label: '기본' },
  { id: 'purple',  label: '퍼플' },
  { id: 'mono',    label: '모노크롬' },
];
// 인게임 HUD(MP/EXP 게이지)가 닉네임 카드로 오인식될 때 "]MP[277/2687]" 같은
// 게이지 텍스트가 닉네임 자리에 들어옴 — 실제 닉네임엔 안 쓰이는 문자라 걸러냄.
// (공백 기준 NPC 필터는 OCR이 진짜 유저 닉네임을 잘못 쪼개 가짜 공백을 넣는 경우가
// 더 흔해서 제거함 — worker/screenshot.js의 join("") 원복과 같이 묶인 변경)
const HUD_GARBAGE_RE = /[[\]%/]/;

/** @param {(string|null)[]} nicks @returns {(string|null)[]} */
function filterHudGarbage(nicks) {
  return nicks.map((n) => (n && HUD_GARBAGE_RE.test(n) ? '' : n));
}

/** @type {BrowserWindow | null} */
let overlayWin = null;
/** @type {Tray | null} */
let tray = null;
let wasLoadingScreen = false;
// 로딩화면 진입/이탈이 한 프레임만 깜빡여도(화면 전환 중간 프레임 등) 바로 트리거되던 걸 막기 위해
// 같은 판정이 연속 N프레임 나와야 상태 전이를 인정한다. FAST_POLL_MS(250ms) x 4프레임 = 1초 —
// 오탐은 거르면서도 체감 지연은 짧게 유지.
const LOADING_CONFIRM_FRAMES = 4;
let lastRawIsLoading = false;
let rawLoadingStreak = 0;
let isProcessingLoadingScreen = false;
// 다른 창이 카드를 잠깐 가린 채로 캡처되면 일부 닉네임이 빈 채로 남는 문제 대응 —
// 로딩화면이 떠 있는 동안 파싱이 불완전했으면 재시도한다. 한 번의 캡처+OCR+predict
// 파이프라인 자체가 보통 2~5초 걸려서(isProcessingLoadingScreen 가드로 겹쳐 돌진 않음),
// 간격을 FAST_POLL_MS와 똑같이 둬도 실제 재시도 빈도는 거의 안 늘어난다.
let lastParseDone = true;
let retryAttempts = 0;
let lastCaptureAt = 0;
const MAX_RETRY_ATTEMPTS = 4;
const RETRY_INTERVAL_MS = FAST_POLL_MS;

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings)); } catch {}
}
const settings = { theme: 'default', startOnLogin: false, ...loadSettings() };

// 캡처 대상 — 트레이 메뉴 "캡처"에서 고른다. 디스크에 저장하지 않고 세션 메모리에만 둔다
// (테스트 중 골라둔 값이 다음 실행에도 그대로 남아 헷갈리는 문제가 있었음). 값:
//   null            — 자동 감지(GAME_WINDOW_NAME_HINT로 게임 창 찾기, 없으면 화면 전체)
//   'screen'        — 항상 화면 전체
//   'none'          — 아무것도 캡처 안 함(감지 자체를 끔)
//   그 외(문자열)    — 그 이름의 창을 캡처(못 찾으면 화면 전체로 폴백)
let captureTarget = null;

/** @param {{width:number, height:number}} size @returns {Promise<Electron.NativeImage|null>} */
async function captureScreen(size) {
  if (captureTarget === 'none') return null;

  if (captureTarget !== 'screen') {
    const windowSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size }).catch((err) => {
      logger.error('captureScreen: window source enumeration failed', err);
      return [];
    });
    const gameWindow = captureTarget
      ? windowSources.find((s) => s.name === captureTarget)
      : windowSources.find((s) => s.name?.toLowerCase().includes(GAME_WINDOW_NAME_HINT));
    if (gameWindow) return gameWindow.thumbnail;
  }

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  if (!sources[0]) logger.warn('captureScreen: no screen sources found');
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
    show: false, // 앱 시작할 때 미리 만들어두는 용도라 로딩 중에 화면에 안 보여야 함
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('overlay.html');
  win.setIgnoreMouseEvents(true, { forward: true });
  // 생성자 옵션의 alwaysOnTop: true가 실제로는 안 먹힐 때가 있는 게 로그(isAlwaysOnTop()===false)로
  // 확인됨 — 이 상태면 창은 "보임"이어도 다른 창(영상/게임) 뒤에 깔려서 화면엔 안 보임.
  // 'screen-saver' 레벨로 명시적으로 다시 강제해서 항상 최상단에 오도록 한다.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => { overlayWin = null; });
  return win;
}

/** 오버레이가 없으면 만들고, 보여주고, 현재 테마를 적용한다 @returns {Promise<BrowserWindow>} */
async function ensureOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) {
    logger.info('ensureOverlay: creating new overlay window');
    overlayWin = createOverlay();
    await new Promise(r => overlayWin.webContents.once('did-finish-load', r));
  }
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.showInactive();
  overlayWin.webContents.send('theme', settings.theme);
  logger.info('ensureOverlay: shown', {
    visible: overlayWin.isVisible(),
    bounds: overlayWin.getBounds(),
    minimized: overlayWin.isMinimized(),
    onTop: overlayWin.isAlwaysOnTop(),
  });
  return overlayWin;
}

/**
 * @param {string} base64
 * @param {Buffer} imageBuffer
 */
async function handleLoadingScreen(base64, imageBuffer) {
  logger.info('handleLoadingScreen: start');
  const slots = await computeSlotHashes(imageBuffer).catch((err) => {
    logger.error('computeSlotHashes failed', err);
    return null;
  });
  const phashes = slots ? slots.map((s) => s.hash) : null;
  const slotImages = slots ? slots.map((s) => s.image) : null;
  const parsed = await parseScreenshot(WORKER_URL, base64, phashes, slotImages).catch((err) => {
    logger.error('parseScreenshot failed', err);
    return null;
  });
  if (!parsed?.ok) {
    logger.warn('parseScreenshot returned not-ok, skipping', parsed);
    return { done: false }; // 일시적 실패일 수 있으니 재시도 가치 있음
  }

  const team1 = filterHudGarbage(parsed.team1 ?? []);
  const team2 = filterHudGarbage(parsed.team2 ?? []);
  logger.info('parseScreenshot result', { raw: { team1: parsed.team1, team2: parsed.team2 }, filtered: { team1, team2 } });

  // VS 템플릿 매칭으로 1차 감지 자체가 훨씬 정확해져서(오탐 시 NCC가 거의 0에 가까움),
  // 슬롯 채워진 개수로 한 번 더 거르던 안전장치는 더 이상 필요 없음 — 협력전처럼 한쪽 팀이
  // NPC라 절반만 채워지는 정상 케이스까지 같이 걸러지는 부작용도 없앰.
  if (!team1.some(Boolean) && !team2.some(Boolean)) {
    logger.warn('parseScreenshot: both teams empty, skipping overlay');
    return { done: true };
  }
  // 다른 창이 카드 한두 칸을 가린 순간에 캡처되면 일부 닉네임만 비어서 들어옴 —
  // 완전하지 않으면 호출자가 잠시 후 재시도할 수 있게 알려준다.
  const filledCount = [...team1, ...team2].filter(Boolean).length;
  const isComplete = filledCount === 10;

  await ensureOverlay();
  overlayWin.webContents.send('teams', { team1, team2 });

  const allNicks = [...team1, ...team2].filter(Boolean);
  const [result, matchSettled] = await Promise.all([
    predict(WORKER_URL, team1, team2).catch((err) => {
      logger.error('predict failed', err);
      return {};
    }),
    Promise.allSettled(allNicks.map((nick) => fetchMatches(WORKER_URL, nick).then((d) => [nick, d]))),
  ]);
  logger.info('predict result', result);
  for (const [i, r] of matchSettled.entries()) {
    if (r.status === 'rejected') logger.warn('fetchMatches failed', { nick: allNicks[i], reason: String(r.reason) });
  }

  if (!overlayWin?.isDestroyed()) {
    const estimates = Object.fromEntries(
      Object.entries(result.players ?? {}).map(([nick, p]) => [
        nick,
        p.ok ? { ok: true, currentRp: p.currentRp, estimatedSkillRp: p.estimatedSkillRp,
                  delta: (p.estimatedSkillRp ?? p.currentRp ?? 0) - (p.currentRp ?? 0),
                  components: { mode: p.mode } }
              // 추정(estimatedSkillRp)은 실패해도 현재 RP는 있을 수 있음 — "?" 대신 보여줄 수 있게 전달
              : { ok: false, currentRp: p.currentRp ?? null, reason: p.reason ?? 'insufficient_data' }
      ])
    );
    // 워커의 prob은 이미 team2(아군) 기준 승률 — 뒤집으면 안 됨(예전엔 100-prob로 반전시켜서
    // 거꾸로 표시되던 버그가 있었음)
    const winPred = result.prob != null
      ? { prob: result.prob, t1Avg: result.t1Avg, t2Avg: result.t2Avg }
      : null;
    overlayWin.webContents.send('estimates', { estimates, winPred });

    const matchesByNick = {};
    for (const r of matchSettled) {
      if (r.status !== 'fulfilled') continue;
      const [nick, data] = r.value;
      matchesByNick[nick] = data?.ok ? data.matches.slice(0, 5) : [];
    }
    overlayWin.webContents.send('matches', matchesByNick);
  }
  return { done: isComplete };
}

function applyStartOnLogin(enabled) {
  settings.startOnLogin = enabled;
  saveSettings();
  // 개발 모드(`electron .`)에서는 Electron 런타임 자체가 등록돼 경로가 깨지기 쉬움 —
  // 패키징된 exe(electron-builder 빌드) 상태에서만 제대로 동작함
  app.setLoginItemSettings({ openAtLogin: enabled });
}

async function buildTrayMenu() {
  // 메뉴를 열 때마다 현재 열린 창 목록을 새로 가져온다 — 자동 이름 매칭이 엉뚱한 창을
  // 집을 수 있어서(예: 폴더명에 "cyphers"가 들어간 VS Code 창), 사용자가 직접 고르게 한다.
  const windowSources = await desktopCapturer.getSources({ types: ['window'] }).catch(() => []);
  // captureTarget이 null(미선택)이면 자동 감지 대상을 기본값으로 체크 표시한다 —
  // 게임 창이 떠 있으면 그 창이 기본 선택으로 보여야 함.
  const autoMatch = captureTarget
    ? null
    : windowSources.find((s) => s.name?.toLowerCase().includes(GAME_WINDOW_NAME_HINT));

  return Menu.buildFromTemplate([
    { label: 'CPTL 사이퍼즈 오버레이', enabled: false },
    { type: 'separator' },
    {
      label: '테마',
      submenu: THEMES.map((t) => ({
        label: t.label,
        type: 'radio',
        checked: settings.theme === t.id,
        click: () => {
          settings.theme = t.id;
          saveSettings();
          if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('theme', t.id);
        },
      })),
    },
    {
      label: '캡처',
      submenu: [
        {
          label: '전체화면',
          type: 'radio',
          checked: captureTarget === 'screen',
          click: () => { captureTarget = 'screen'; },
        },
        ...windowSources.map((s) => ({
          label: s.name || '(제목 없음)',
          type: 'radio',
          checked: captureTarget === s.name || autoMatch === s,
          click: () => { captureTarget = s.name; },
        })),
        {
          label: '캡처 안함',
          type: 'radio',
          checked: captureTarget === 'none',
          click: () => { captureTarget = 'none'; },
        },
      ],
    },
    {
      label: '윈도우 시작 시 자동 실행',
      type: 'checkbox',
      checked: settings.startOnLogin,
      click: (item) => applyStartOnLogin(item.checked),
    },
    { type: 'separator' },
    { label: '종료', role: 'quit' },
  ]);
}

app.whenReady().then(async () => {
  logger.info('app ready', { logPath: logger.logPath });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-icon.png')));
  tray.setToolTip('CPTL Addon');
  // 창 목록이 메뉴를 열 때마다 최신이어야 해서(새로 켠 창도 바로 보이게), setContextMenu
  // 한 번 박아두는 대신 클릭할 때마다 새로 만들어서 띄운다.
  const popUpFreshMenu = async () => tray.popUpContextMenu(await buildTrayMenu());
  tray.on('click', popUpFreshMenu);
  tray.on('right-click', popUpFreshMenu);
  app.setLoginItemSettings({ openAtLogin: settings.startOnLogin }); // 저장된 설정과 OS 상태 동기화

  ipcMain.on('overlay:close', () => overlayWin?.close());
  ipcMain.on('overlay:clickthrough', (_, on) => {
    overlayWin?.setIgnoreMouseEvents(on, { forward: true });
  });

  // 오버레이 창을 미리 만들어둔다(숨긴 채로) — 첫 매치 때 창 생성+로딩 대기 시간만큼
  // 표시가 늦어지는 걸 방지. 실제 표시 시점엔 이미 로딩이 끝나 있어 바로 보여줄 수 있음.
  overlayWin = createOverlay();



  const pollLoop = async () => {
    const thumb = await captureScreen(DETECT_THUMBNAIL_SIZE).catch((err) => {
      logger.error('captureScreen (detect) failed', err);
      return null;
    });
    if (!thumb || thumb.isEmpty()) {
      setTimeout(pollLoop, IDLE_POLL_MS);
      return;
    }

    const rawIsLoading = await looksLikeLoadingScreen(thumb.toJPEG(70)).catch((err) => {
      logger.error('looksLikeLoadingScreen failed', err);
      return false;
    });

    // 진입(false→true)은 오탐 거르려고 LOADING_CONFIRM_FRAMES만큼 연속 확인하지만,
    // 이탈(true→false)은 1프레임만 봐도 됨 — 게임이 실제로 시작했는데 오버레이가
    // 괜히 더 오래 떠 있을 이유가 없고, 잘못 사라져도 다음 프레임에 다시 잡히면 그만임.
    if (rawIsLoading) {
      rawLoadingStreak = lastRawIsLoading ? rawLoadingStreak + 1 : 1;
    } else {
      rawLoadingStreak = 0;
    }
    lastRawIsLoading = rawIsLoading;
    const confirmed = rawIsLoading ? rawLoadingStreak >= LOADING_CONFIRM_FRAMES : true;
    const isLoading = confirmed ? rawIsLoading : wasLoadingScreen;

    const triggerCapture = async () => {
      isProcessingLoadingScreen = true;
      lastCaptureAt = Date.now();
      const full = await captureScreen(FULL_CAPTURE_SIZE).catch((err) => {
        logger.error('captureScreen (full) failed', err);
        return null;
      });
      if (!full || full.isEmpty()) {
        isProcessingLoadingScreen = false;
        return;
      }
      const jpegBuffer = full.toJPEG(85);
      handleLoadingScreen(jpegBuffer.toString('base64'), jpegBuffer)
        .then((res) => { lastParseDone = res?.done ?? true; })
        .catch((err) => logger.error('handleLoadingScreen failed', err))
        .finally(() => { isProcessingLoadingScreen = false; });
    };

    if (isLoading && !wasLoadingScreen) {
      logger.info('loading screen detected');
      retryAttempts = 0;
      lastParseDone = true;
      if (isProcessingLoadingScreen) {
        logger.warn('loading screen detected while previous run still processing — skipping');
      } else {
        // 새로 나타난 로딩화면 — 그제서야 풀해상도로 다시 캡처해서 본 파이프라인 실행
        await triggerCapture();
      }
    } else if (
      isLoading && wasLoadingScreen && !lastParseDone && !isProcessingLoadingScreen &&
      retryAttempts < MAX_RETRY_ATTEMPTS && Date.now() - lastCaptureAt >= RETRY_INTERVAL_MS
    ) {
      // 다른 창이 카드를 가린 채로 캡처돼서 일부 닉네임이 비었던 경우 — 로딩화면이 아직
      // 떠 있는 동안 재시도해서 가린 게 사라졌으면 완전한 결과로 덮어쓴다.
      retryAttempts++;
      logger.info('retrying capture — previous parse was incomplete', { attempt: retryAttempts });
      await triggerCapture();
    } else if (!isLoading && wasLoadingScreen) {
      logger.info('loading screen ended');
      // 예전엔 hide()->showInactive() 재사용 시 화면에 안 보이는 문제가 있어서 매번 close()로
      // 새로 만들었는데, 진짜 원인은 alwaysOnTop이 실제로 안 걸려있던 것(고침)으로 밝혀짐 —
      // 그 수정 이후로 hide() 재사용이 실제로 괜찮은지 다시 테스트해보는 중.
      overlayWin?.hide();
    }
    wasLoadingScreen = isLoading;

    // 로딩 중이거나(매치 추적), 방금 막 VS 비슷한 게 잡혀서 확인 중이면 빠르게,
    // 그 외엔 평소처럼 느긋하게 — 캡처 부하를 줄이면서도 감지는 빠르게 유지.
    const nextDelay = (wasLoadingScreen || rawIsLoading) ? FAST_POLL_MS : IDLE_POLL_MS;
    setTimeout(pollLoop, nextDelay);
  };
  pollLoop();
});

app.on('window-all-closed', e => e.preventDefault());
