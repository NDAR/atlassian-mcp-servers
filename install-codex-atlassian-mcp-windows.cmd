@echo off
setlocal

set "DEFAULT_INSTALL_ROOT=%LOCALAPPDATA%\NDAR\AtlassianMcp"
if "%INSTALL_ROOT%"=="" set "INSTALL_ROOT=%DEFAULT_INSTALL_ROOT%"

if "%NODE_VERSION%"=="" set "NODE_VERSION=v22.17.0"
if "%REPO_ZIP_URL%"=="" set "REPO_ZIP_URL=https://github.com/NDAR/atlassian-mcp-servers/archive/refs/heads/main.zip"

set "NODE_ROOT=%INSTALL_ROOT%\node"
set "SERVER_ROOT=%INSTALL_ROOT%\atlassian-mcp-servers"
set "SCRIPT_DIR=%~dp0"
set "TEMP_ROOT=%TEMP%\ndar-atlassian-mcp-%RANDOM%%RANDOM%"

echo NDAR Atlassian MCP installer for Codex Desktop on Windows
echo This installer does not require admin rights and does not use PowerShell.
echo.

call :require_command curl.exe "curl.exe is required to download portable Node.js and MCP server files."
if errorlevel 1 goto fail

call :require_command tar.exe "tar.exe is required to extract ZIP files."
if errorlevel 1 goto fail

call :find_node
if errorlevel 1 goto fail

call :install_server_files
if errorlevel 1 goto fail

echo.
echo Running MCP server syntax checks...
"%NODE_EXE%" --check "%SERVER_ROOT%\confluence-mcp-server\src\server.mjs"
if errorlevel 1 (
  echo Confluence MCP server syntax check failed.
  goto fail
)

"%NODE_EXE%" --check "%SERVER_ROOT%\jira-mcp-server\src\server.mjs"
if errorlevel 1 (
  echo Jira MCP server syntax check failed.
  goto fail
)

echo MCP server syntax checks passed.
echo.
echo Starting the Codex configuration installer.
echo It will ask for the Confluence URL, Jira URL, Confluence PAT, and Jira PAT.
echo.

"%NODE_EXE%" "%SERVER_ROOT%\install-codex-atlassian-mcp.mjs"
if errorlevel 1 goto fail

call :cleanup
echo.
echo Done. Quit and reopen Codex Desktop before using the Confluence and Jira MCP tools.
exit /b 0

:require_command
where %~1 >nul 2>nul
if errorlevel 1 (
  echo %~2
  echo Ask desktop support to allow %~1 or use the PowerShell installer if PowerShell is allowed.
  exit /b 1
)
exit /b 0

:find_node
set "NODE_EXE="

if exist "%NODE_ROOT%\node.exe" (
  set "NODE_EXE=%NODE_ROOT%\node.exe"
  call :check_node_version
  if not errorlevel 1 (
    echo Using portable Node.js: %NODE_EXE%
    exit /b 0
  )
)

for /f "delims=" %%N in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%N"
)

if defined NODE_EXE (
  call :check_node_version
  if not errorlevel 1 (
    echo Using existing Node.js: %NODE_EXE%
    exit /b 0
  )
)

call :install_portable_node
exit /b %ERRORLEVEL%

:check_node_version
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%V in ('"%NODE_EXE%" --version 2^>nul') do set "NODE_MAJOR=%%V"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if "%NODE_MAJOR%"=="" exit /b 1
if %NODE_MAJOR% GEQ 18 exit /b 0
exit /b 1

:install_portable_node
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  set "NODE_ARCH=arm64"
) else (
  set "NODE_ARCH=x64"
)

if "%NODE_ZIP_URL%"=="" set "NODE_ZIP_URL=https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-%NODE_ARCH%.zip"

set "NODE_TEMP=%TEMP_ROOT%\node"
set "NODE_ZIP=%NODE_TEMP%\node.zip"

echo.
echo Installing portable Node.js under %NODE_ROOT%
echo Download URL: %NODE_ZIP_URL%

mkdir "%NODE_TEMP%" >nul 2>nul
if errorlevel 1 (
  echo Could not create temporary folder: %NODE_TEMP%
  exit /b 1
)

