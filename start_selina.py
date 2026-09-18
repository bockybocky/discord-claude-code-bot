import subprocess
import os
import sys
import time

def main():
    bot_dir = "C:\\Users\\Charles\\discord-claude-code-bot"
    
    # 1. 尋找並殺死舊的 SelinaBot 進程 (使用 powershell 避開 WMI 故障)
    print("Checking and killing old SelinaBot processes...")
    kill_cmd = ["powershell", "-Command", "Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like '*env.selina*'} | Stop-Process -Force"]
    subprocess.run(kill_cmd, capture_output=True)
    
    kill_cmd2 = ["powershell", "-Command", "Get-Process cmd -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like '*env.selina*'} | Stop-Process -Force"]
    subprocess.run(kill_cmd2, capture_output=True)
    
    # 2. 緩衝 3 秒
    print("Waiting for handles to release...")
    time.sleep(3)
    
    # 3. 啟動新進程，使用 CREATE_NO_WINDOW 標記
    stdout_path = os.path.join(bot_dir, "selina_out.log")
    stderr_path = os.path.join(bot_dir, "selina_err.log")
    
    try:
        stdout_file = open(stdout_path, "w", encoding="utf-8")
    except PermissionError:
        print("Warning: selina_out.log is locked, using selina_out.log.alt")
        stdout_file = open(stdout_path + ".alt", "w", encoding="utf-8")
        
    try:
        stderr_file = open(stderr_path, "w", encoding="utf-8")
    except PermissionError:
        print("Warning: selina_err.log is locked, using selina_err.log.alt")
        stderr_file = open(stderr_path + ".alt", "w", encoding="utf-8")
    
    # Windows-specific flag to run in background without creating a console window.
    # It still attaches to a null console so node.exe doesn't crash on standard streams.
    CREATE_NO_WINDOW = 0x08000000
    flags = CREATE_NO_WINDOW
    
    cmd = ["node", "--env-file=.env.selina", "--import=tsx", "src/index.ts"]
    
    print(f"Starting SelinaBot persistently (Dir: {bot_dir})...")
    p = subprocess.Popen(
        cmd,
        cwd=bot_dir,
        stdout=stdout_file,
        stderr=stderr_file,
        creationflags=flags,
        close_fds=True
    )
    print(f"SelinaBot started successfully in background with PID: {p.pid}")
    
    stdout_file.close()
    stderr_file.close()

if __name__ == "__main__":
    main()
