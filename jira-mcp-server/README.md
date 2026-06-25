# Jira MCP Server

A standalone read-only MCP server that exposes Jira issue and project lookup tools over stdio.

## What it provides

- `jira_search`: search Jira issues by free text or raw JQL
- `jira_get_issue`: fetch a Jira issue by key or ID
- `jira_list_projects`: list Jira projects visible to the configured account
- `jira_myself`: return the current Jira user, useful for credential checks

This implementation uses Node's built-in `fetch` and does not require external packages.

## Requirements

- Node 18+ (`v22` is available in this workspace)
- A Jira account, personal access token, or basic-auth credentials with read access

## Configuration

Copy `.env.example` into your client-side environment configuration and set:

- `JIRA_BASE_URL`: root Jira URL, set to `https://jira.nimhda.org`
- `JIRA_API_PATH`: API root. For Jira Data Center this is commonly `"/rest/api/2"`.
- `JIRA_AUTH_MODE`: `bearer` or `basic`
- `JIRA_PAT`: recommended for Data Center when personal access tokens are enabled
- `JIRA_USERNAME`: basic-auth username
- `JIRA_PASSWORD`: basic-auth password
- `JIRA_PROJECT_KEY`: optional default project filter for generated searches
- `JIRA_JQL_FILTER`: optional JQL appended to generated searches

## Data Center Recommendation

For Jira Data Center, start with:

```bash
JIRA_BASE_URL=https://jira.nimhda.org
JIRA_API_PATH=/rest/api/2
JIRA_AUTH_MODE=bearer
JIRA_PAT=...
```

If your instance does not use PATs, fall back to:

```bash
JIRA_AUTH_MODE=basic
JIRA_USERNAME=...
JIRA_PASSWORD=...
```

## Run

```bash
cd jira-mcp-server
npm run start
```

## Example MCP client config

Use whatever MCP client you have. The server expects environment variables to be injected by the client.

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": [
        "/path/to/mcp-servers/jira-mcp-server/src/server.mjs"
      ],
      "env": {
        "JIRA_BASE_URL": "https://jira.nimhda.org",
        "JIRA_API_PATH": "/rest/api/2",
        "JIRA_AUTH_MODE": "bearer",
        "JIRA_PAT": "replace-me"
      }
    }
  }
}
```

## Notes

- `jira_search` generates JQL from `query` unless you pass raw `jql`.
- If your Jira instance is hosted under a path prefix, set `JIRA_API_PATH` to the correct REST root, for example `/jira/rest/api/2`.
- The server returns tool errors as MCP tool failures (`isError: true`) rather than crashing the process.
