'use strict';

// Harness Widget — компактная панель Windows поверх работающего веб-хоста Harness.
// Оболочка не подменяет харнесс: она подключается к тому же серверу (127.0.0.1:3080),
// поэтому профиль, сессии и история остаются теми же, что в браузере.

const {
  app, BaseWindow, WebContentsView, ipcMain, screen, Tray, Menu,
  nativeImage, globalShortcut, shell, net,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SHOT_DIR = path.join(ROOT, 'shots');
const TOOLBAR_HEIGHT = 34;
const PANEL_MARGIN = 8;
// Ширина развёрнутого меню сессий у харнесса; от неё считается масштаб меню.
const PANEL_MENU_BASE_WIDTH = 280;

const SCREENSHOT_MODE = process.argv.includes('--screenshot') || !!process.env.WIDGET_SHOT;
// Отладочные хуки: WIDGET_EVAL — выполнить JS на странице харнесса и напечатать результат,
// WIDGET_CSS — внедрить CSS-файл перед снятием снимка.
const EVAL_CODE = process.env.WIDGET_EVAL || '';
const EXTRA_CSS = process.env.WIDGET_CSS || '';

// ---------------------------------------------------------------- config

const DEFAULT_CONFIG = {
  launcherDir: '',
  url: '',
  hotkey: 'Control+Alt+H',
  panelWidth: 440,
  panelHeightRatio: 1 / 3,
  zoomPanel: 0.8,
  zoomWindow: 1,
  menuScale: 1,
  modelScale: 1,
  glass: true,
  glassAlpha: 0.55,
  cardAlpha: 0.7,
  animate: true,
  blur: false,
  alwaysOnTop: true,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadConfig() {
  const user = readJson(CONFIG_PATH) || {};
  return { ...DEFAULT_CONFIG, ...user };
}

let config = loadConfig();

// ---------------------------------------------------------------- state

const STATE_PATH = () => path.join(app.getPath('userData'), 'window-state.json');

const windowState = {
  mode: 'panel',        // panel | window
  alwaysOnTop: config.alwaysOnTop,
  bounds: null,         // границы свободного режима
  panelBounds: null,    // границы компактной панели, заданные пользователем
  visible: true,
};

function loadWindowState() {
  const saved = readJson(STATE_PATH());
  if (saved && typeof saved === 'object') {
    Object.assign(windowState, saved, { visible: true });
  }
  if (windowState.alwaysOnTop === undefined) windowState.alwaysOnTop = true;
}

let saveTimer = null;
function saveWindowState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH()), { recursive: true });
      fs.writeFileSync(STATE_PATH(), JSON.stringify(windowState, null, 2));
    } catch (err) {
      console.error('[widget] не удалось сохранить состояние окна:', err.message);
    }
  }, 400);
}

// ---------------------------------------------------------------- target URL

// Харнесс принимает токен только в GET /, после чего ставит подписанную cookie и
// редиректит на чистый адрес. Поэтому берём свежий авторизованный URL из состояния лаунчера.
function resolveTargetUrl() {
  const launcher = config.launcherDir;
  if (launcher) {
    const state = readJson(path.join(launcher, 'state', 'harness.json'));
    if (state && state.url) return state.url;

    const launcherConfig = readJson(path.join(launcher, 'harness.config.json'));
    if (launcherConfig && launcherConfig.port) {
      const host = launcherConfig.host || '127.0.0.1';
      return `http://${host}:${launcherConfig.port}/`;
    }
  }
  return config.url || 'http://127.0.0.1:3080/';
}

function probeServer(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const request = net.request({ method: 'GET', url });
      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* noop */ }
        done(false);
      }, 2500);
      request.on('response', (response) => {
        clearTimeout(timer);
        response.on('data', () => {});
        response.on('end', () => {});
        // 200 — авторизовано, 302/401 — сервер жив, но нужен свежий токен.
        done(response.statusCode < 500);
      });
      request.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      request.end();
    } catch {
      done(false);
    }
  });
}

// ---------------------------------------------------------------- launcher control

function launcherScript(name) {
  return path.join(config.launcherDir, name);
}

function runLauncher(name) {
  const script = launcherScript(name);
  if (!fs.existsSync(script)) {
    console.error('[widget] скрипт лаунчера не найден:', script);
    return false;
  }
  const child = spawn(
    'pwsh.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: config.launcherDir, detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  return true;
}

// ---------------------------------------------------------------- window

let win = null;
let toolbarView = null;
let harnessView = null;
let settingsView = null;
let settingsVisible = false;
let dynamicCssKey = null;
let tray = null;
let quitting = false;
let serverUp = false;

function displayForWindow() {
  if (win && windowState.bounds) {
    return screen.getDisplayMatching(windowState.bounds);
  }
  return screen.getPrimaryDisplay();
}

// Пользователь может передвинуть и растянуть окно сам, мышью в Windows.
// Такие границы запоминаем и в следующий раз открываемся там же.
function boundsUsable(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  if (bounds.width < 240 || bounds.height < 200) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return bounds.x + bounds.width > area.x + 40
      && bounds.x < area.x + area.width - 40
      && bounds.y + bounds.height > area.y + 40
      && bounds.y < area.y + area.height - 40;
  });
}

