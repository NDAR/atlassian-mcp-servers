# NDAR MCP Servers

Standalone MCP servers for NDAR Atlassian services.

## Servers

- `confluence-mcp-server`: read-only Confluence search and page fetch tools
- `jira-mcp-server`: read-only Jira issue, project, and current-user lookup tools

Each server is dependency-free and uses Node's built-in `fetch`.

## Codex Desktop Setup

These steps add both MCP servers to Codex Desktop.

Choose the section for your operating system:

- [macOS or Linux](#macos-or-linux)
- [Windows](#windows)

You need one personal access token for Confluence and one personal access token for Jira.

Keep these private. Do not paste them into GitHub, Slack, email, tickets, or screenshots.

In the examples below, replace these placeholders with your real values:

```text
PASTE_YOUR_CONFLUENCE_PAT_HERE
PASTE_YOUR_JIRA_PAT_HERE
```

## macOS or Linux

### 1. Install Node.js

These servers require Node.js 18 or newer.

Check whether Node is already installed:

```bash
node --version
```

If the command prints a version like `v18.x`, `v20.x`, or `v22.x`, continue to the next step.

If Node is not installed, install it with Homebrew:

```bash
brew install node
```

Then check again:

```bash
node --version
which node
```

Keep the path printed by `which node`. You will use it as the `command` value in `config.toml`.

### 2. Download This Repository

Put this repository somewhere on your computer. For example:

```bash
git clone https://github.com/NDAR/mcp-servers.git
```

If you do not use Git, download the repository ZIP from GitHub and unzip it.

In the examples below, replace:

```text
/path/to/mcp-servers
```

with the folder where you put this repository.

For example, if this file is at:

```text
/Users/alex/Documents/mcp-servers/README.md
```

then your folder path is:

```text
/Users/alex/Documents/mcp-servers
```

### 3. Open Codex Config

Codex Desktop reads MCP server settings from:

```text
~/.codex/config.toml
```

On macOS, you can open it from Terminal with:

```bash
open -e ~/.codex/config.toml
```

If the file does not exist yet, create it:

```bash
mkdir -p ~/.codex
touch ~/.codex/config.toml
open -e ~/.codex/config.toml
```

### 4. Add The MCP Server Entries

Add these sections to `~/.codex/config.toml`.

Use the path from `which node` for `command`. Common values are `/usr/local/bin/node` on Intel Macs and `/opt/homebrew/bin/node` on Apple Silicon Macs.

Replace `/path/to/mcp-servers` with your repository folder path.

Replace only the two PAT placeholder values with your real tokens.

```toml
[mcp_servers.confluence]
enabled = true
command = "/usr/local/bin/node"
args = ["--use-system-ca", "/path/to/mcp-servers/confluence-mcp-server/src/server.mjs"]

[mcp_servers.confluence.env]
CONFLUENCE_AUTH_MODE = "bearer"
CONFLUENCE_BASE_URL = "https://wiki.nimhda.org"
CONFLUENCE_API_PATH = "/rest/api"
CONFLUENCE_PAT = "PASTE_YOUR_CONFLUENCE_PAT_HERE"

[mcp_servers.jira]
enabled = true
command = "/usr/local/bin/node"
args = ["--use-system-ca", "/path/to/mcp-servers/jira-mcp-server/src/server.mjs"]

[mcp_servers.jira.env]
JIRA_AUTH_MODE = "bearer"
JIRA_BASE_URL = "https://jira.nimhda.org"
JIRA_API_PATH = "/rest/api/2"
JIRA_PAT = "PASTE_YOUR_JIRA_PAT_HERE"
```

If `which node` printed a different path, update both `command` lines. For example:

```toml
command = "/opt/homebrew/bin/node"
```

### 5. Restart Codex

Quit and reopen Codex Desktop after saving `config.toml`.

### 6. Confirm Codex Can See The Servers

In Terminal, run:

```bash
codex mcp list
```

You should see both of these entries:

```text
confluence
jira
```

Both should show `enabled`.

### 7. Try The Tools In Codex

After restarting Codex, ask it to use the Confluence or Jira MCP server. For example:

```text
Search Confluence for NDA data dictionary
```

```text
Search Jira for unresolved issues mentioning validation
```

## Windows

### 1. Install Node.js

These servers require Node.js 18 or newer.

Open PowerShell and check whether Node is already installed:

```powershell
node --version
```

If the command prints a version like `v18.x`, `v20.x`, or `v22.x`, continue to the next step.

If Node is not installed, download and install the LTS version from:

```text
https://nodejs.org/
```

After installing Node, close PowerShell, open it again, and run:

```powershell
node --version
where.exe node
```

Keep the path printed by `where.exe node`. You will use it as the `command` value in `config.toml`.

Most Windows installs use:

```text
C:\Program Files\nodejs\node.exe
```

In `config.toml`, write Windows paths with forward slashes:

```text
C:/Program Files/nodejs/node.exe
```

### 2. Download This Repository

Put this repository somewhere on your computer.

If you use Git, run this in PowerShell:

```powershell
git clone https://github.com/NDAR/mcp-servers.git
```

If you do not use Git, download the repository ZIP from GitHub and unzip it.

In the examples below, replace:

```text
C:/path/to/mcp-servers
```

with the folder where you put this repository.

For example, if this file is at:

```text
C:\Users\alex\Documents\mcp-servers\README.md
```

then your folder path in `config.toml` should be:

```text
C:/Users/alex/Documents/mcp-servers
```

### 3. Open Codex Config

Codex Desktop reads MCP server settings from:

```text
%USERPROFILE%\.codex\config.toml
```

Open it from PowerShell:

```powershell
notepad $env:USERPROFILE\.codex\config.toml
```

If the file does not exist yet, create it:

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.codex
New-Item -ItemType File -Force $env:USERPROFILE\.codex\config.toml
notepad $env:USERPROFILE\.codex\config.toml
```

### 4. Add The MCP Server Entries

Add these sections to `%USERPROFILE%\.codex\config.toml`.

Use the path from `where.exe node` for `command`. Replace backslashes with forward slashes.

Replace `C:/path/to/mcp-servers` with your repository folder path.

Replace only the two PAT placeholder values with your real tokens.

```toml
[mcp_servers.confluence]
enabled = true
command = "C:/Program Files/nodejs/node.exe"
args = ["--use-system-ca", "C:/path/to/mcp-servers/confluence-mcp-server/src/server.mjs"]

[mcp_servers.confluence.env]
CONFLUENCE_AUTH_MODE = "bearer"
CONFLUENCE_BASE_URL = "https://wiki.nimhda.org"
CONFLUENCE_API_PATH = "/rest/api"
CONFLUENCE_PAT = "PASTE_YOUR_CONFLUENCE_PAT_HERE"

[mcp_servers.jira]
enabled = true
command = "C:/Program Files/nodejs/node.exe"
args = ["--use-system-ca", "C:/path/to/mcp-servers/jira-mcp-server/src/server.mjs"]

[mcp_servers.jira.env]
JIRA_AUTH_MODE = "bearer"
JIRA_BASE_URL = "https://jira.nimhda.org"
JIRA_API_PATH = "/rest/api/2"
JIRA_PAT = "PASTE_YOUR_JIRA_PAT_HERE"
```

If `where.exe node` printed a different path, update both `command` lines. For example:

```toml
command = "C:/Users/alex/AppData/Local/Programs/nodejs/node.exe"
```

### 5. Restart Codex

Quit and reopen Codex Desktop after saving `config.toml`.

### 6. Confirm Codex Can See The Servers

In PowerShell, run:

```powershell
codex mcp list
```

You should see both of these entries:

```text
confluence
jira
```

Both should show `enabled`.

### 7. Try The Tools In Codex

After restarting Codex, ask it to use the Confluence or Jira MCP server. For example:

```text
Search Confluence for NDA data dictionary
```

```text
Search Jira for unresolved issues mentioning validation
```

## Troubleshooting

If Codex does not show the servers, check these items:

- `~/.codex/config.toml` on macOS/Linux or `%USERPROFILE%\.codex\config.toml` on Windows was saved after editing.
- Codex Desktop was restarted after editing the file.
- `command` points to the real Node path from `which node` on macOS/Linux or `where.exe node` on Windows.
- `/path/to/mcp-servers` or `C:/path/to/mcp-servers` was replaced with the real repository folder path.
- Both PAT values were replaced with real tokens.
- The server files exist at:
  - `/path/to/mcp-servers/confluence-mcp-server/src/server.mjs`
  - `/path/to/mcp-servers/jira-mcp-server/src/server.mjs`
  - `C:/path/to/mcp-servers/confluence-mcp-server/src/server.mjs`
  - `C:/path/to/mcp-servers/jira-mcp-server/src/server.mjs`

You can test each server file directly:

```bash
cd /path/to/mcp-servers/confluence-mcp-server
npm run check
```

```bash
cd /path/to/mcp-servers/jira-mcp-server
npm run check
```

On Windows, use PowerShell:

```powershell
cd C:/path/to/mcp-servers/confluence-mcp-server
npm run check
```

```powershell
cd C:/path/to/mcp-servers/jira-mcp-server
npm run check
```

The commands should finish without errors.

## More Details

See each server's README for tool details and non-Codex MCP client examples:

- [Confluence MCP Server](./confluence-mcp-server/README.md)
- [Jira MCP Server](./jira-mcp-server/README.md)
