# 終止舊的 SelinaBot 程序 (根據 .env.selina 參數判斷)
$processes = Get-WmiObject Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match "\.env\.selina" }
foreach ($p in $processes) {
    Write-Host "Killing old SelinaBot node (PID: $($p.ProcessId))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# 終止舊的 cmd.exe 包裝程序
$cmdProcesses = Get-WmiObject Win32_Process -Filter "name='cmd.exe'" | Where-Object { $_.CommandLine -match "\.env\.selina" }
foreach ($p in $cmdProcesses) {
    Write-Host "Killing old SelinaBot cmd wrapper (PID: $($p.ProcessId))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# 緩衝 3 秒鐘讓 Windows 系統徹底釋放檔案鎖定與 socket handle
Write-Host "Waiting for handles to release..."
Start-Sleep -Seconds 3

# 解析目錄路徑
$scriptPath = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptPath)) {
    $scriptPath = "C:\Users\Charles\discord-claude-code-bot"
}
Set-Location $scriptPath

Write-Host "Starting SelinaBot persistently via WMI... (Dir: $scriptPath)"
$cmdLine = "cmd.exe /c node --env-file=.env.selina --import=tsx src/index.ts > selina_out.log 2> selina_err.log"
$result = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmdLine, $scriptPath

if ($result.ReturnValue -eq 0) {
    Write-Host "SelinaBot started successfully with PID: $($result.ProcessId)"
} else {
    Write-Error "Failed to start SelinaBot, WMI ReturnValue: $($result.ReturnValue)"
}