function panelBounds() {
  const saved = windowState.panelBounds;
  if (boundsUsable(saved)) {
    const { workArea } = screen.getDisplayMatching(saved);
    return {
      x: Math.round(Math.min(Math.max(saved.x, workArea.x - saved.width + 80), workArea.x + workArea.width - 80)),
      y: Math.round(Math.min(Math.max(saved.y, workArea.y), workArea.y + workArea.height - 80)),
      width: Math.round(Math.min(saved.width, workArea.width)),
      height: Math.round(Math.min(saved.height, workArea.height)),
    };
  }
  const { workArea } = displayForWindow();
  const width = Math.max(320, Math.round(config.panelWidth));
  const height = Math.max(240, Math.round(workArea.height * (config.panelHeightRatio || 1 / 3)));
  return {
    x: workArea.x + workArea.width - width - PANEL_MARGIN,
    y: workArea.y + workArea.height - height - PANEL_MARGIN,
    width,
    height,
  };
}

function windowBounds() {
  const { workArea } = displayForWindow();
  const saved = windowState.bounds;
  if (saved && saved.width >= 600 && saved.height >= 400) {
    return {
      x: Math.min(Math.max(saved.x, workArea.x), workArea.x + workArea.width - 400),
      y: Math.min(Math.max(saved.y, workArea.y), workArea.y + workArea.height - 300),
      width: Math.min(saved.width, workArea.width),
      height: Math.min(saved.height, workArea.height),
    };
  }
  const width = Math.min(1180, workArea.width - 80);
  const height = Math.min(860, workArea.height - 80);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

function applyMode(mode, { persist = true } = {}) {
  if (!win) return;
  windowState.mode = mode;
  const bounds = mode === 'panel' ? panelBounds() : windowBounds();
  setBoundsProgrammatically(bounds);
  layoutViews();
  applyZoom();
  if (persist) saveWindowState();
  refreshTray();
  pushState();
}

function layoutViews() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (toolbarView) {
    toolbarView.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  }
  if (harnessView) {
    harnessView.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT),
    });
  }
  if (settingsView && settingsVisible) {
    // Настройки занимают верх окна, низ остаётся открытым: правки стекла,
    // размеров и шрифтов видно сразу, не закрывая панель настроек.
    const margin = 8;
    const visibleStrip = 150;
    const panelHeight = Math.max(220, height - visibleStrip - margin);
    settingsView.setBounds({
      x: margin,
      y: margin,
      width: Math.max(120, width - margin * 2),
      height: Math.min(panelHeight, height - margin * 2),
    });
  }
}

function pushState() {
  if (!toolbarView) return;
  const payload = {
    mode: windowState.mode,
    alwaysOnTop: windowState.alwaysOnTop,
    serverUp,
    settingsOpen: settingsVisible,
    glass: !!config.glass,
    glassAlpha: config.glassAlpha ?? 0.55,
    url: safeDisplayUrl(),
  };
  try {
    toolbarView.webContents.send('widget:state', payload);
  } catch { /* окно ещё не готово */ }
}

function safeDisplayUrl() {
  try {
    return new URL(resolveTargetUrl()).origin;
  } catch {
    return '';
  }
}

function targetBounds() {
  return windowState.mode === 'panel' ? panelBounds() : windowBounds();
}

// Запоминаем текущую геометрию окна в том режиме, в котором оно находится.
function rememberBounds() {
  if (!win) return;
  if (windowState.mode === 'window') windowState.bounds = win.getBounds();
  else windowState.panelBounds = win.getBounds();
  saveWindowState();
}

// Программная установка границ: помечаем, чтобы обработчики move/resize
// не приняли её за ручную правку пользователя.
let applyingBounds = false;
let applyingTimer = null;

function setBoundsProgrammatically(bounds) {
  if (!win) return;
  applyingBounds = true;
  win.setBounds(bounds);
  clearTimeout(applyingTimer);
  applyingTimer = setTimeout(() => { applyingBounds = false; }, 150);
}

// Окно выезжает из-за правого края и уезжает обратно. Двигаем только позицию,
// размер не трогаем — так движение ровное и без пересчёта раскладки.
// Кадров больше, чем у системного таймера по умолчанию: на 8 мс движение
// выглядит слитно, а позиция считается от времени, поэтому рывки таймера
// не искажают траекторию.
const ANIMATION_MS = 320;
const ANIMATION_STEP_MS = 8;
let animationTimer = null;
let animating = false;

function offscreenBounds(bounds) {
  return { ...bounds, x: bounds.x + bounds.width + 32 };
}

function stopAnimation() {
  if (animationTimer) clearInterval(animationTimer);
  animationTimer = null;
  animating = false;
}

