# Atlassian Jira and Confluence (Data Center) MCP Servers

Standalone MCP servers for Data Center Atlassian services.

## Servers

- `confluence-mcp-server`: Confluence search, page fetch, page create/update, and comment tools
- `jira-mcp-server`: Jira issue/project lookup, issue create/update, transition, assignment, and comment tools

Each server is dependency-free and uses Node's built-in `fetch`.

Both servers include write-capable tools. Write tools default to dry-run mode and require a second call with a matching `confirmationToken` before they create or update anything.

## Simple Codex Desktop Setup

These steps add both MCP servers and the Atlassian Codex skill to Codex Desktop.

You need:

- Codex Desktop
- Node.js 18 or newer, unless you use the Windows no-admin installer below
- Your Confluence base URL, such as `https://wiki.example.org`
- Your Jira base URL, such as `https://jira.example.org`
- One Confluence personal access token
- One Jira personal access token

Keep your tokens private. Do not paste them into GitHub, Slack, email, tickets, or screenshots.

### Windows Without Admin Rights

If Windows does not allow you to install Node.js, use the PowerShell installer instead. It downloads a portable Node.js ZIP into your user profile and does not require admin rights.

Open PowerShell in this repository folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-atlassian-mcp-windows.ps1
```

If you only have the `.ps1` file, you can still run it. The installer will download the MCP server files from GitHub.

The installer will:

- install portable Node.js under `%LOCALAPPDATA%\NDAR\AtlassianMcp`
- copy the MCP server files under `%LOCALAPPDATA%\NDAR\AtlassianMcp`
- prompt for the Confluence URL, Jira URL, Confluence PAT, and Jira PAT
- update `%USERPROFILE%\.codex\config.toml`
- create a backup of the previous config
- install the `nda-atlassian` Codex skill

Use these NDA URLs when prompted:

```text
https://wiki.nimhda.org
https://jira.nimhda.org
```

After the installer finishes, quit and reopen Codex Desktop.

### macOS, Linux, Or Windows With Node.js

### 1. Install Node.js

Check whether Node.js is already installed:

```bash
node --version
```

If it prints `v18.x`, `v20.x`, `v22.x`, or newer, continue.

If Node.js is not installed:

- macOS: install Node.js from `https://nodejs.org/`, or run `brew install node` if you use Homebrew.
- Windows: install the LTS version from `https://nodejs.org/`.

After installing Node.js, close and reopen Terminal or PowerShell, then run `node --version` again.

### 2. Download This Repository

Put this repository somewhere on your computer. For example:

```bash
git clone https://github.com/NDAR/atlassian-mcp-servers.git
```

If you do not use Git, download the repository ZIP from GitHub and unzip it.

### 3. Run The Installer

Open Terminal or PowerShell in the repository folder and run:

```bash
node install-codex-atlassian-mcp.mjs
```

The installer will ask for your Confluence URL, Jira URL, Confluence token, and Jira token. It will then:

- update `~/.codex/config.toml`
- create a backup of your previous config
- install the `nda-atlassian` Codex skill

### 4. Restart Codex

Quit and reopen Codex Desktop.

Optional: confirm the servers are visible:

```bash
codex mcp list
```

You should see both of these entries:

```text
confluence
jira
```

Both should show `enabled`.

### 5. Try It

Ask Codex:

```text
Search Confluence for the data dictionary
```

```text
Search Jira for unresolved issues mentioning validation
```

```text
What changed recently on the wiki?
```

## Troubleshooting

If Codex does not show the servers, check these items:

- Codex Desktop was restarted after running the installer.
- `node --version` prints `v18.x` or newer.
- `~/.codex/config.toml` contains `mcp_servers.confluence` and `mcp_servers.jira`.
- The Confluence and Jira URLs were entered correctly.
- Both PAT values were entered correctly.
- The server files exist at:
  - `confluence-mcp-server/src/server.mjs`
  - `jira-mcp-server/src/server.mjs`

You can test each server file directly:

```bash
cd confluence-mcp-server
npm run check
cd ..
```

```bash
cd jira-mcp-server
npm run check
cd ..
```

The commands should finish without errors.

## More Details

See each server's README for tool details and non-Codex MCP client examples:

- [Confluence MCP Server](./confluence-mcp-server/README.md)
- [Jira MCP Server](./jira-mcp-server/README.md)
