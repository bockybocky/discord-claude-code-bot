#!/bin/bash
# 殺掉所有舊的 SelinaBot 進程 (依賴 .env.selina 參數來識別，不會誤殺 IrisBot)
# 2026-09-11: wmic removed from Windows 11 -> PowerShell Get-CimInstance
for pid in $(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }" 2>/dev/null | grep "\.env\.selina" | cut -d"|" -f1 | tr -d "\r"); do
  taskkill //PID $pid //F 2>/dev/null
done

# 啟動 SelinaBot 於背景
cd "$(dirname "$0")"
nohup node --env-file=.env.selina --import=tsx src/index.ts > selina_out.log 2> selina_err.log < /dev/null &

echo "SelinaBot is starting in the background..."
echo "Logs are saved to selina_out.log and selina_err.log"
