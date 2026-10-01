'use strict';

// Harness Widget — компактная панель Windows поверх работающего веб-хоста Harness.
// Оболочка не подменяет харнесс: она подключается к тому же серверу (127.0.0.1:3080),
// поэтому профиль, сессии и история остаются теми же, что в браузере.

const {
  app, BaseWindow, WebContentsView, ipcMain, screen, Tray, Menu,
  nativeImage, globalShortcut, shell, net, Notification,
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
// Флаг автозагрузки: виджет стартует скрытым и ждёт в трее, пока его не позовут
// горячей клавишей. Именно с этим аргументом он прописывается в автозапуск Windows.
const START_HIDDEN = process.argv.includes('--hidden');
// Отладочные хуки: WIDGET_EVAL — выполнить JS на странице харнесса и напечатать результат,
// WIDGET_CSS — внедрить CSS-файл перед снятием снимка.
const EVAL_CODE = process.env.WIDGET_EVAL || '';
const EXTRA_CSS = process.env.WIDGET_CSS || '';

// ---------------------------------------------------------------- config

const DEFAULT_CONFIG = {
  launcherDir: '',
  url: '',
  hotkey: 'Control+Alt+H',
  // Вторая клавиша: открыть виджет и сразу встать в поле ввода.
  focusHotkey: 'Control+Shift+Space',
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
  // Открывать окно сразу при входе в Windows. По умолчанию виджет ждёт в трее,
  // пока его не позовут горячей клавишей.
  showOnStartup: false,
  // Показывать окно, когда агент закончил отвечать.
  popupOnAnswer: true,
  // Показывать уведомление Windows о готовом ответе и звук к нему.
  notifyOnAnswer: true,
  notifySound: true,
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
let focusHotkeyError = '';
// Состояние агента для значка в трее: idle | busy | done.
let agentState = 'idle';
// Момент начала работы агента — для времени в подсказке трея.
let busySince = 0;
// Пункт меню трея «Остановить агента», доступный только во время работы.
let trayStopItem = null;
// Пока агент работает, подсказка трея обновляет время каждую секунду.
let trayTimer = null;

// Автозапуск при входе в Windows. По умолчанию виджет прописывается с флагом
// --hidden: стартует скрытым, живёт в трее и появляется по горячей клавише.
// Включённая настройка «Открывать при входе сразу» убирает этот флаг.
// Аргументы, с которыми виджет прописывается в автозагрузку.
function autostartArgs() {
  const args = app.isPackaged ? [] : [ROOT];
  if (config.showOnStartup !== true) args.push('--hidden');
  return args;
}

// Состояние автозапуска. Спрашивать нужно ровно с теми же аргументами, с которыми
// запись создавалась: Electron сравнивает их с текущими и без совпадения отвечает
// «выключено», хотя запись в реестре есть.
function autostartEnabled() {
  try {
    return app.getLoginItemSettings({
      path: process.execPath,
      args: autostartArgs(),
    }).openAtLogin === true;
  } catch {
    return false;
  }
}

function setAutostart(enable) {
  const args = autostartArgs();
  try {
    app.setLoginItemSettings({
      openAtLogin: enable,
      path: process.execPath,
      args,
    });
    console.log('[widget] автозапуск:', enable ? 'включён' : 'выключен', JSON.stringify(args));
  } catch (err) {
    console.error('[widget] автозапуск:', err.message);
  }
}

// Открывает виджет и ставит курсор в поле ввода — чтобы сразу печатать.
function focusComposer() {
  if (!windowState.visible) showWindow();
  if (!harnessView) return;
  win?.focus();
  harnessView.webContents.focus();
  harnessView.webContents.executeJavaScript(
    '(() => { const input = document.querySelector(\'[class*="_input"]\');'
    + ' if (!input) return false; input.focus();'
    + ' const range = document.createRange(); range.selectNodeContents(input);'
    + ' const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);'
    + ' return true; })()',
  ).catch(() => { /* страница ещё не готова — окно всё равно показано */ });
}

// Две горячие клавиши: показать/скрыть и «сразу писать». Обе регистрируем заново,
// потому что globalShortcut не умеет менять сочетание на месте.
function registerHotkeys() {
  try {
    globalShortcut.unregisterAll();
  } catch { /* нечего снимать */ }
  const errors = { hotkey: '', focusHotkey: '' };
  const bind = (accelerator, handler, which) => {
    if (!accelerator) return;
    try {
      if (!globalShortcut.register(accelerator, handler)) {
        errors[which] = `Сочетание ${accelerator} занято другой программой`;
      }
    } catch (err) {
      errors[which] = `Сочетание ${accelerator} не принято системой`;
      console.error('[widget] горячая клавиша:', err.message);
    }
  };
  bind(config.hotkey, toggleWindow, 'hotkey');
  bind(config.focusHotkey, focusComposer, 'focusHotkey');
  return errors;
}

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
  // Окно вернули в фокус — состояние «ответ готов» в трее больше не нужно.
  win.on('focus', () => {
    if (agentState === 'done') {
      agentState = 'idle';
      updateTrayState();
    }
  });

  loadHarness().then(() => {
    // Запуск из автозагрузки: окно ждёт в трее, пока его не позовут горячей
    // клавишей или кликом по значку.
    if (START_HIDDEN) {
      windowState.visible = false;
      pushState();
      return;
    }
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

// ---------------------------------------------------------------- журнал

// Пишем вывод виджета в файл: при запуске через .cmd консоль не видна, и без
// журнала разбираться с ошибками нечем. Файл подрезается, чтобы не расти вечно.
const LOG_PATH = path.join(app.getPath('userData'), 'widget.log');
const LOG_LIMIT = 256 * 1024;

function writeLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
    const stats = fs.statSync(LOG_PATH);
    if (stats.size > LOG_LIMIT) {
      // Оставляем последнюю половину: свежие записи важнее старых.
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      fs.writeFileSync(LOG_PATH, content.slice(Math.floor(content.length / 2)));
    }
  } catch {
    /* журнал не должен мешать работе */
  }
}

function mirrorConsoleToFile() {
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const text = args
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
        .join(' ');
      writeLog(`[${stamp()}] ${level.toUpperCase()} ${text}\n`);
    };
  }
}

