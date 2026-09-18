#!/bin/bash
# 殺掉所有舊的 bot 進程 (IrisBot)
# 2026-09-11: wmic removed from Windows 11 -> PowerShell Get-CimInstance
for pid in $(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }" 2>/dev/null | grep "index.ts" | grep -v "selina" | grep -v "athena" | cut -d"|" -f1 | tr -d "\r"); do
  taskkill //PID $pid //F 2>/dev/null
done
# 啟動
cd "$(dirname "$0")" && npm start
