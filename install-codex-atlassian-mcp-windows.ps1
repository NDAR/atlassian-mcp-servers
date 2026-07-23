param(
  [string]$InstallRoot,
  [string]$ConfluenceUrl,
  [string]$JiraUrl,
  [string]$ConfluencePat,
  [string]$JiraPat,
  [string]$RepoZipUrl = "https://github.com/NDAR/atlassian-mcp-servers/archive/refs/heads/main.zip",
  [string]$NodeZipUrl,
  [switch]$ForcePortableNode
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "NDAR\AtlassianMcp"
}

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$ConfigPath = Join-Path $CodexHome "config.toml"
$ServerRoot = Join-Path $InstallRoot "atlassian-mcp-servers"
$NodeRoot = Join-Path $InstallRoot "node"

function Write-Section($Message) {
  Write-Host ""
  Write-Host $Message
  Write-Host ("-" * $Message.Length)
}

function Get-Timestamp {
  return (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
}

function Normalize-BaseUrl($Value) {
  return ([string]$Value).Trim().TrimEnd("/")
}

function Convert-ToTomlPath($Path) {
  return ([System.IO.Path]::GetFullPath($Path)).Replace("\", "/")
}

function Escape-Toml($Value) {
  return ([string]$Value).Replace("\", "\\").Replace('"', '\"')
}

function Read-TomlValue($Toml, $Key) {
  $escaped = [regex]::Escape($Key)
  $match = [regex]::Match($Toml, "(?m)^\s*$escaped\s*=\s*`"((?:\\.|[^`"])*)`"")
  if (-not $match.Success) {
    return ""
  }
  return $match.Groups[1].Value.Replace('\"', '"').Replace("\\", "\")
}

function ConvertFrom-SecureStringPlainText($Value) {
  if (-not $Value) {
    return ""
  }

  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Ask-Text($Label, $ExistingValue) {
  if ($ExistingValue) {
    $answer = Read-Host "$Label [$ExistingValue]"
    if ([string]::IsNullOrWhiteSpace($answer)) {
      return $ExistingValue
    }
    return $answer.Trim()
  }

  return (Read-Host "$Label").Trim()
}

function Ask-Secret($Label, $ExistingValue) {
  $suffix = if ($ExistingValue) { " (press Enter to keep existing)" } else { "" }
  $secure = Read-Host "$Label$suffix" -AsSecureString
  $plain = ConvertFrom-SecureStringPlainText $secure
  if ([string]::IsNullOrWhiteSpace($plain)) {
    return $ExistingValue
  }
  return $plain.Trim()
}

function Get-NodeMajorVersion($NodePath) {
  if (-not $NodePath -or -not (Test-Path $NodePath)) {
    return 0
  }

  try {
    $version = & $NodePath --version 2>$null
    if ($LASTEXITCODE -ne 0) {
      return 0
    }
    if ($version -match "^v(\d+)\.") {
      return [int]$Matches[1]
    }
  } catch {
    return 0
  }

  return 0
}

function Test-NodeSystemCa($NodePath) {
  try {
    $null = & $NodePath --use-system-ca --version 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Find-ExistingNode {
  $localNode = Join-Path $NodeRoot "node.exe"
  if ((Get-NodeMajorVersion $localNode) -ge 18) {
    return $localNode
  }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and (Get-NodeMajorVersion $command.Source) -ge 18) {
    return $command.Source
  }

  return ""
}

function Get-WindowsNodeArch {
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($arch -eq "arm64") {
      return "arm64"
    }
  } catch {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
      return "arm64"
    }
  }

  return "x64"
}

function Get-LatestLtsNodeZipUrl($Arch) {
  $indexUrl = "https://nodejs.org/dist/index.json"
  Write-Host "Finding latest Node.js LTS release..."
  $releases = Invoke-RestMethod -Uri $indexUrl
  $fileName = "win-$Arch-zip"
  $release = $releases | Where-Object { $_.lts -ne $false -and $_.files -contains $fileName } | Select-Object -First 1

  if (-not $release) {
    throw "Could not find a Node.js LTS Windows ZIP for architecture '$Arch'."
  }

  return "https://nodejs.org/dist/$($release.version)/node-$($release.version)-win-$Arch.zip"
}

function Invoke-FileDownload($Uri, $OutFile) {
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
    return
  }

  Invoke-WebRequest -Uri $Uri -OutFile $OutFile
}

function Install-PortableNode {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

  $arch = Get-WindowsNodeArch
  $url = if ($NodeZipUrl) { $NodeZipUrl } else { Get-LatestLtsNodeZipUrl $arch }
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ndar-node-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempDir "node.zip"

  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  try {
    Write-Host "Downloading portable Node.js from $url"
    Invoke-FileDownload $url $zipPath

    Write-Host "Extracting portable Node.js..."
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
    $expanded = Get-ChildItem -Path $tempDir -Directory | Where-Object { $_.Name -like "node-*-win-*" } | Select-Object -First 1
    if (-not $expanded) {
      throw "The Node.js ZIP did not contain the expected folder."
    }

    if (Test-Path $NodeRoot) {
      Remove-Item -Path $NodeRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
    Copy-Item -Path (Join-Path $expanded.FullName "*") -Destination $NodeRoot -Recurse -Force
  } finally {
    if (Test-Path $tempDir) {
      Remove-Item -Path $tempDir -Recurse -Force
    }
  }

  $nodePath = Join-Path $NodeRoot "node.exe"
  if ((Get-NodeMajorVersion $nodePath) -lt 18) {
    throw "Portable Node.js install failed or installed a version older than Node.js 18."
  }

  return $nodePath
}

function Find-LocalRepoSource {
  $root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  $confluenceServer = Join-Path $root "confluence-mcp-server\src\server.mjs"
  $jiraServer = Join-Path $root "jira-mcp-server\src\server.mjs"
  $skill = Join-Path $root "skills\nda-atlassian\SKILL.md"

  if ((Test-Path $confluenceServer) -and (Test-Path $jiraServer) -and (Test-Path $skill)) {
    return $root
  }

  return ""
}

function Download-RepoSource {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ndar-mcp-repo-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempDir "repo.zip"
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  try {
    Write-Host "Downloading MCP server files from $RepoZipUrl"
    Invoke-FileDownload $RepoZipUrl $zipPath

    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
    $source = Get-ChildItem -Path $tempDir -Directory -Recurse |
      Where-Object {
        (Test-Path (Join-Path $_.FullName "confluence-mcp-server\src\server.mjs")) -and
        (Test-Path (Join-Path $_.FullName "jira-mcp-server\src\server.mjs")) -and
        (Test-Path (Join-Path $_.FullName "skills\nda-atlassian\SKILL.md"))
      } |
      Select-Object -First 1

    if (-not $source) {
      throw "Could not find MCP server files in the downloaded ZIP."
    }

    $downloadedRoot = Join-Path $InstallRoot "_downloaded-source"
    if (Test-Path $downloadedRoot) {
      Remove-Item -Path $downloadedRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $downloadedRoot | Out-Null
    Copy-Item -Path (Join-Path $source.FullName "*") -Destination $downloadedRoot -Recurse -Force
    return $downloadedRoot
  } finally {
    if (Test-Path $tempDir) {
      Remove-Item -Path $tempDir -Recurse -Force
    }
  }
}

function Install-ServerFiles($SourceRoot) {
  if (Test-Path $ServerRoot) {
    Remove-Item -Path $ServerRoot -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $ServerRoot | Out-Null
  foreach ($name in @("confluence-mcp-server", "jira-mcp-server", "skills")) {
    Copy-Item -Path (Join-Path $SourceRoot $name) -Destination $ServerRoot -Recurse -Force
  }
}

function Remove-McpSections($Toml) {
  $remove = @{
    "mcp_servers.confluence" = $true
    "mcp_servers.confluence.env" = $true
    "mcp_servers.jira" = $true
    "mcp_servers.jira.env" = $true
  }

  $kept = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in ($Toml -split "`r?`n")) {
    if ($line -match "^\s*\[([^\]]+)\]\s*$") {
      $skipping = $remove.ContainsKey($Matches[1])
    }
    if (-not $skipping) {
      $kept.Add($line)
    }
  }

  return (($kept -join "`n").TrimEnd())
}

function Build-ArgsLine($NodePath, $ServerPath) {
  $serverToml = Escape-Toml (Convert-ToTomlPath $ServerPath)
  if (Test-NodeSystemCa $NodePath) {
    return "args = [`"--use-system-ca`", `"$serverToml`"]"
  }
  return "args = [`"$serverToml`"]"
}

function Build-Config($ExistingConfig, $NodePath, $ConfluenceServer, $JiraServer, $ConfluenceBaseUrl, $JiraBaseUrl, $ConfluenceToken, $JiraToken) {
  $cleaned = Remove-McpSections $ExistingConfig
  $nodeToml = Escape-Toml (Convert-ToTomlPath $NodePath)
  $confluenceArgs = Build-ArgsLine $NodePath $ConfluenceServer
  $jiraArgs = Build-ArgsLine $NodePath $JiraServer
  $confUrl = Escape-Toml (Normalize-BaseUrl $ConfluenceBaseUrl)
  $jiraUrlValue = Escape-Toml (Normalize-BaseUrl $JiraBaseUrl)
  $confPat = Escape-Toml $ConfluenceToken
  $jiraTokenValue = Escape-Toml $JiraToken

  $block = @"

[mcp_servers.confluence]
enabled = true
command = "$nodeToml"
$confluenceArgs

[mcp_servers.confluence.env]
CONFLUENCE_AUTH_MODE = "bearer"
CONFLUENCE_BASE_URL = "$confUrl"
CONFLUENCE_API_PATH = "/rest/api"
CONFLUENCE_PAT = "$confPat"

[mcp_servers.jira]
enabled = true
command = "$nodeToml"
$jiraArgs

[mcp_servers.jira.env]
JIRA_AUTH_MODE = "bearer"
JIRA_BASE_URL = "$jiraUrlValue"
JIRA_API_PATH = "/rest/api/2"
JIRA_PAT = "$jiraTokenValue"
"@

  return $cleaned + $block + "`n"
}

function Install-Skill {
  $skillSource = Join-Path $ServerRoot "skills\nda-atlassian"
  $skillTarget = Join-Path $CodexHome "skills\nda-atlassian"

  if (-not (Test-Path (Join-Path $skillSource "SKILL.md"))) {
    throw "Codex skill was not found at $skillSource"
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $skillTarget -Parent) | Out-Null
  if (Test-Path $skillTarget) {
    $backup = "$skillTarget.backup-$(Get-Timestamp)"
    Copy-Item -Path $skillTarget -Destination $backup -Recurse -Force
    Remove-Item -Path $skillTarget -Recurse -Force
    Write-Host "Created skill backup: $backup"
  }

  Copy-Item -Path $skillSource -Destination $skillTarget -Recurse -Force
  Write-Host "Installed Codex skill: $skillTarget"
}

Write-Host "NDAR Atlassian MCP installer for Codex Desktop on Windows"
Write-Host "This installer does not require admin rights."

Write-Section "Node.js"
$nodePath = ""
if (-not $ForcePortableNode) {
  $nodePath = Find-ExistingNode
}
if (-not $nodePath) {
  $nodePath = Install-PortableNode
}
Write-Host "Using Node.js: $nodePath"

Write-Section "MCP Server Files"
$sourceRoot = Find-LocalRepoSource
if (-not $sourceRoot) {
  $sourceRoot = Download-RepoSource
}
Install-ServerFiles $sourceRoot
Write-Host "Installed MCP server files: $ServerRoot"

$confluenceServerPath = Join-Path $ServerRoot "confluence-mcp-server\src\server.mjs"
$jiraServerPath = Join-Path $ServerRoot "jira-mcp-server\src\server.mjs"

& $nodePath --check $confluenceServerPath | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Confluence MCP server syntax check failed."
}
& $nodePath --check $jiraServerPath | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Jira MCP server syntax check failed."
}
Write-Host "MCP server syntax checks passed."

Write-Section "Codex Configuration"
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$existingConfig = if (Test-Path $ConfigPath) { Get-Content -Path $ConfigPath -Raw } else { "" }

$existingConfluenceUrl = Read-TomlValue $existingConfig "CONFLUENCE_BASE_URL"
$existingJiraUrl = Read-TomlValue $existingConfig "JIRA_BASE_URL"
$existingConfluencePat = Read-TomlValue $existingConfig "CONFLUENCE_PAT"
$existingJiraPat = Read-TomlValue $existingConfig "JIRA_PAT"

if (-not $ConfluenceUrl) {
  $ConfluenceUrl = Ask-Text "Confluence URL" $(if ($existingConfluenceUrl) { $existingConfluenceUrl } else { "https://wiki.nimhda.org" })
}
if (-not $JiraUrl) {
  $JiraUrl = Ask-Text "Jira URL" $(if ($existingJiraUrl) { $existingJiraUrl } else { "https://jira.nimhda.org" })
}
if (-not $ConfluencePat) {
  $ConfluencePat = Ask-Secret "Confluence PAT" $existingConfluencePat
}
if (-not $JiraPat) {
  $JiraPat = Ask-Secret "Jira PAT" $existingJiraPat
}

if ([string]::IsNullOrWhiteSpace($ConfluenceUrl)) {
  throw "Confluence URL is required."
}
if ([string]::IsNullOrWhiteSpace($JiraUrl)) {
  throw "Jira URL is required."
}
if ([string]::IsNullOrWhiteSpace($ConfluencePat)) {
  throw "Confluence PAT is required."
}
if ([string]::IsNullOrWhiteSpace($JiraPat)) {
  throw "Jira PAT is required."
}

$nextConfig = Build-Config $existingConfig $nodePath $confluenceServerPath $jiraServerPath $ConfluenceUrl $JiraUrl $ConfluencePat $JiraPat

if (Test-Path $ConfigPath) {
  $backupPath = "$ConfigPath.backup-$(Get-Timestamp)"
  Copy-Item -Path $ConfigPath -Destination $backupPath -Force
  Write-Host "Created config backup: $backupPath"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ConfigPath, $nextConfig, $utf8NoBom)
Write-Host "Updated Codex config: $ConfigPath"

Install-Skill

Write-Section "Done"
Write-Host "Next steps:"
Write-Host "1. Quit and reopen Codex Desktop."
Write-Host "2. Ask Codex: Search Confluence for NDA data dictionary"
Write-Host "3. Optional check from PowerShell: codex mcp list"