// Периодически проверяем, жив ли харнесс. Если он поднялся заново, виджет
// возвращает страницу сам — без кнопки «обновить» и без перезапуска.
function startHealthWatch() {
  setInterval(async () => {
    if (serverUp || !win) return;
    const url = resolveTargetUrl();
    if (!url) return;
    try {
      await new Promise((resolve, reject) => {
        const request = net.request({ method: 'GET', url });
        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', resolve);
        });
        request.on('error', reject);
        request.end();
      });
      console.log('[widget] харнесс снова отвечает — переподключаюсь');
      loadHarness();
    } catch {
      /* ещё не поднялся — попробуем в следующий раз */
    }
  }, 15000);
}

// Переход «агент начал работать»: обновляем значок и запускаем отсчёт времени.
function setAgentBusy() {
  if (agentState === 'busy') return;
  agentState = 'busy';
  busySince = Date.now();
  updateTrayState();
  if (!trayTimer) trayTimer = setInterval(updateTrayState, 1000);
}

// Переход «агент ответил»: значок, всплытие и уведомление с текстом ответа.
function handleAgentAnswer(text) {
  agentState = 'done';
  busySince = 0;
  if (trayTimer) {
    clearInterval(trayTimer);
    trayTimer = null;
  }
  updateTrayState();
  console.log('[widget] ответ агента готов; окно было видимо:', windowState.visible,
    '| текст для уведомления:', String(text || '').slice(0, 60) || '(нет)');
  if (config.popupOnAnswer !== false && !windowState.visible) {
    showWindow();
    win?.flashFrame(true);
  }
  notifyAnswer(text);
}

// Остановить агента из трея: нажимаем ту же кнопку, что и в интерфейсе.
function stopAgent() {
  if (!harnessView) return;
  harnessView.webContents.executeJavaScript(
    '(() => { const b = document.querySelector(\'[class*="_composerSeat"] [class*="_primary"]\');'
    + ' if (!b) return "кнопки нет"; const label = b.getAttribute("aria-label") || "";'
    + ' if (!/stop/i.test(label)) return "агент не генерирует"; b.click(); return "нажата"; })()',
  ).then((result) => console.log('[widget] остановка агента:', result)).catch(() => {});
}

