@echo off
rem Запуск Harness Widget без консольного окна.
setlocal
set "WIDGET_DIR=%~dp0"
start "" "%WIDGET_DIR%node_modules\electron\dist\electron.exe" "%WIDGET_DIR%."
endlocal
