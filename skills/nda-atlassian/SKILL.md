---
name: nda-atlassian
description: Use for NDA/NIMHDA Atlassian work involving Confluence wiki pages or Jira issues, including searching wiki.nimhda.org, summarizing recent page updates, comparing Confluence page versions, finding project docs, reading Jira tickets, and producing cited summaries from NDA internal Atlassian sources.
---

# NDA Atlassian

## Overview

Use the configured Confluence and Jira MCP servers for NDA internal Atlassian tasks. Prefer these MCP tools over web search for wiki.nimhda.org and jira.nimhda.org content.

## Tool Discovery

If Confluence or Jira tools are not already available, call `tool_search` first.

Useful search terms:

- `confluence search get page update comment`
- `jira issue search project`

## Confluence

Use `mcp__confluence.confluence_search` to find pages.

Useful CQL patterns:

```text
type = page ORDER BY lastmodified DESC
type = page AND space = "NOR" ORDER BY lastmodified DESC
type = page AND title ~ "Contract 2 - SOW Deliverables"
type = page AND text ~ "\"search phrase\""
```

Use `mcp__confluence.confluence_get_page` to fetch page content. Default expand:

```text
body.storage,space,version,ancestors
```

When summarizing pages:

- Include page title, URL, space key, version, and last updated date when useful.
- Summarize from the fetched page body, not only search snippets.
- Say clearly when a summary is based only on the current version.

## Change Summaries

When the user asks what changed on a Confluence page:

1. Fetch the current page with `confluence_get_page`.
2. Identify the current version number.
3. If historical versions are needed and the MCP tool cannot fetch them directly, use the configured Confluence REST API only when local credentials are already available.
4. Compare the previous version to the current version.
5. Summarize additions, removals, and status/date changes.

Never expose PATs, passwords, API tokens, or raw credential values.

## Jira

Use Jira MCP tools for:

- Reading linked Jira issues from Confluence pages.
- Looking up issue status, assignee, labels, comments, or linked tickets.
- Summarizing project status from Jira searches.

When Confluence body contains Jira macros, extract issue keys like `DB-1234`, `REV-1234`, `PB-1234`, or `QAUL-1234`, then query Jira directly if the user needs issue detail.

## Response Style

- Be concise.
- Link to Confluence and Jira pages.
- Use exact dates and version numbers.
- Distinguish "changed in this version" from "currently present on the page."
- Call out uncertainty if historical diff access is unavailable.