function animateWindowTo(target, { onDone } = {}) {
  if (!win) return;
  stopAnimation();
  const start = win.getBounds();
  if (start.x === target.x && start.y === target.y) {
    win.setBounds(target);
    onDone?.();
    return;
  }
  const startedAt = Date.now();
  animating = true;
  animationTimer = setInterval(() => {
    if (!win) {
      stopAnimation();
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / ANIMATION_MS);
    const eased = 1 - (1 - progress) ** 3; // плавное торможение к концу
    const x = Math.round(start.x + (target.x - start.x) * eased);
    const y = Math.round(start.y + (target.y - start.y) * eased);
    if (process.env.WIDGET_ANIM_TEST) {
      console.log('[widget] кадр', x, `${Math.round(progress * 100)}%`);
    }
    // setPosition легче, чем setBounds: размер не меняется, лишней проверки нет.
    if (typeof win.setPosition === 'function') win.setPosition(x, y);
    else win.setBounds({ x, y, width: target.width, height: target.height });
    if (progress >= 1) {
      stopAnimation();
      // Последний кадр — программный: не считаем его ручной правкой.
      applyingBounds = true;
      clearTimeout(applyingTimer);
      applyingTimer = setTimeout(() => { applyingBounds = false; }, 150);
      onDone?.();
    }
  }, ANIMATION_STEP_MS);
}

function showWindow() {
  if (!win) return;
  const target = targetBounds();
  windowState.visible = true;
  if (config.animate === false) {
    setBoundsProgrammatically(target);
    win.show();
    win.focus();
    pushState();
    return;
  }
  // Начинаем за экраном и въезжаем в рабочую область.
  setBoundsProgrammatically(offscreenBounds(target));
  win.show();
  win.focus();
  animateWindowTo(target, { onDone: pushState });
  pushState();
}

function hideWindow() {
  if (!win) return;
  const target = targetBounds();
  windowState.visible = false;
  if (config.animate === false) {
    win.hide();
    return;
  }
  animateWindowTo(offscreenBounds(target), {
    onDone: () => {
      win?.hide();
      // Возвращаем рабочую позицию, чтобы следующее появление начиналось верно.
      if (win) setBoundsProgrammatically(target);
    },
  });
}

function toggleWindow() {
  if (!win) return;
  if (windowState.visible && win.isVisible()) hideWindow();
  else showWindow();
}

// Косметика поверх интерфейса харнесса. Файл widget.css применяется к странице
// виджета и не затрагивает браузер; WIDGET_CSS добавляет временный файл для отладки.
async function applyUserCss() {
  const candidates = [path.join(__dirname, 'widget.css'), EXTRA_CSS].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      await harnessView.webContents.insertCSS(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('[widget] не удалось применить CSS', file, err.message);
    }
  }
}

// Скрипт-скин страницы: превращает чип модели в значок с кодом модели и
// уровнем рассуждений. Выполняется внутри страницы, браузера не касается.
async function applyUserScript() {
  const file = path.join(__dirname, 'widget.js');
  if (!fs.existsSync(file)) return;
  try {
    await harnessView.webContents.executeJavaScript(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[widget] не удалось применить скрипт:', err.message);
  }
}

let authRetries = 0;
let retryTimer = null;
let retryCount = 0;

// Харнесс поднимается в фоне и может стартовать позже виджета: пока сервер молчит,
// тихо проверяем порт и подключаемся сами.
function scheduleRetry() {
  if (retryTimer || SCREENSHOT_MODE) return;
  retryTimer = setInterval(async () => {
    retryCount += 1;
    if (await probeServer(resolveTargetUrl())) {
      stopRetry();
      loadHarness();
    } else if (retryCount >= 60) {
      stopRetry();
      console.warn('[widget] сервер так и не ответил — переподключение остановлено');
    }
  }, 5000);
}

function stopRetry() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  retryCount = 0;
}

async function loadHarness() {
  if (!harnessView) return;
  const url = resolveTargetUrl();
  serverUp = await probeServer(url);
  pushState();
  if (serverUp) stopRetry();
  try {
    await harnessView.webContents.loadURL(url);
  } catch (err) {
    console.error('[widget] не удалось загрузить UI харнесса:', err.message);
  }
  applyZoom();
  if (!serverUp) scheduleRetry();
}

// Страница авторизации отвечает 401, если сохранённый токен устарел после
// перезапуска харнесса. Тогда один раз перечитываем свежий токен из состояния.
async function isUnauthorizedPage() {
  try {
    const text = await harnessView.webContents.executeJavaScript(
      'document.body ? String(document.body.innerText).slice(0, 200) : ""',
    );
    return /(^|\D)401(\D|$)|Unauthorized/i.test(text) && text.length < 120;
  } catch {
    return false;
  }
}

function applyZoom() {
  if (!harnessView) return;
  // Масштаб страницы задаётся отдельно для панели и для полного окна.
  const fallback = typeof config.zoom === 'number' ? config.zoom : 1;
  const raw = windowState.mode === 'panel'
    ? (typeof config.zoomPanel === 'number' ? config.zoomPanel : fallback * 0.8)
    : (typeof config.zoomWindow === 'number' ? config.zoomWindow : fallback);
  const zoom = Math.max(0.6, Math.min(2.5, raw));
  const override = Number(process.env.WIDGET_ZOOM || 0);
  try {
    harnessView.webContents.setZoomFactor(override > 0 ? override : zoom);
  } catch { /* noop */ }
}

