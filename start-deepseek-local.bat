@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "ENV_FILE=.env.deepseek"
set "APP_PORT=4175"
set "APP_URL=http://127.0.0.1:%APP_PORT%/"
set "HEALTH_URL=%APP_URL%api/health"
set "NPM_CONFIG_CACHE=%CD%\.npm-cache"
set "NODE_MODE="
set "NODE_VERSION="

if not exist "%ENV_FILE%" (
  echo [错误] 未找到 %ENV_FILE%。
  echo 请先创建本地 DeepSeek 配置文件。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [错误] 未找到 node_modules。
  echo 请先在 Node.js 20.20.2 环境中执行 npm ci。
  pause
  exit /b 1
)

powershell.exe -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 本地服务已经运行：%APP_URL%
  start "" "%APP_URL%"
  exit /b 0
)

if exist "%CD%\.conda\node.exe" (
  for /f "delims=" %%V in ('"%CD%\.conda\node.exe" -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%V"
  if "%NODE_VERSION%"=="20.20.2" set "NODE_MODE=conda"
)

if not defined NODE_MODE (
  set "NODE_VERSION="
  for /f "delims=" %%V in ('node.exe -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%V"
  if "%NODE_VERSION%"=="20.20.2" set "NODE_MODE=system"
)

if not defined NODE_MODE (
  where npx.cmd >nul 2>nul
  if errorlevel 1 (
    echo [错误] 当前 Node.js 不是 20.20.2，且未找到 npx.cmd。
    echo 请安装 Node.js 20.20.2、Volta 或 NVM 后重试。
    pause
    exit /b 1
  )
  set "NODE_MODE=npx"
  echo [提示] 当前系统 Node.js 不是 20.20.2，将通过 npx 使用精确 Node.js 20.20.2。
)

echo.
echo ========================================
echo 时间管理助手 - DeepSeek 本地人工测试
echo 地址：%APP_URL%
echo 配置：%ENV_FILE%
echo 数据库：data\time-management-deepseek-local.sqlite
echo Node 模式：%NODE_MODE%
echo ========================================
echo.

if not "%TIME_ASSISTANT_NO_BROWSER%"=="1" (
  start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$healthUrl='%HEALTH_URL%'; $appUrl='%APP_URL%';" ^
    "for($i=0; $i -lt 120; $i++){" ^
    "  try{$r=Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1; if($r.StatusCode -eq 200){Start-Process $appUrl; exit 0}}catch{};" ^
    "  Start-Sleep -Milliseconds 500" ^
    "}; Write-Host '[提示] 服务未在 60 秒内通过健康检查，请查看启动窗口。'"
)

if "%NODE_MODE%"=="conda" goto run_conda
if "%NODE_MODE%"=="system" goto run_system
goto run_npx

:run_conda
"%CD%\.conda\node.exe" --env-file=%ENV_FILE% server\index.js
goto server_exit

:run_system
node.exe --env-file=%ENV_FILE% server\index.js
goto server_exit

:run_npx
npx.cmd --yes node@20.20.2 --env-file=%ENV_FILE% server\index.js
goto server_exit

:server_exit
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo [提示] 本地服务已经停止。
) else (
  echo [错误] 服务启动失败，退出码：%EXIT_CODE%
  echo 请检查上方日志、端口占用和 DeepSeek 配置。
)
pause
exit /b %EXIT_CODE%
