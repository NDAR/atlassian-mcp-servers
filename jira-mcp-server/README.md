# Jira MCP Server

A standalone MCP server that exposes Jira issue/project lookup and write tools over stdio.

## What it provides

- `jira_search`: search Jira issues by free text or raw JQL
- `jira_get_issue`: fetch a Jira issue by key or ID
- `jira_list_projects`: list Jira projects visible to the configured account
- `jira_myself`: return the current Jira user, useful for credential checks
- `jira_create_issue`: dry-run or create a Jira issue
- `jira_update_issue`: dry-run or update Jira issue fields and update operations
- `jira_transition_issue`: dry-run or transition a Jira issue
- `jira_list_transitions`: list available workflow transitions for a Jira issue
- `jira_assign_issue`: dry-run or assign, reassign, or unassign a Jira issue
- `jira_add_comment`: dry-run or add a Jira issue comment

This implementation uses Node's built-in `fetch` and does not require external packages.

## Requirements

- Node 18+ (`v22` is available in this workspace)
- A Jira account, personal access token, or basic-auth credentials with read access
- Write-capable tools require Jira permissions to create issues, edit issues, transition issues, assign issues, or add comments

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

The write tools do not use a separate enable flag. If the configured account can write in Jira, the tools can write after their dry-run confirmation step.

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
cd /Users/kimny/src/mcp/jira-mcp-server
npm run start
```

## Write Safety Flow

All write tools default to dry-run mode. A dry-run call returns a preview and a short-lived `confirmationToken`. To execute the write, call the same tool again with the same arguments, `dryRun: false`, and the returned `confirmationToken`.

The confirmation token is valid for 10 minutes and is tied to the exact operation, target, payload, and audit comment. If any write argument changes, the token is rejected.

## Codex Attribution

Codex attribution is enabled by default for write tools:

- `jira_create_issue` adds the `codex-assisted` label and appends `Created with Codex via Jira MCP on <date> at the user's request.` to the description.
- `jira_update_issue`, `jira_transition_issue`, and `jira_assign_issue` add a Jira audit comment describing the action.
- `jira_add_comment` appends `Posted with Codex via Jira MCP.` to the comment body.

Set `codexAttribution: false` on any write tool to suppress labels, footers, and audit comments when exact text or fields are required.

### Create issue

Dry-run:

```json
{
  "projectKey": "ENG",
  "issueType": "Task",
  "summary": "New issue",
  "description": "Created from MCP.",
  "labels": ["mcp"]
}
```

Execute:

```json
{
  "projectKey": "ENG",
  "issueType": "Task",
  "summary": "New issue",
  "description": "Created from MCP.",
  "labels": ["mcp"],
  "dryRun": false,
  "confirmationToken": "paste-token-from-dry-run"
}
```

### Update issue

```json
{
  "issueKey": "ENG-123",
  "summary": "Updated summary",
  "fields": {
    "customfield_10010": "raw value"
  },
  "update": {
    "fixVersions": [
      {
        "add": {
          "name": "2026 Jun"
        }
      }
    ]
  }
}
```

### Transition issue

List available transitions first:

```json
{
  "issueKey": "ENG-123"
}
```

Then execute the selected transition ID:

```json
{
  "issueKey": "ENG-123",
  "transitionId": "31",
  "comment": "Ready for review."
}
```

### Assign issue

```json
{
  "issueKey": "ENG-123",
  "name": "kimny"
}
```

To unassign:

```json
{
  "issueKey": "ENG-123",
  "unassign": true
}
```

### Add comment

```json
{
  "issueKey": "ENG-123",
  "body": "Looks good."
}
```

## Example MCP client config

Use whatever MCP client you have. The server expects environment variables to be injected by the client.

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": [
        "/Users/kimny/src/mcp/jira-mcp-server/src/server.mjs"
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
- Write bodies use Jira REST API v2 payload shapes. Use raw `fields` and `update` for custom fields or advanced mutations.
- The server returns tool errors as MCP tool failures (`isError: true`) rather than crashing the process.
