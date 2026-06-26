# Confluence MCP Server

A standalone MCP server that exposes Confluence tools over stdio.

## What it provides

- `confluence_search`: search Confluence pages with free text or raw CQL
- `confluence_get_page`: fetch a page by ID, including its storage-format body
- `confluence_create_page`: dry-run or create a page using storage-format XHTML
- `confluence_update_page`: dry-run or update a page using storage-format XHTML
- `confluence_add_comment`: dry-run or add a page comment using storage-format XHTML

This implementation uses Node's built-in `fetch` and does not require external packages.

## Requirements

- Node 18+ (`v22` is available in this workspace)
- A Confluence service account or API token with read access
- Write-capable tools require Confluence permissions to create pages, edit pages, or add comments

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

The write tools do not use a separate enable flag. If the configured account can write in Confluence, the tools can write after their dry-run confirmation step.

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
cd /path/to/mcp-servers/confluence-mcp-server
npm run start
```

## Write Safety Flow

All write tools default to dry-run mode. A dry-run call returns a preview and a short-lived `confirmationToken`. To execute the write, call the same tool again with the same arguments, `dryRun: false`, and the returned `confirmationToken`.

The confirmation token is valid for 10 minutes and is tied to the exact operation, target, title/body, parent page, page version, and version message. If any write argument changes, the token is rejected.

### Create page

Dry-run:

```json
{
  "spaceKey": "ENG",
  "title": "New page",
  "bodyStorage": "<p>Hello from MCP.</p>"
}
```

Execute:

```json
{
  "spaceKey": "ENG",
  "title": "New page",
  "bodyStorage": "<p>Hello from MCP.</p>",
  "dryRun": false,
  "confirmationToken": "paste-token-from-dry-run"
}
```

### Update page

Fetch the current page first with `confluence_get_page` and use the returned `version` as `currentVersion`. The update fails if the live page version has changed before execution.

Dry-run:

```json
{
  "pageId": "123456",
  "currentVersion": 7,
  "bodyStorage": "<p>Updated body.</p>",
  "versionMessage": "Updated through MCP"
}
```

Execute:

```json
{
  "pageId": "123456",
  "currentVersion": 7,
  "bodyStorage": "<p>Updated body.</p>",
  "versionMessage": "Updated through MCP",
  "dryRun": false,
  "confirmationToken": "paste-token-from-dry-run"
}
```

### Add comment

Dry-run:

```json
{
  "pageId": "123456",
  "bodyStorage": "<p>Looks good.</p>"
}
```

Execute:

```json
{
  "pageId": "123456",
  "bodyStorage": "<p>Looks good.</p>",
  "dryRun": false,
  "confirmationToken": "paste-token-from-dry-run"
}
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
- Write bodies must be Confluence storage-format XHTML. The server does not convert Markdown or plain text.
- The server returns tool errors as MCP tool failures (`isError: true`) rather than crashing the process.