function glassEnabled() {
  return process.platform === 'win32' && !!config.glass;
}

// Горячая клавиша может быть занята другой программой — тогда регистрация
// возвращает false, и мы возвращаем прежнее сочетание.
let hotkeyError = '';

function registerHotkey(accelerator) {
  try {
    globalShortcut.unregisterAll();
  } catch { /* нечего снимать */ }
  try {
    return globalShortcut.register(accelerator, toggleWindow);
  } catch (err) {
    console.error('[widget] горячая клавиша:', err.message);
    return false;
  }
}

// Системный материал окна. Он определяет, что видно сквозь панель:
//   без материала — то, что реально находится за окном (яркая игра остаётся яркой);
//   Acrylic — то же самое, но размытое, зато со своей тёмной подложкой;
//   Mica — обои рабочего стола, а не то, что за окном.
// По умолчанию берём «без материала»: это самый прозрачный вариант.
const GLASS_MATERIALS = ['acrylic', 'mica'];
let activeMaterial = 'none';

function blurEnabled() {
  return glassEnabled() && config.blur === true;
}

function applyGlass() {
  if (!win || process.platform !== 'win32') return;
  const on = glassEnabled();
  if (!on) {
    try {
      win.setBackgroundMaterial('none');
      activeMaterial = 'none';
    } catch (err) {
      console.error('[widget] материал окна:', err.message);
    }
    try {
      win.setBackgroundColor('#12141a');
    } catch (err) {
      console.error('[widget] цвет окна:', err.message);
    }
    return;
  }
  if (blurEnabled()) {
    for (const material of GLASS_MATERIALS) {
      try {
        win.setBackgroundMaterial(material);
        activeMaterial = material;
        break;
      } catch {
        /* пробуем следующий материал */
      }
    }
  } else {
    try {
      win.setBackgroundMaterial('none');
      activeMaterial = 'none';
    } catch { /* материал недоступен — окно просто остаётся прозрачным */ }
  }
  try {
    win.setBackgroundColor('#00000000');
  } catch (err) {
    console.error('[widget] цвет окна:', err.message);
  }
}

function createWindow() {
  const glass = glassEnabled();
  win = new BaseWindow({
    show: false,
    frame: false,
    minWidth: 320,
    minHeight: 400,
    // Прозрачность окна задаётся только при создании. Её включает сам режим стекла,
    // поэтому переключение режима пересоздаёт окно (см. rebuildWindow) — иначе
    // окно потеряло бы системную тень, оставаясь прозрачным.
    transparent: glass,
    backgroundColor: glass ? '#00000000' : '#12141a',
    backgroundMaterial: glass && config.blur === true ? GLASS_MATERIALS[0] : 'none',
    alwaysOnTop: windowState.alwaysOnTop,
    skipTaskbar: false,
    title: 'Harness',
    ...(windowState.mode === 'panel' ? panelBounds() : windowBounds()),
  });

  toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-toolbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(toolbarView);
  toolbarView.webContents.loadFile(path.join(__dirname, 'toolbar.html'));

  harnessView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-harness.js'),
      partition: 'persist:harness-widget',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.contentView.addChildView(harnessView);
  layoutViews();

  // Своя подложка у вьюх перекрыла бы системное стекло — делаем их прозрачными.
  for (const view of [toolbarView, harnessView]) {
    try {
      view.setBackgroundColor('#00000000');
    } catch { /* метод может отсутствовать */ }
  }

  if (windowState.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');

  harnessView.webContents.on('did-finish-load', async () => {
    const current = harnessView.webContents.getURL();
    if (current.startsWith('file://')) {
      serverUp = false;
      pushState();
      return;
    }
    serverUp = true;
    pushState();
    applyZoom();
    await applyUserCss();
    await applyDynamicCss();
    await applyUserScript();
    if (authRetries < 2 && await isUnauthorizedPage()) {
      authRetries += 1;
      console.warn('[widget] страница без авторизации — повтор с свежим токеном');
      loadHarness();
    }
  });
  harnessView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = прервано навигацией
    serverUp = false;
    pushState();
    console.error('[widget] ошибка загрузки:', errorCode, errorDescription, validatedURL);
    if (config.launcherDir && fs.existsSync(launcherScript('Start-Harness.ps1'))) {
      const offline = path.join(__dirname, 'offline.html');
      harnessView.webContents.loadFile(offline, {
        query: { message: errorDescription || 'сервер недоступен' },
      });
    }
  });

  win.on('resize', () => {
    // Во время анимации размер не меняется — пересчёт раскладки только мешал бы.
    if (!animating) layoutViews();
    if (animating || applyingBounds) return;
    rememberBounds();
  });
  win.on('move', () => {
    if (animating || applyingBounds) return;
    rememberBounds();
  });
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hideWindow();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  loadHarness().then(() => {
    showWindow();
  });
}

