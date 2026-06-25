# Confluence MCP Server

A standalone MCP server that exposes Confluence search and page-fetch tools over stdio.

## What it provides

- `confluence_search`: search Confluence pages with free text or raw CQL
- `confluence_get_page`: fetch a page by ID, including its storage-format body

This implementation uses Node's built-in `fetch` and does not require external packages.

## Requirements

- Node 18+ (`v22` is available in this workspace)
- A Confluence service account or API token with read access

## Configuration

Copy `.env.example` into your client-side environment configuration and set:

- `CONFLUENCE_BASE_URL`: root Confluence URL, for example `https://confluence.your-company.internal`
- `CONFLUENCE_API_PATH`: API root. For Data Center this is commonly `"/rest/api"`. For Cloud it is commonly `"/wiki/rest/api"`.
- `CONFLUENCE_AUTH_MODE`: `bearer` or `basic`
- `CONFLUENCE_PAT`: recommended for Data Center when personal access tokens are enabled
- `CONFLUENCE_USERNAME`: basic-auth username for Data Center
- `CONFLUENCE_PASSWORD`: basic-auth password for Data Center
- `CONFLUENCE_EMAIL`: Cloud basic-auth identifier
- `CONFLUENCE_API_TOKEN`: Cloud API token
- `CONFLUENCE_SPACE_KEY`: optional default space filter
- `CONFLUENCE_CQL_FILTER`: optional CQL appended to generated searches

## Data Center Recommendation

For Confluence Data Center, start with:

- `CONFLUENCE_API_PATH=/rest/api`
- `CONFLUENCE_AUTH_MODE=bearer`
- `CONFLUENCE_PAT=...`

If your instance does not use PATs, fall back to:

- `CONFLUENCE_AUTH_MODE=basic`
- `CONFLUENCE_USERNAME=...`
- `CONFLUENCE_PASSWORD=...`

## Run

```bash
cd confluence-mcp-server
npm run start
```

## Example MCP client config

Use whatever MCP client you have. The server expects environment variables to be injected by the client.

```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": [
        "/path/to/mcp-servers/confluence-mcp-server/src/server.mjs"
      ],
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.your-company.internal",
        "CONFLUENCE_API_PATH": "/rest/api",
        "CONFLUENCE_AUTH_MODE": "bearer",
        "CONFLUENCE_PAT": "replace-me",
        "CONFLUENCE_SPACE_KEY": "ENG"
      }
    }
  }
}
```

## Notes

- If your Data Center instance is hosted under a path prefix, set `CONFLUENCE_API_PATH` to the correct REST root, for example `/confluence/rest/api`.
- `confluence_search` generates CQL from `query` unless you pass raw `cql`.
- The server returns tool errors as MCP tool failures (`isError: true`) rather than crashing the process.
