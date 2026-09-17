@echo off
chcp 65001 >nul
title ChatBI 自然语言数据分析 - 启动器

echo ============================================
echo   ChatBI 自然语言数据分析
echo ============================================
echo.

if not exist "%~dp0server\node_modules" (
  echo [!] 后端依赖未安装，正在安装...
  pushd "%~dp0server" && call npm install && popd
)
if not exist "%~dp0web\node_modules" (
  echo [!] 前端依赖未安装，正在安装...
  pushd "%~dp0web" && call npm install && popd
)

if not exist "%~dp0server\.env" (
  echo [!] 缺少 server\.env，请先配置 DEEPSEEK_API_KEY
  pause
  exit /b 1
)

echo [1/2] 启动后端服务 (端口 3002)...
start "ChatBI 后端" cmd /k "cd /d %~dp0server && npm start"

timeout /t 3 /nobreak >nul

echo [2/2] 启动前端服务 (端口 5174)...
start "ChatBI 前端" cmd /k "cd /d %~dp0web && npm run dev"

timeout /t 5 /nobreak >nul

echo.
echo ============================================
echo   启动完成，正在打开浏览器...
echo   前端: http://localhost:5174
echo   后端: http://localhost:3002
echo ============================================
start http://localhost:5174
