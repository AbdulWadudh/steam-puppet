@echo off
setlocal
cd /d "%~dp0"

title SteamPuppet

where bun >nul 2>nul
if errorlevel 1 (
    echo [X] Bun is not installed, or not on your PATH.
    echo     Install it from https://bun.com and run this again.
    goto :done
)

if not exist "node_modules\" (
    echo [*] Installing dependencies...
    call bun install
    if errorlevel 1 goto :done
)

if not exist ".env" (
    echo [*] No .env found - creating one from .env.example
    copy ".env.example" ".env" >nul
    echo.
    echo [!] Open .env and set MOD_TARGET_DIR to your mods folder,
    echo     then run this script again.
    goto :done
)

if not exist "bin\steamcmd.exe" (
    echo [*] SteamCMD is not installed yet - running first-time setup.
    echo     You will be asked for your Steam password and Steam Guard code.
    echo.
    call bun run setup
    if errorlevel 1 goto :done
    echo.
)

echo [*] Starting SteamPuppet. Leave this window open while you download mods.
echo     Press Ctrl+C to stop.
echo.
call bun run start

:done
echo.
echo SteamPuppet has stopped.
pause