// Прозрачность окна задаётся только при создании, поэтому смена режима стекла
// пересоздаёт окно. Страница перезагружается; сессия живёт на сервере и вернётся.
function rebuildWindow() {
  const settingsOpen = settingsVisible;
  hideSettings();
  if (win) {
    win.destroy();
    win = null;
    toolbarView = null;
    harnessView = null;
    settingsView = null;
    dynamicCssKey = null;
    settingsVisible = false;
  }
  createWindow();
  if (settingsOpen) setTimeout(() => showSettings(), 1500);
}

// ---------------------------------------------------------------- tray

function trayIcon() {
  const file = path.join(ROOT, 'assets', 'icon.png');
  if (fs.existsSync(file)) {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const up = serverUp;
  return Menu.buildFromTemplate([
    { label: up ? 'Harness: сервер работает' : 'Harness: сервер недоступен', enabled: false },
    { type: 'separator' },
    { label: 'Показать / скрыть', accelerator: config.hotkey, click: toggleWindow },
    {
      label: 'Компактная панель',
      type: 'radio',
      checked: windowState.mode === 'panel',
      click: () => applyMode('panel'),
    },
    {
      label: 'Полное окно',
      type: 'radio',
      checked: windowState.mode === 'window',
      click: () => applyMode('window'),
    },
    { type: 'separator' },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: windowState.alwaysOnTop,
      click: (item) => {
        windowState.alwaysOnTop = item.checked;
        win?.setAlwaysOnTop(item.checked, 'floating');
        saveWindowState();
        pushState();
      },
    },
    { label: 'Обновить страницу', click: () => loadHarness() },
    {
      label: 'Вернуть панель к правому краю',
      click: () => {
        windowState.panelBounds = null;
        applyMode('panel');
      },
    },
    { type: 'separator' },
    { label: 'Запустить харнесс', click: () => { runLauncher('Start-Harness.ps1'); setTimeout(() => loadHarness(), 6000); } },
    { label: 'Остановить харнесс', click: () => runLauncher('Stop-Harness.ps1') },
    { type: 'separator' },
    {
      label: 'Запускать при входе в Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: app.isPackaged ? [] : [ROOT],
        });
      },
    },
    { label: 'Папка виджета', click: () => shell.openPath(ROOT) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Harness Widget');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWindow);
}

function refreshTray() {
  tray?.setContextMenu(buildTrayMenu());
}

// ---------------------------------------------------------------- настройки