function trayIcon(variant = 'idle') {
  const names = { idle: 'icon.png', busy: 'icon-busy.png', done: 'icon-done.png' };
  for (const name of [names[variant], names.idle]) {
    const file = path.join(ROOT, 'assets', name);
    if (!fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

// Состояние агента в трее: работает — янтарная точка, ответил — зелёная.
// Как только окно получило фокус, состояние возвращается к обычному.
function sessionTitle() {
  try {
    return (harnessView && harnessView.webContents.getTitle()) || '';
  } catch {
    return '';
  }
}

function elapsedLabel() {
  if (!busySince) return '';
  const total = Math.max(0, Math.round((Date.now() - busySince) / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function updateTrayState() {
  if (!tray) return;
  const variant = agentState === 'busy' ? 'busy' : (agentState === 'done' ? 'done' : 'idle');
  tray.setImage(trayIcon(variant));
  const session = sessionTitle();
  const parts = ['Harness Widget'];
  if (session) parts.push(session);
  if (variant === 'busy') parts.push(`агент работает ${elapsedLabel()}`.trim());
  else if (variant === 'done') parts.push('ответ готов');
  else if (serverUp === false) parts.push('харнесс недоступен');
  tray.setToolTip(parts.join(' — '));
  // Пункт «Остановить агента» имеет смысл только пока агент работает.
  if (trayStopItem) trayStopItem.enabled = variant === 'busy';
}

// Тост Windows о готовом ответе: всплытие окна не видно, если ты в полноэкранной
// игре, а уведомление видно всегда. Показываем первые строки ответа, чтобы чаще
// хватало одного взгляда, и по клику открываем виджет с курсором в поле ввода.
function notifyAnswer(answer) {
  if (config.notifyOnAnswer === false) return;
  if (!Notification.isSupported()) return;
  try {
    const session = sessionTitle();
    const body = String(answer || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const notification = new Notification({
      title: session ? `${session} — ответ готов` : 'Ответ готов',
      body: body || 'Агент закончил отвечать — можно посмотреть результат.',
      icon: path.join(ROOT, 'assets', 'icon-done.png'),
      silent: config.notifySound === false,
    });
    notification.on('click', () => focusComposer());
    notification.show();
  } catch (err) {
    console.error('[widget] уведомление:', err.message);
  }
}

function buildTrayMenu() {
  // Пункт создаём заранее: на него ссылается updateTrayState, включая и выключая его.
  trayStopItem = { label: 'Остановить агента', enabled: agentState === 'busy', click: stopAgent };
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
    trayStopItem,
    { label: 'Настройки', click: () => { showWindow(); showSettings(); } },
    { label: 'Открыть журнал', click: () => shell.openPath(LOG_PATH) },
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
      checked: autostartEnabled(),
      click: (item) => {
        setAutostart(item.checked);
        refreshTray();
      },
    },
    {
      label: 'Открывать при входе сразу',
      type: 'checkbox',
      checked: config.showOnStartup === true,
      click: (item) => {
        config.showOnStartup = item.checked;
        saveConfig();
        if (autostartEnabled()) setAutostart(true);
        refreshTray();
      },
    },
    { label: 'Папка виджета', click: () => shell.openPath(ROOT) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon('idle'));
  updateTrayState();
  console.log('[widget] значок в трее создан:', JSON.stringify({ tip: tray ? 'да' : 'нет' }));
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
    focusHotkey: config.focusHotkey,
    focusHotkeyError,
    launcherDir: config.launcherDir || '',
    url: config.url || '',
    animate: config.animate !== false,
    blur: config.blur === true,
    popupOnAnswer: config.popupOnAnswer !== false,
    notifyOnAnswer: config.notifyOnAnswer !== false,
    notifySound: config.notifySound !== false,
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
    // Масштаб диалога выбора модели задаём размером шрифта, а не zoom: zoom
    // сбивает позиционирование всплывающего окна, и оно уезжает от кнопки.
    // Компактные списки (класс _list_) сюда не попадают — у них свой вид.
    const base = Math.round(16 * model);
    const cell = Math.round(13 * model);
    rules.push(
      `[role="menu"]:not([class*="_list_"]) { font-size: ${base}px !important; }`,
      `[role="menu"]:not([class*="_list_"]) [class*="_cell"],`
      + ` [role="menu"]:not([class*="_list_"]) [class*="_cellLabel"],`
      + ` [role="menu"]:not([class*="_list_"]) [class*="_cellValue"]`
      + ` { font-size: ${cell}px !important; }`,
    );
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
  if (typeof patch.popupOnAnswer === 'boolean') {
    config.popupOnAnswer = patch.popupOnAnswer;
  }
  if (typeof patch.notifyOnAnswer === 'boolean') {
    config.notifyOnAnswer = patch.notifyOnAnswer;
  }
  if (typeof patch.notifySound === 'boolean') {
    config.notifySound = patch.notifySound;
  }
  // Горячие клавиши: обе перерегистрируются вместе, потому что globalShortcut
  // не умеет менять сочетание на месте. Если новое занято — остаётся прежнее.
  const hotkeyChanged = (typeof patch.hotkey === 'string' && patch.hotkey && patch.hotkey !== config.hotkey)
    || (typeof patch.focusHotkey === 'string' && patch.focusHotkey && patch.focusHotkey !== config.focusHotkey);
  if (hotkeyChanged) {
    const previous = { hotkey: config.hotkey, focusHotkey: config.focusHotkey };
    if (typeof patch.hotkey === 'string' && patch.hotkey) config.hotkey = patch.hotkey;
    if (typeof patch.focusHotkey === 'string' && patch.focusHotkey) config.focusHotkey = patch.focusHotkey;

    const errors = registerHotkeys();
    if (config.hotkey === config.focusHotkey) {
      errors.focusHotkey = 'Это сочетание уже занято первой горячей клавишей';
    }
    if (errors.hotkey || errors.focusHotkey) {
      // Что-то не занялось: возвращаем прежние сочетания и сообщаем причину.
      config.hotkey = previous.hotkey;
      config.focusHotkey = previous.focusHotkey;
      const retry = registerHotkeys();
      hotkeyError = errors.hotkey || '';
      focusHotkeyError = errors.focusHotkey || '';
      if (!hotkeyError && retry.hotkey) hotkeyError = '';
    } else {
      hotkeyError = '';
      focusHotkeyError = '';
    }
    refreshTray();
  }
  if (typeof patch.launcherDir === 'string' && patch.launcherDir !== config.launcherDir) {
    config.launcherDir = patch.launcherDir;
  }
  if (typeof patch.url === 'string' && patch.url !== config.url) {
    config.url = patch.url;
    // Адрес мог измениться — перечитываем страницу с новым.
    setTimeout(() => loadHarness(), 300);
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

// Страница сообщает о состоянии агента: busy — начал работать, answer — закончил.
// В сообщении об ответе приходит и текст, чтобы уведомление было содержательным.
ipcMain.on('widget:notify', (_event, payload) => {
  const kind = payload && payload.kind;
  if (kind === 'busy') setAgentBusy();
  else if (kind === 'answer') handleAgentAnswer(payload.text);
});

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
    // Агент начал отвечать — янтарная точка в трее.
    case 'agent-busy':
      setAgentBusy();
      break;
    // Агент закончил: зелёная точка, всплытие и уведомление Windows.
    case 'agent-answer':
      handleAgentAnswer('');
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

// Имя и идентификатор приложения для Windows. Без них система считает виджет
// безымянным «Electron»: так он подписан в трее и уведомлениях, и по клику на
// уведомление Windows запускает новый процесс вместо уже работающего окна.
const APP_ID = 'com.blazeeers.harnesswidget';
app.setName('Harness Widget');
app.setAppUserModelId(APP_ID);

// Ярлык в меню «Пуск» с тем же идентификатором: по нему Windows понимает, какому
// приложению принадлежит уведомление, и передаёт клик работающему экземпляру.
function ensureAppShortcut() {
  if (process.platform !== 'win32') return;
  try {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, 'Harness Widget.lnk');
    shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      args: app.isPackaged ? [] : [ROOT],
      cwd: ROOT,
      description: 'Harness Widget',
      appUserModelId: APP_ID,
      icon: path.join(ROOT, 'assets', 'icon.png'),
      iconIndex: 0,
    });
    console.log('[widget] ярлык приложения готов:', link);
  } catch (err) {
    console.error('[widget] ярлык приложения:', err.message);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Второй запуск (в том числе клик по уведомлению) не создаёт новое окно,
  // а показывает уже работающее.
  app.on('second-instance', () => {
    console.log('[widget] повторный запуск — показываю существующее окно');
    focusComposer();
  });

  app.whenReady().then(async () => {
    mirrorConsoleToFile();
    ensureAppShortcut();
    loadWindowState();
    createWindow();
    createTray();
    startHealthWatch();

    ({ hotkeyError, focusHotkeyError } = registerHotkeys());
    if (hotkeyError) console.error('[widget] горячая клавиша:', hotkeyError);
    if (focusHotkeyError) console.error('[widget] клавиша ввода:', focusHotkeyError);

    // Разовая настройка автозапуска из командной строки:
    // WIDGET_AUTOSTART=1 включает, WIDGET_AUTOSTART=0 выключает.
    if (process.env.WIDGET_AUTOSTART) {
      setAutostart(process.env.WIDGET_AUTOSTART !== '0');
      refreshTray();
    }
    console.log(
      '[widget] старт: автозапуск',
      autostartEnabled() ? 'включён' : 'выключен',
      START_HIDDEN ? '(скрыто, ждёт в трее)' : '(окно показано)',
    );

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
    if (process.env.WIDGET_FOCUS_TEST) {
      // Проверка клавиши «писать сразу»: показать окно и встать в поле ввода.
      setTimeout(() => {
        focusComposer();
        console.log('[widget] фокус в поле ввода запрошен');
      }, 6000);
    }
    if (process.env.WIDGET_ANSWER_TEST) {
      // Проверка всплытия: прячем окно, дальше страница сама сообщит о готовом ответе.
      setTimeout(() => {
        hideWindow();
        console.log('[widget] окно спрятано — ждём ответ агента');
      }, 7000);
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












