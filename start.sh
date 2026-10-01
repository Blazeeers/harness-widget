#!/usr/bin/env bash
# Запуск виджета в Linux. Работает и для папки с исходниками (нужен npm install),
# и для портативной сборки, где рантайм лежит рядом в runtime/.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -x "$DIR/runtime/electron" ]; then
  ELECTRON="$DIR/runtime/electron"
elif [ -x "$DIR/node_modules/electron/dist/electron" ]; then
  ELECTRON="$DIR/node_modules/electron/dist/electron"
else
  echo "Не найден Electron. Выполните npm install или используйте портативную сборку." >&2
  exit 1
fi

# Виджет поднимает окно поверх остальных: под Wayland позицию задаёт композитор.
exec "$ELECTRON" "$DIR" "$@"
