'use strict';

// Минимальный мост для страницы харнесса и локальной offline-заглушки.
// Наружу отдаём только безопасный набор действий — без выхода и переключения окна.

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = new Set([
  'reload', 'start-harness', 'open-browser', 'opacity-report', 'agent-answer', 'agent-busy',
]);

contextBridge.exposeInMainWorld('dshWidget', {
  action: (name) => {
    if (ALLOWED.has(String(name))) ipcRenderer.send('widget:action', String(name));
  },
  report: (payload) => {
    try {
      ipcRenderer.send('widget:opacity-report', JSON.parse(JSON.stringify(payload)));
    } catch {
      /* отчёт не критичен */
    }
  },
});

// Флаг для диагностики прозрачности: включается только переменной окружения.
contextBridge.exposeInMainWorld('__WIDGET_OPACITY_REPORT', process.env.WIDGET_OPACITY_REPORT === '1');
