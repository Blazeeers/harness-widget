'use strict';

// Скин поверх страницы харнесса: превращает чип модели в значок с кодом модели
// и уровнем рассуждений. Значения берутся из самой разметки харнесса — в чипе
// всегда лежат скрытые подписи с названием модели и режимом.
// Этот файл выполняется в контексте страницы виджета и не трогает браузер.

(() => {
  if (window.__dshWidgetBadge) return;
  window.__dshWidgetBadge = true;

  // Порядок важен: «max» и «highest» проверяются раньше «high», иначе они
  // попадают под правило high и получают тот же значок.
  const EFFORT_RULES = [
    { key: 'max', letter: 'M', test: /(max|highest|макс|максим)/i },
    { key: 'high', letter: 'H', test: /(high|выс)/i },
    { key: 'medium', letter: 'M', test: /(medium|med\b|mid|сред)/i },
    { key: 'low', letter: 'L', test: /(low|minimal|min\b|низ|мин)/i },
  ];

  // «DeepSeek-V41-Flash» → «FLASH», «DeepSeek-V41-Pro» → «PRO».
  // Для моделей без тарифа остаётся код вида «V41» или «R1».
  function shortModel(text) {
    const value = String(text || '').trim();
    if (/flash/i.test(value)) return 'FLASH';
    if (/pro/i.test(value)) return 'PRO';
    const found = /([A-Za-z])\s?-?\s?(\d+(?:\.\d+)?)/.exec(value);
    if (found) return `${found[1]}${found[2]}`.toUpperCase();
    const cleaned = value.replace(/[^A-Za-z0-9.]/g, '');
    return cleaned.slice(0, 4).toUpperCase() || '?';
  }

  function effortInfo(text) {
    const value = String(text || '').trim();
    for (const rule of EFFORT_RULES) {
      if (rule.test.test(value)) return rule;
    }
    return { key: 'other', letter: value.slice(0, 1).toUpperCase() || '?' };
  }

  function apply() {
    const chip = document.querySelector('[class*="_standardControls"]');
    const button = chip && chip.querySelector('button');
    if (button) {
      const label = chip.querySelector('[class*="_triggerLabel"]');
      const effort = chip.querySelector('[class*="_triggerEffort"]');
      const model = shortModel(label && label.textContent);
      const info = effortInfo(effort && effort.textContent);

      if (button.dataset.modelShort !== model) button.dataset.modelShort = model;
      if (button.dataset.effortKey !== info.key) button.dataset.effortKey = info.key;
      if (button.dataset.effortLetter !== info.letter) button.dataset.effortLetter = info.letter;
    }
    trimJobCount();
  }

  // Счётчик фоновых задач: оставляем только число, слова убираем — в шапке
  // и без них тесно. Полный текст сохраняем в подсказке.
  function trimJobCount() {
    const counter = document.querySelector('[class*="_titleRow"] [class*="_count"]');
    if (!counter) return;
    const text = (counter.textContent || '').replace(/\s+/g, ' ').trim();
    const match = /^(\d[\d\s]*)\s+\D/.exec(text);
    if (!match) return;
    const digits = match[1].replace(/\s+/g, '');
    if (!counter.dataset.widgetFullText) counter.dataset.widgetFullText = text;
    if (text !== digits) {
      counter.textContent = digits;
      counter.setAttribute('title', counter.dataset.widgetFullText);
    }
  }

  // Стеклянный фон: крупные поверхности оболочки делаем прозрачными, чтобы
  // сквозь окно был виден размытый задник. Карточки переписки здесь не трогаем —
  // их плотность задана в CSS. Всплывающие окна (position: fixed) пропускаем:
  // они должны оставаться плотными, иначе дифф и подсказки просвечивают.
  const BASE_BACKGROUNDS = new Set(['rgb(21, 21, 23)', 'rgb(18, 20, 26)']);
  let glassTimer = null;

  function insideOverlay(el) {
    let node = el;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
      if (getComputedStyle(node).position === 'fixed') return true;
      node = node.parentElement;
    }
    return false;
  }

  function glassify() {
    const total = innerWidth * innerHeight;
    if (!total) return;
    document.querySelectorAll('body *').forEach((el) => {
      const background = getComputedStyle(el).backgroundColor;
      if (!BASE_BACKGROUNDS.has(background)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height < total * 0.25) return;
      if (insideOverlay(el)) return;
      el.style.setProperty('background-color', 'transparent', 'important');
    });
  }

  function scheduleGlassify() {
    if (glassTimer) return;
    glassTimer = setTimeout(() => {
      glassTimer = null;
      markOverlays();
      glassify();
    }, 250);
  }

  // Всплывающие слои (меню, подсказки, карточки правок) должны оставаться
  // плотными: сквозь них не должно быть видно переписку. Помечаем их атрибутом,
  // а правила прозрачности в CSS такие элементы пропускают. Положение проверяем
  // вычисленным стилем — селектором position в CSS не выразить.
  // Состояние правой панели. Она открывается отдельным «табом» и рисует свою
  // шапку в той же полосе, что и шапка переписки: пока панель видна, прячем и
  // шапку, и ленту переписки, иначе её содержимое просвечивает полосой. Как
  // только панель ушла — пометки снимаются. Функция вызывается и по таймеру:
  // при закрытии панели разметка может не меняться, и тогда без таймера чат
  // оставался бы скрытым до первого стороннего изменения страницы.
  // Панель считается видимой, только если она реально показана: закрытая
  // остаётся в разметке (сдвинута за край окна) и сохраняет размеры.
  function findPanelPane() {
    return Array.from(document.querySelectorAll('[class*="_tabBody"], [class*="_paneBody"]'))
      .find((el) => {
        if (!/Workspace files|New terminal/.test(el.innerText || '')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 200 || rect.height <= 200) return false;
        if (typeof el.checkVisibility === 'function'
          && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        return true;
      }) || null;
  }

  function revealConversation() {
    document.querySelectorAll('[data-widget-hidden]').forEach((el) => el.removeAttribute('data-widget-hidden'));
  }

  function syncPanelState() {
    const convoHeader = document.querySelector('[class*="_titleRow"]')?.closest('[class*="_header"]');
    const feed = document.querySelector('[class*="_scrollBody"]');
    const panelPane = findPanelPane();
    if (panelPane) {
      convoHeader?.setAttribute('data-widget-hidden', '1');
      feed?.setAttribute('data-widget-hidden', '1');
      panelPane.setAttribute('data-widget-panel', '1');
      panelPane.setAttribute('data-widget-opaque-bg', '1');
    } else {
      convoHeader?.removeAttribute('data-widget-hidden');
      feed?.removeAttribute('data-widget-hidden');
      document.querySelectorAll('[data-widget-panel]').forEach((el) => el.removeAttribute('data-widget-panel'));
    }
  }

  function markOverlays() {
    // 1. Основной признак: контейнеры всплывающих окон. Харнесс кладёт их в
    //    отдельный слой или в «якорь» у кнопки — всё внутри таких контейнеров
    //    должно быть плотным, независимо от размеров и z-index.
    document.querySelectorAll('[class*="_overlayLayer"], [class*="_overlayAnchor"]').forEach((layer) => {
      if (layer.hasAttribute('data-widget-opaque')) return;
      layer.setAttribute('data-widget-opaque', '1');
      markOverlayBackgrounds(layer);
    });    // 2. Всё полупрозрачное вне ленты переписки делаем плотным. Так любая панель
    //    или меню харнесса остаётся читаемой, как бы она ни называлась: стекло
    //    уместно только в переписке и в поле ввода.
    document.querySelectorAll('body *').forEach((el) => {
      if (el.hasAttribute('data-widget-opaque-bg')) return;
      const background = getComputedStyle(el).backgroundColor;
      if (!background) return;
      const translucent = (background.startsWith('rgba(') || background.startsWith('color('))
        && !/[,/]\s*0\)$/.test(background);
      if (!translucent) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) return;
      if (el.closest('[class*="_composerSeat"]') || el.closest('[class*="_scrollBody"]')) return;
      if (/code|editor/i.test(String(el.className || ''))) return;
      el.setAttribute('data-widget-opaque-bg', '1');
    });

    // 3. Правая панель харнесса не рисует фон вовсе — сквозь неё видно переписку.
    //    Делаем плотной только саму панель и только когда она действительно
    //    открыта: закрытая остаётся в разметке и иначе перекрыла бы чат.
    if (document.querySelector('[aria-label="Collapse right sidebar"]')) {
      const pane = Array.from(document.querySelectorAll('[class*="_tabBody"], [class*="_paneBody"]'))
        .find((el) => /Workspace files|New terminal/.test(el.innerText || ''));
      if (pane) pane.setAttribute('data-widget-opaque-bg', '1');
    }

    // 4. Состояние правой панели — вынесено в отдельную функцию: её нужно
    //    проверять и по таймеру, потому что при закрытии панели разметка может
    //    не меняться вовсе.
    syncPanelState();

    // 5. Подстраховка на случай других способов отрисовки всплывающих окон.
    document.querySelectorAll('body *').forEach((el) => {
      if (el.hasAttribute('data-widget-opaque')) return;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
      const z = parseInt(cs.zIndex, 10);
      if (!Number.isFinite(z) || z < 20) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) return;
      el.setAttribute('data-widget-opaque', '1');
      markOverlayBackgrounds(el);
    });
  }

  // Внутри всплывающего слоя фон часто рисует отдельная подложка («материал»)
  // с прозрачностью — именно она пропускает переписку. Делаем плотными все
  // достаточно крупные полупрозрачные поверхности внутри всплывающих слоёв:
  // так правило работает для любого меню, а не только для проверенного.
  function markOverlayBackgrounds(overlay) {
    const nodes = [overlay, ...Array.from(overlay.querySelectorAll('*'))];
    for (const node of nodes) {
      if (node.hasAttribute('data-widget-opaque-bg')) continue;
      const background = getComputedStyle(node).backgroundColor;
      if (!background) continue;
      const translucent = (background.startsWith('rgba(') || background.startsWith('color('))
        && !/[,/]\s*0\)$/.test(background);
      if (!translucent) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 80) continue;
      node.setAttribute('data-widget-opaque-bg', '1');
    }
  }

  // Харнесс перерисовывает чип при смене модели — следим за разметкой,
  // но не чаще одного кадра, чтобы не мешать выводу текста.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
    scheduleGlassify();
  }

  // Диагностика прозрачности. Включается только при запуске с переменной
  // WIDGET_OPACITY_REPORT. Ищет крупные поверхности вне ленты переписки,
  // которые пропускают фон, и отправляет их описание в главный процесс.
  const reported = new Set();

  function reportTranslucent() {
    if (!window.__WIDGET_OPACITY_REPORT || !window.dshWidget?.report) return;
    const found = [];
    document.querySelectorAll('body *').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height < 20000) return;
      if (el.closest('[class*="_scrollBody"]') || el.closest('[class*="_composerSeat"]')) return;
      const cs = getComputedStyle(el);
      const background = cs.backgroundColor || '';
      const translucentBg = (background.startsWith('rgba(') || background.startsWith('color('))
        && !/[,/]\s*0\)$/.test(background);
      const faded = cs.opacity !== '1';
      const blurred = cs.backdropFilter && cs.backdropFilter !== 'none';
      if (!translucentBg && !faded && !blurred) return;
      const key = `${String(el.className).slice(0, 40)}|${Math.round(rect.width)}x${Math.round(rect.height)}|${background}|${cs.opacity}`;
      if (reported.has(key)) return;
      reported.add(key);
      found.push({
        cls: String(el.className).slice(0, 60),
        tag: el.tagName,
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        background,
        opacity: cs.opacity,
        backdropFilter: cs.backdropFilter,
        position: cs.position,
        z: cs.zIndex,
        parentCls: String(el.parentElement?.className || '').slice(0, 60),
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      });
    });
    if (found.length) window.dshWidget.report(found);
  }

  const start = () => {
    apply();
    glassify();
    bindDrawerDismiss();
    const observer = new MutationObserver(() => {
      schedule();
      reportTranslucent();
      syncPanelState();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      // Панель открывается и закрывается сменой класса или стиля — ловим это
      // сразу, не дожидаясь опроса по таймеру.
      attributes: true,
      attributeFilter: ['class', 'style', 'data-state', 'aria-hidden'],
    });
    // Клик по кнопке панели — самый частый случай. Проверяем сразу и короткой
    // серией: панель уезжает с анимацией, важно поймать момент, когда она ушла,
    // а не ждать следующего опроса.
    document.addEventListener('pointerdown', (event) => {
      // Нажали кнопку уже открытой панели — она закрывается. Показываем чат
      // сразу, не дожидаясь, пока панель доиграет свою анимацию.
      const button = event.target instanceof Element ? event.target.closest('button, [role="button"]') : null;
      const label = button?.getAttribute('aria-label') || '';
      if (/sidebar/i.test(label) && findPanelPane()) revealConversation();
      syncPanelState();
      for (const delay of [60, 120, 180, 240, 300, 380, 460, 560, 700]) {
        setTimeout(syncPanelState, delay);
      }
    }, true);
    setInterval(reportTranslucent, 1500);
    // Резервная проверка на случай, если панель ушла без событий.
    setInterval(syncPanelState, 900);
  };

  // Меню сессий выдвигается поверх содержимого. Закрываем его кликом по любому
  // свободному месту — и по Escape. Клик при этом гасим, чтобы он не сработал
  // заодно и по чату под меню.
  let closingDrawer = false;

  function expandedSidebar() {
    const sidebar = document.querySelector('[class*="_sidebarCol"]');
    if (!sidebar) return null;
    if (sidebar.querySelector('[class*="_collapsed"]')) return null;
    return sidebar;
  }

  function closeDrawer(sidebar) {
    const toggle = sidebar.querySelector('[class*="_toggle"]');
    if (!toggle) return false;
    toggle.click();
    return true;
  }

  function bindDrawerDismiss() {
    document.addEventListener('pointerdown', (event) => {
      const sidebar = expandedSidebar();
      if (!sidebar) return;
      if (sidebar.contains(event.target)) return;
      if (!closeDrawer(sidebar)) return;
      closingDrawer = true;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    document.addEventListener('click', (event) => {
      if (!closingDrawer) return;
      closingDrawer = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const sidebar = expandedSidebar();
      if (!sidebar) return;
      if (closeDrawer(sidebar)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
