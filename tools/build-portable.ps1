# Собирает портативную версию виджета: папку, которую можно скопировать на любой
# компьютер с Windows и запустить без Node.js и npm.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-portable.ps1
#
# На выходе:
#   dist\HarnessWidget\              готовая папка (запуск через HarnessWidget.cmd)
#   dist\HarnessWidget-portable.zip  тот же набор одним архивом

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$app = Join-Path $dist 'HarnessWidget'
$zip = Join-Path $dist 'HarnessWidget-portable.zip'

$runtime = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $runtime 'electron.exe'))) {
  throw "Не найден Electron в $runtime — сначала выполните npm install."
}

if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null

# --- файлы самого виджета ---
foreach ($item in @('src', 'assets', 'package.json', 'config.example.json', 'LICENSE', 'README.md', 'README.en.md')) {
  $from = Join-Path $root $item
  if (Test-Path $from) { Copy-Item $from -Destination $app -Recurse -Force }
}
New-Item -ItemType Directory -Path (Join-Path $app 'tools') -Force | Out-Null
Copy-Item (Join-Path $root 'tools\make-icon.js') -Destination (Join-Path $app 'tools') -Force

# --- рантайм Electron: только dist, без npm-обвязки ---
$target = Join-Path $app 'runtime'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $runtime '*') -Destination $target -Recurse -Force

# --- запуск без консольного окна ---
$launcher = @'
@echo off
rem Harness Widget — портативный запуск.
setlocal
set "WIDGET_DIR=%~dp0"
start "" "%WIDGET_DIR%runtime\electron.exe" "%WIDGET_DIR%."
endlocal
'@
Set-Content -Path (Join-Path $app 'HarnessWidget.cmd') -Value $launcher -Encoding OEM

# --- ярлык автозапуска с ожиданием в трее ---
$autostart = @'
@echo off
rem Добавляет виджет в автозагрузку Windows: стартует скрытым и ждёт в трее.
setlocal
set "WIDGET_DIR=%~dp0"
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v HarnessWidget /t REG_SZ /d "\"%WIDGET_DIR%runtime\electron.exe\" \"%WIDGET_DIR%.\" --hidden" /f
echo Готово: виджет будет запускаться при входе в Windows и ждать в трее.
pause
'@
Set-Content -Path (Join-Path $app 'Автозапуск.cmd') -Value $autostart -Encoding OEM

# --- архив ---
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $app '*') -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Портативная сборка готова:"
Write-Host "  папка:  $app"
Write-Host "  архив:  $zip ($size МБ)"
