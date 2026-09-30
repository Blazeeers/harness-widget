'use strict';

// Минимальная проверка системного стекла: два окна с материалом Acrylic.
// Слева — прозрачное окно, справа — обычное. Оба с полностью прозрачной страницей.

const { app, BaseWindow, WebContentsView } = require('electron');

const PAGE = 'data:text/html,<html><body style="margin:0;height:100vh;background:transparent"></body></html>';

function makeWindow({ x, y, transparent, material }) {
  const win = new BaseWindow({
    width: 380,
    height: 260,
    x,
    y,
    frame: false,
    transparent,
    backgroundColor: '#00000000',
    backgroundMaterial: material,
    alwaysOnTop: true,
    show: false,
  });
  const view = new WebContentsView({ webPreferences: {} });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 380, height: 260 });
  try {
    view.setBackgroundColor('#00000000');
  } catch { /* нет метода */ }
  view.webContents.loadURL(PAGE);
  return win;
}

app.whenReady().then(() => {
  const a = makeWindow({ x: 200, y: 300, transparent: true, material: 'acrylic' });
  const b = makeWindow({ x: 620, y: 300, transparent: false, material: 'acrylic' });
  a.show();
  b.show();
  console.log('[glass-min] окна показаны');
});