curl.exe -L --fail -o "%NODE_ZIP%" "%NODE_ZIP_URL%"
if errorlevel 1 (
  echo Failed to download portable Node.js.
  exit /b 1
)

tar.exe -xf "%NODE_ZIP%" -C "%NODE_TEMP%"
if errorlevel 1 (
  echo Failed to extract portable Node.js.
  exit /b 1
)

set "EXPANDED_NODE="
for /d %%D in ("%NODE_TEMP%\node-*") do set "EXPANDED_NODE=%%~fD"

if "%EXPANDED_NODE%"=="" (
  echo Could not find extracted Node.js folder.
  exit /b 1
)

if exist "%NODE_ROOT%" rmdir /s /q "%NODE_ROOT%"
mkdir "%NODE_ROOT%" >nul 2>nul
xcopy "%EXPANDED_NODE%\*" "%NODE_ROOT%\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo Failed to copy portable Node.js to %NODE_ROOT%
  exit /b 1
)

set "NODE_EXE=%NODE_ROOT%\node.exe"
call :check_node_version
if errorlevel 1 (
  echo Portable Node.js install failed or installed a version older than Node.js 18.
  exit /b 1
)

echo Using portable Node.js: %NODE_EXE%
exit /b 0

:install_server_files
echo.
echo Installing MCP server files under %SERVER_ROOT%

set "SOURCE_ROOT="
if exist "%SCRIPT_DIR%install-codex-atlassian-mcp.mjs" if exist "%SCRIPT_DIR%confluence-mcp-server\src\server.mjs" if exist "%SCRIPT_DIR%jira-mcp-server\src\server.mjs" set "SOURCE_ROOT=%SCRIPT_DIR:~0,-1%"

if not defined SOURCE_ROOT (
  call :download_repo_source
  if errorlevel 1 exit /b 1
)

if exist "%SERVER_ROOT%" rmdir /s /q "%SERVER_ROOT%"
mkdir "%SERVER_ROOT%" >nul 2>nul

copy "%SOURCE_ROOT%\install-codex-atlassian-mcp.mjs" "%SERVER_ROOT%\" >nul
if errorlevel 1 (
  echo Failed to copy install-codex-atlassian-mcp.mjs.
  exit /b 1
)

xcopy "%SOURCE_ROOT%\confluence-mcp-server" "%SERVER_ROOT%\confluence-mcp-server\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo Failed to copy Confluence MCP server files.
  exit /b 1
)

xcopy "%SOURCE_ROOT%\jira-mcp-server" "%SERVER_ROOT%\jira-mcp-server\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo Failed to copy Jira MCP server files.
  exit /b 1
)

xcopy "%SOURCE_ROOT%\skills" "%SERVER_ROOT%\skills\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo Failed to copy Codex skill files.
  exit /b 1
)

echo Installed MCP server files: %SERVER_ROOT%
exit /b 0

:download_repo_source
set "REPO_TEMP=%TEMP_ROOT%\repo"
set "REPO_ZIP=%REPO_TEMP%\repo.zip"

echo Downloading MCP server files from %REPO_ZIP_URL%

mkdir "%REPO_TEMP%" >nul 2>nul
if errorlevel 1 (
  echo Could not create temporary folder: %REPO_TEMP%
  exit /b 1
)

curl.exe -L --fail -o "%REPO_ZIP%" "%REPO_ZIP_URL%"
if errorlevel 1 (
  echo Failed to download MCP server files.
  exit /b 1
)

tar.exe -xf "%REPO_ZIP%" -C "%REPO_TEMP%"
if errorlevel 1 (
  echo Failed to extract MCP server files.
  exit /b 1
)

for /d %%D in ("%REPO_TEMP%\*") do (
  if exist "%%~fD\install-codex-atlassian-mcp.mjs" if exist "%%~fD\confluence-mcp-server\src\server.mjs" if exist "%%~fD\jira-mcp-server\src\server.mjs" set "SOURCE_ROOT=%%~fD"
)

if not defined SOURCE_ROOT (
  echo Could not find MCP server files in the downloaded ZIP.
  exit /b 1
)

exit /b 0

:cleanup
if exist "%TEMP_ROOT%" rmdir /s /q "%TEMP_ROOT%"
exit /b 0

:fail
call :cleanup
echo.
echo Install failed.
exit /b 1
