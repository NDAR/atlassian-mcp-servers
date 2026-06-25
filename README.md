# NDAR MCP Servers

Standalone MCP servers for NDAR Atlassian services.

## Servers

- `confluence-mcp-server`: read-only Confluence search and page fetch tools
- `jira-mcp-server`: read-only Jira issue, project, and current-user lookup tools

Each server is dependency-free and uses Node's built-in `fetch`.

## Setup

Configure credentials through your MCP client environment. Do not commit `.env` files.

See each server's README for tool details and example client configuration:

- [Confluence MCP Server](./confluence-mcp-server/README.md)
- [Jira MCP Server](./jira-mcp-server/README.md)
