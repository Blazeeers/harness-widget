#!/usr/bin/env bash
# Портативная сборка для Linux: папка и архив, которым не нужны Node.js и npm.
#
#   ./tools/build-portable.sh
#
# На выходе:
#   dist-linux/HarnessWidget/                папка (запуск через HarnessWidget.sh)
#   dist-linux/HarnessWidget-portable.tar.gz архив

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist-linux"
APP="$DIST/HarnessWidget"
RUNTIME_SRC="$ROOT/node_modules/electron/dist"

if [ ! -x "$RUNTIME_SRC/electron" ]; then
  echo "Не найден Electron в $RUNTIME_SRC — сначала выполните npm install." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/tools"

for item in src assets package.json config.example.json LICENSE README.md README.en.md; do
  if [ -e "$ROOT/$item" ]; then
    cp -r "$ROOT/$item" "$APP/"
  fi
done
cp "$ROOT/tools/make-icon.js" "$APP/tools/"
cp "$ROOT/start.sh" "$APP/HarnessWidget.sh"
chmod +x "$APP/HarnessWidget.sh"

# Рантайм Electron: только dist, без npm-обвязки.
mkdir -p "$APP/runtime"
cp -r "$RUNTIME_SRC/." "$APP/runtime/"
chmod +x "$APP/runtime/electron"

# Ярлык автозапуска: тот же .desktop, что пишет виджет из настроек.
cat > "$APP/Автозапуск.sh" <<'LAUNCHER'
#!/usr/bin/env bash
# Прописывает виджет в автозапуск Linux: стартует скрытым и ждёт в трее.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/harness-widget.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Harness Widget
Exec=$DIR/HarnessWidget.sh
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
echo "Готово: виджет будет запускаться при входе в систему и ждать в трее."
LAUNCHER
chmod +x "$APP/Автозапуск.sh"

mkdir -p "$DIST"
ARCHIVE="$DIST/HarnessWidget-portable.tar.gz"
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C "$APP" .

SIZE="$(du -m "$ARCHIVE" | cut -f1)"
echo "Портативная сборка готова:"
echo "  папка:  $APP"
echo "  архив:  $ARCHIVE (${SIZE} МБ)"