function saveConfig() {
  try {
    const user = readJson(CONFIG_PATH) || {};
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...user, ...config }, null, 2)}\n`);
  } catch (err) {
    console.error('[widget] не удалось сохранить config.json:', err.message);
  }
}

function settingsPayload() {
  return {
    panelWidth: config.panelWidth,
    panelHeightRatio: config.panelHeightRatio,
    menuScale: config.menuScale ?? 1,
    modelScale: config.modelScale ?? 1,
    glass: !!config.glass,
    glassAlpha: config.glassAlpha ?? 0.55,
    cardAlpha: config.cardAlpha ?? 0.7,
    hotkey: config.hotkey,
    hotkeyError,
    animate: config.animate !== false,
    blur: config.blur === true,
    zoomPanel: config.zoomPanel ?? 0.8,
  };
}

function pushSettings() {
  if (settingsView && settingsVisible) {
    try {
      settingsView.webContents.send('settings:state', settingsPayload());
    } catch { /* окно ещё не готово */ }
  }
}

// Масштаб меню и диалога модели — это CSS поверх страницы харнесса.
// Он пересобирается при каждом изменении ползунка.
function buildDynamicCss() {
  const rules = [];
  const menu = Number(config.menuScale ?? 1);
  const model = Number(config.modelScale ?? 1);
  // Плотность тона поверх стекла: 1 — непрозрачно, меньше — сильнее виден задник.
  // Карточка ввода задаётся отдельно и по умолчанию плотнее фона.
  const glassOn = !!config.glass;
  const glassAlpha = glassOn ? Number(config.glassAlpha ?? 0.55) : 1;
  const cardAlpha = glassOn ? Number(config.cardAlpha ?? 0.7) : 1;
  rules.push(
    `:root { --widget-glass-alpha: ${glassAlpha}; --widget-card-alpha: ${cardAlpha};`
    + ` --widget-card-percent: ${Math.round(cardAlpha * 100)}%; }`,
  );

  // Панель настроек харнесса свёрстана под широкое окно. При крупном масштабе
  // страницы её собственная область вёрстки сжимается до размеров компактной
  // панели, и двухколоночная раскладка ломается. Компенсируем масштаб страницы,
  // чтобы панель получила свой натуральный размер.
  const pageZoom = windowState.mode === 'panel'
    ? Number(config.zoomPanel) || 1
    : Number(config.zoomWindow) || 1;
  if (pageZoom > 1.01) {
    const inverse = (1 / pageZoom).toFixed(4);
    rules.push(
      '@media (max-width: 900px) {'
      // Панель хочет 800px, но её режет max-width: calc(100vw - 48px), и колонке
      // содержимого остаётся ~80px. Отдаём панели всю ширину окна в её собственных
      // координатах: 100vw делим на масштаб, которым мы её сжимаем.
      + ` [class*="_panel"]:has([class*="_navTitle"]) { zoom: ${inverse} !important;`
      + ` width: calc(100vw / ${inverse}) !important; max-width: none !important;`
      // Высота тоже считается от 100vh без учёта масштаба, из-за чего панель
      // занимала чуть больше половины окна. Компенсируем тем же делителем.
      + ` height: calc((100vh - 24px) / ${inverse}) !important; }`
      // Страницы харнесса, кроме самой переписки, тоже свёрстаны под широкое окно.
      // Разговору масштаб нужен как есть (его и увеличивали), а страницам вроде
      // Plugins — натуральный размер: иначе текст идёт по слову в строке.
      // Переписку узнаём по полю ввода, оно есть только у неё.
      + ` [class*="_centerCol"]:not(:has([class*="_composerSeat"])) {`
      + ` zoom: ${inverse} !important; width: calc(100vw / ${inverse}) !important; }`
      + ' }',
    );
  }
  if (menu !== 1) {
    // Меню и так наложение: масштабируем его содержимое, ширину колонки не трогаем.
    rules.push(
      '[class*="_sidebarCol"] > * > [class*="_root"]:not([class*="_collapsed"])'
      + ` { zoom: ${menu} !important; }`,
    );
  }
  if (model !== 1) {
    rules.push(`[role="menu"] { zoom: ${model} !important; }`);
  }
  return rules.join('\n');
}

async function applyDynamicCss() {
  if (!harnessView) return;
  try {
    if (dynamicCssKey) {
      await harnessView.webContents.removeInsertedCSS(dynamicCssKey);
      dynamicCssKey = null;
    }
    const css = buildDynamicCss();
    if (css) dynamicCssKey = await harnessView.webContents.insertCSS(css);
  } catch (err) {
    console.error('[widget] не удалось применить масштаб:', err.message);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applySettings(patch = {}) {
  let resized = false;
  let rebuild = false;

  if (patch.reset) {
    config.panelWidth = DEFAULT_CONFIG.panelWidth;
    config.panelHeightRatio = DEFAULT_CONFIG.panelHeightRatio;
    config.menuScale = DEFAULT_CONFIG.menuScale;
    config.modelScale = DEFAULT_CONFIG.modelScale;
    config.glassAlpha = DEFAULT_CONFIG.glassAlpha;
    config.cardAlpha = DEFAULT_CONFIG.cardAlpha;
    if (!!config.glass !== DEFAULT_CONFIG.glass) {
      config.glass = DEFAULT_CONFIG.glass;
      rebuild = true;
    }
    resized = true;
  }
  if (typeof patch.glass === 'boolean' && patch.glass !== !!config.glass) {
    config.glass = patch.glass;
    rebuild = true;
  }
  if (typeof patch.glassAlpha === 'number') {
    config.glassAlpha = clamp(patch.glassAlpha, 0.15, 1);
  }
  if (typeof patch.cardAlpha === 'number') {
    config.cardAlpha = clamp(patch.cardAlpha, 0.15, 1);
  }
  if (typeof patch.animate === 'boolean') {
    config.animate = patch.animate;
    if (!patch.animate) stopAnimation();
  }
  // Размытие фона можно менять на лету: прозрачность окна уже включена.
  if (typeof patch.blur === 'boolean') {
    config.blur = patch.blur;
    applyGlass();
  }
  if (typeof patch.hotkey === 'string' && patch.hotkey && patch.hotkey !== config.hotkey) {
    const previous = config.hotkey;
    if (registerHotkey(patch.hotkey)) {
      config.hotkey = patch.hotkey;
      hotkeyError = '';
      refreshTray();
    } else {
      registerHotkey(previous);
      hotkeyError = `Сочетание ${patch.hotkey} занято другой программой`;
    }
  }
  if (typeof patch.panelWidth === 'number') {
    config.panelWidth = Math.round(clamp(patch.panelWidth, 320, 900));
    resized = true;
  }
  if (typeof patch.panelHeightRatio === 'number') {
    config.panelHeightRatio = clamp(patch.panelHeightRatio, 0.15, 1);
    resized = true;
  }
  // Ползунки размера — явное указание, где и какого размера должна быть панель:
  // забываем ручную правку мышью, иначе она перебила бы настройку.
  if (resized) windowState.panelBounds = null;
  if (patch.resetBounds) {
    windowState.panelBounds = null;
    windowState.bounds = null;
    resized = true;
  }
  if (typeof patch.menuScale === 'number') {
    config.menuScale = clamp(patch.menuScale, 0.5, 3);
  }
  if (typeof patch.modelScale === 'number') {
    config.modelScale = clamp(patch.modelScale, 0.5, 3);
  }
  // Основной размер текста. От него зависит и компенсация масштаба для страниц
  // харнесса, поэтому пересобираем динамический CSS.
  if (typeof patch.zoomPanel === 'number') {
    config.zoomPanel = clamp(patch.zoomPanel, 0.6, 2.2);
    applyZoom();
    applyDynamicCss();
  }

  if (rebuild) {
    saveConfig();
    rebuildWindow();
    pushSettings();
    console.log('[widget] настройки применены:', JSON.stringify(settingsPayload()));
    return;
  }

  if (resized) applyMode(windowState.mode);
  applyDynamicCss();
  saveConfig();
  pushSettings();
  pushState();
  console.log('[widget] настройки применены:', JSON.stringify(settingsPayload()));
}
function createSettingsView() {
  settingsView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsView.webContents.loadFile(path.join(__dirname, 'settings.html'));
}

function showSettings() {
  if (!win) return;
  if (!settingsView) createSettingsView();
  if (!settingsVisible) {
    win.contentView.addChildView(settingsView);
    settingsVisible = true;
  }
  layoutViews();
  settingsView.webContents.focus();
  pushSettings();
  pushState();
}

function hideSettings() {
  if (!win || !settingsView || !settingsVisible) return;
  win.contentView.removeChildView(settingsView);
  settingsVisible = false;
  harnessView?.webContents.focus();
  pushState();
}

function toggleSettings() {
  if (settingsVisible) hideSettings();
  else showSettings();
}

// ---------------------------------------------------------------- ipc

// Диагностика прозрачности: страница присылает найденные полупрозрачные
// поверхности, мы складываем их в файл — чтобы разбирать проблему на живом окне.
ipcMain.on('widget:opacity-report', (_event, payload) => {
  try {
    const file = path.join(ROOT, 'shots', 'opacity-report.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) list = [];
    } catch { list = []; }
    list.push({ at: new Date().toISOString(), entries: payload });
    fs.writeFileSync(file, JSON.stringify(list.slice(-40), null, 2));
    console.log('[widget] отчёт о прозрачности:', JSON.stringify(payload).slice(0, 400));
  } catch (err) {
    console.error('[widget] отчёт:', err.message);
  }
});

ipcMain.on('widget:action', (_event, action) => {
  switch (action) {
    case 'close':
      hideWindow();
      break;
    case 'quit':
      quitting = true;
      app.quit();
      break;
    case 'toggle-mode':
      applyMode(windowState.mode === 'panel' ? 'window' : 'panel');
      refreshTray();
      break;
    case 'toggle-pin':
      windowState.alwaysOnTop = !windowState.alwaysOnTop;
      win?.setAlwaysOnTop(windowState.alwaysOnTop, 'floating');
      saveWindowState();
      pushState();
      refreshTray();
      break;
    case 'reload':
      loadHarness();
      break;
    case 'start-harness':
      runLauncher('Start-Harness.ps1');
      setTimeout(() => loadHarness(), 8000);
      break;
    case 'open-browser':
      shell.openExternal(resolveTargetUrl());
      break;
    case 'open-settings':
      toggleSettings();
      break;
    default:
      break;
  }
});

ipcMain.handle('settings:get', () => settingsPayload());
ipcMain.on('settings:set', (_event, patch) => {
  console.log('[widget] settings:set', JSON.stringify(patch));
  applySettings(patch || {});
});
ipcMain.on('settings:close', () => hideSettings());

ipcMain.handle('widget:get-state', () => ({
  mode: windowState.mode,
  alwaysOnTop: windowState.alwaysOnTop,
  serverUp,
}));

// ---------------------------------------------------------------- screenshots

async function captureScreenshots(tag = '') {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const suffix = tag ? `-${tag}` : '';
  const shots = [
    ['toolbar', toolbarView],
    ['harness', harnessView],
    ['settings', settingsVisible ? settingsView : null],
  ];
  for (const [name, view] of shots) {
    if (!view) continue;
    try {
      const image = await view.webContents.capturePage();
      const file = path.join(SHOT_DIR, `${name}${suffix}.png`);
      fs.writeFileSync(file, image.toPNG());
      console.log('[widget] снимок:', file);
    } catch (err) {
      console.error('[widget] снимок не удался:', name, err.message);
    }
  }
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    loadWindowState();
    createWindow();
    createTray();

    const ok = registerHotkey(config.hotkey);
    if (!ok) {
      hotkeyError = `Сочетание ${config.hotkey} занято другой программой`;
      console.error('[widget] не удалось занять горячую клавишу', config.hotkey);
    }

    if (process.env.WIDGET_MOVE_TEST) {
      // Проверка памяти положения: двигаем окно как мышью, затем прячем и показываем.
      setTimeout(() => {
        const moved = { x: 1100, y: 160, width: 620, height: 520 };
        console.log('[widget] двигаем вручную:', JSON.stringify(moved));
        win.setBounds(moved);
        setTimeout(() => {
          console.log('[widget] запомнили:', JSON.stringify(windowState.panelBounds));
          hideWindow();
          setTimeout(() => {
            showWindow();
            setTimeout(() => {
              console.log('[widget] после скрытия и показа:', JSON.stringify(win.getBounds()));
              quitting = true;
              app.quit();
            }, 1000);
          }, 1000);
        }, 700);
      }, 6000);
    }
    if (process.env.WIDGET_ANIM_TEST) {
      // Проверка анимации: прячем и показываем окно, печатая кадры.
      setTimeout(() => {
        console.log('[widget] прячем');
        hideWindow();
        setTimeout(() => {
          console.log('[widget] показываем');
          showWindow();
          setTimeout(() => {
            quitting = true;
            app.quit();
          }, 1200);
        }, 1200);
      }, 6000);
    }
    if (process.env.WIDGET_SETTINGS) showSettings();
    if (process.env.WIDGET_SETTINGS_TEST) {
      // Сквозная проверка: двигаем ползунки в самом окне настроек, как это делает
      // пользователь, и смотрим, что из этого доходит до окна и до страницы.
      createSettingsView();
      settingsView.webContents.once('did-finish-load', async () => {
        try {
          const moved = await settingsView.webContents.executeJavaScript(
            process.env.WIDGET_SETTINGS_TEST,
          );
          console.log('[widget] ползунки:', JSON.stringify(moved));
        } catch (err) {
          console.error('[widget] проверка настроек:', err.message);
        }
      });
      showSettings();
    }
    if (process.env.WIDGET_APPLY_SETTINGS) {
      try {
        applySettings(JSON.parse(process.env.WIDGET_APPLY_SETTINGS));
      } catch (err) {
        console.error('[widget] WIDGET_APPLY_SETTINGS:', err.message);
      }
    }

    if (process.env.WIDGET_CLEAR_DRAFT) {
      // Отладка: очистить черновик в поле ввода настоящими нажатиями клавиш —
      // прямое изменение DOM не проходит через состояние React.
      setTimeout(async () => {
        try {
          win.focus();
          harnessView.webContents.focus();
          await harnessView.webContents.executeJavaScript(
            'document.querySelector(\'[class*="_input"]\')?.focus(); true',
          );
          for (const [type, keyCode, modifiers] of [
            ['keyDown', 'A', ['control']],
            ['keyUp', 'A', ['control']],
            ['keyDown', 'Delete', []],
            ['keyUp', 'Delete', []],
          ]) {
            harnessView.webContents.sendInputEvent({ type, keyCode, modifiers });
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
          const text = await harnessView.webContents.executeJavaScript(
            'String(document.querySelector(\'[class*="_input"]\')?.textContent || "")',
          );
          console.log('[widget] черновик после очистки:', JSON.stringify(text));
        } catch (err) {
          console.error('[widget] очистка черновика:', err.message);
        }
        if (SCREENSHOT_MODE) await captureScreenshots(process.env.WIDGET_SHOT_TAG || '');
        quitting = true;
        app.quit();
      }, 6000);
    } else if (EVAL_CODE) {
      const wait = Number(process.env.WIDGET_EVAL_WAIT || 9000);
      setTimeout(async () => {
        // Необязательный настоящий клик мышью перед проверкой: синтетические
        // события React иногда не принимает.
        if (process.env.WIDGET_CLICK_AT) {
          try {
            const point = await harnessView.webContents.executeJavaScript(
              `(() => { const el = document.querySelector(${JSON.stringify(process.env.WIDGET_CLICK_AT)});`
              + ' if (!el) return null; const r = el.getBoundingClientRect();'
              + ' return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()',
            );
            if (point) {
              const hoverOnly = process.env.WIDGET_CLICK_MODE === 'hover';
              const types = hoverOnly ? ['mouseMove'] : ['mouseDown', 'mouseUp'];
              for (const type of types) {
                harnessView.webContents.sendInputEvent({
                  type, x: point.x, y: point.y, button: 'left', clickCount: 1,
                });
              }
              await new Promise((resolve) => setTimeout(resolve, Number(process.env.WIDGET_CLICK_WAIT || 1200)));
            }
          } catch (err) {
            console.error('[widget] клик:', err.message);
          }
        }
        try {
          const result = await harnessView.webContents.executeJavaScript(EVAL_CODE);
          const text = JSON.stringify(result, null, 2);
          if (process.env.WIDGET_EVAL_OUT) {
            fs.writeFileSync(process.env.WIDGET_EVAL_OUT, JSON.stringify({
              windowBounds: win ? win.getBounds() : null,
              contentBounds: win ? win.getContentBounds() : null,
              harnessViewBounds: harnessView ? harnessView.getBounds() : null,
              mode: windowState.mode,
              zoomFactor: harnessView ? harnessView.webContents.getZoomFactor() : null,
              page: result,
            }, null, 2));
          }
        } catch (err) {
          console.error('[widget] eval error:', err.message);
        }
        if (SCREENSHOT_MODE) {
          await captureScreenshots(process.env.WIDGET_SHOT_TAG || '');
        }
        if (process.env.WIDGET_KEEP) return; // окно остаётся открытым для снятия экрана
        quitting = true;
        app.quit();
      }, wait);
    } else if (SCREENSHOT_MODE) {
      const wait = Number(process.env.WIDGET_SHOT_WAIT || 9000);
      setTimeout(async () => {
        await captureScreenshots(process.env.WIDGET_SHOT_TAG || '');
        quitting = true;
        app.quit();
      }, wait);
    }
  });

  app.on('window-all-closed', (event) => {
    event?.preventDefault?.();
  });

  app.on('activate', () => showWindow());

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    saveWindowState();
  });
}

