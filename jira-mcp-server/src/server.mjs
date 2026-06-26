import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const SERVER_INFO = {
  name: "jira-mcp-server",
  version: "0.1.0"
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
  "2024-09-03"
];

const CONFIRMATION_TOKEN_TTL_SECONDS = 600;
const CODEX_ATTRIBUTION_LABEL = "codex-assisted";

const DEFAULT_SEARCH_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "issuetype",
  "project",
  "created",
  "updated",
  "resolution"
];

const DEFAULT_ISSUE_FIELDS = [
  ...DEFAULT_SEARCH_FIELDS,
  "description",
  "labels",
  "components",
  "fixVersions",
  "versions"
];

export const TOOL_DEFINITIONS = [
  {
    name: "jira_search",
    description: "Search Jira issues by free-text query or raw JQL.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text query to convert into Jira JQL."
        },
        jql: {
          type: "string",
          description: "Raw Jira JQL. If set, it takes precedence over query."
        },
        projectKey: {
          type: "string",
          description: "Optional Jira project key to scope generated searches."
        },
        startAt: {
          type: "integer",
          minimum: 0,
          description: "Zero-based result offset. Default is 0."
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of issues to return. Default is 10."
        },
        fields: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Issue fields to request. Defaults to common summary fields."
        },
        expand: {
          type: "string",
          description: "Optional comma-separated Jira expand fields."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "jira_get_issue",
    description: "Fetch a Jira issue by key or ID.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira issue key or ID, for example PROJ-123."
        },
        fields: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Issue fields to request. Defaults to common detail fields."
        },
        expand: {
          type: "string",
          description: "Optional comma-separated Jira expand fields."
        }
      },
      required: ["issueKey"],
      additionalProperties: false
    }
  },
  {
    name: "jira_list_projects",
    description: "List Jira projects visible to the configured account.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of projects to return. Default is 50."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "jira_myself",
    description: "Return the current Jira user for credential verification.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "jira_create_issue",
    description: "Dry-run or create a Jira issue from common fields plus raw fields.",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: {
          type: "string",
          description: "Jira project key where the issue will be created."
        },
        issueType: {
          type: "string",
          description: "Issue type name, for example Task, Story, Bug, or Epic."
        },
        summary: {
          type: "string",
          description: "Issue summary."
        },
        description: {
          type: "string",
          description: "Optional issue description."
        },
        priority: {
          type: "string",
          description: "Optional priority name."
        },
        assignee: {
          type: "object",
          description: "Optional assignee object with name or accountId.",
          additionalProperties: true
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional labels. codex-assisted is added by default."
        },
        components: {
          type: "array",
          items: { type: "string" },
          description: "Optional component names."
        },
        fixVersions: {
          type: "array",
          items: { type: "string" },
          description: "Optional fix version names."
        },
        fields: {
          type: "object",
          description: "Optional raw Jira fields that extend or override mapped fields.",
          additionalProperties: true
        },
        codexAttribution: {
          type: "boolean",
          description: "Default true. Set false to suppress Codex labels, footers, and audit comments."
        },
        dryRun: {
          type: "boolean",
          description: "Default true. Set false to execute with a valid confirmationToken."
        },
        confirmationToken: {
          type: "string",
          description: "Token returned by a matching dry-run preview."
        }
      },
      required: ["projectKey", "issueType", "summary"],
      additionalProperties: false
    }
  },
  {
    name: "jira_update_issue",
    description: "Dry-run or update Jira issue fields and Jira-native update operations.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira issue key or ID, for example PROJ-123."
        },
        summary: { type: "string", description: "Optional replacement summary." },
        description: { type: "string", description: "Optional replacement description." },
        priority: { type: "string", description: "Optional priority name." },
        assignee: {
          type: "object",
          description: "Optional assignee field object with name or accountId.",
          additionalProperties: true
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional replacement labels."
        },
        components: {
          type: "array",
          items: { type: "string" },
          description: "Optional replacement component names."
        },
        fixVersions: {
          type: "array",
          items: { type: "string" },
          description: "Optional replacement fix version names."
        },
        fields: {
          type: "object",
          description: "Optional raw Jira fields that extend or override mapped fields.",
          additionalProperties: true
        },
        update: {
          type: "object",
          description: "Optional Jira-native update object.",
          additionalProperties: true
        },
        codexAttribution: {
          type: "boolean",
          description: "Default true. Set false to suppress Codex audit comments."
        },
        dryRun: {
          type: "boolean",
          description: "Default true. Set false to execute with a valid confirmationToken."
        },
        confirmationToken: {
          type: "string",
          description: "Token returned by a matching dry-run preview."
        }
      },
      required: ["issueKey"],
      additionalProperties: false
    }
  },
  {
    name: "jira_transition_issue",
    description: "Dry-run or transition a Jira issue, optionally with fields/update/comment.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira issue key or ID, for example PROJ-123."
        },
        transitionId: {
          type: "string",
          description: "Jira workflow transition ID."
        },
        fields: {
          type: "object",
          description: "Optional raw Jira fields for the transition.",
          additionalProperties: true
        },
        update: {
          type: "object",
          description: "Optional Jira-native update object for the transition.",
          additionalProperties: true
        },
        comment: {
          type: "string",
          description: "Optional transition comment."
        },
        codexAttribution: {
          type: "boolean",
          description: "Default true. Set false to suppress Codex audit comments."
        },
        dryRun: {
          type: "boolean",
          description: "Default true. Set false to execute with a valid confirmationToken."
        },
        confirmationToken: {
          type: "string",
          description: "Token returned by a matching dry-run preview."
        }
      },
      required: ["issueKey", "transitionId"],
      additionalProperties: false
    }
  },
  {
    name: "jira_assign_issue",
    description: "Dry-run or assign, reassign, or unassign a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira issue key or ID, for example PROJ-123."
        },
        name: {
          type: "string",
          description: "Jira username for Data Center assignment."
        },
        accountId: {
          type: "string",
          description: "Jira accountId for Cloud-compatible assignment."
        },
        unassign: {
          type: "boolean",
          description: "Set true to unassign the issue."
        },
        codexAttribution: {
          type: "boolean",
          description: "Default true. Set false to suppress Codex audit comments."
        },
        dryRun: {
          type: "boolean",
          description: "Default true. Set false to execute with a valid confirmationToken."
        },
        confirmationToken: {
          type: "string",
          description: "Token returned by a matching dry-run preview."
        }
      },
      required: ["issueKey"],
      additionalProperties: false
    }
  },
  {
    name: "jira_add_comment",
    description: "Dry-run or add a comment to a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira issue key or ID, for example PROJ-123."
        },
        body: {
          type: "string",
          description: "Comment body. A Codex attribution footer is appended by default."
        },
        codexAttribution: {
          type: "boolean",
          description: "Default true. Set false to suppress the Codex attribution footer."
        },
        dryRun: {
          type: "boolean",
          description: "Default true. Set false to execute with a valid confirmationToken."
        },
        confirmationToken: {
          type: "string",
          description: "Token returned by a matching dry-run preview."
        }
      },
      required: ["issueKey", "body"],
      additionalProperties: false
    }
  },
  {
    name: "jira_list_transitions",
    description: "List available workflow transitions for a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: {
          type: "string",
          description: "Jira issue key or ID, for example PROJ-123."
        }
      },
      required: ["issueKey"],
      additionalProperties: false
    }
  }
];

let inputBuffer = Buffer.alloc(0);
let outputMode = "line";

export function startStdioServer() {
  process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    processIncomingMessages().catch((error) => {
      logError("failed to process incoming message", error);
    });
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });
}

async function processIncomingMessages() {
  while (true) {
    if (!looksLikeHeaderFrame(inputBuffer)) {
      const lineEnd = inputBuffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }

      const bodyText = inputBuffer
        .subarray(0, lineEnd)
        .toString("utf8")
        .replace(/\r$/, "")
        .trim();
      inputBuffer = inputBuffer.subarray(lineEnd + 1);

      if (!bodyText) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(bodyText);
      } catch (error) {
        logError("received invalid newline-delimited JSON", error, bodyText);
        continue;
      }

      outputMode = "line";
      await handleMessage(message);
      continue;
    }

    const crlfHeaderEnd = inputBuffer.indexOf("\r\n\r\n");
    const lfHeaderEnd = inputBuffer.indexOf("\n\n");
    const useLfHeaders =
      crlfHeaderEnd === -1 && lfHeaderEnd !== -1
        ? true
        : lfHeaderEnd !== -1 && lfHeaderEnd < crlfHeaderEnd;
    const headerEnd = useLfHeaders ? lfHeaderEnd : crlfHeaderEnd;
    if (headerEnd === -1) {
      return;
    }

    const headerText = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const headers = parseHeaders(headerText);
    const contentLength = Number(headers["content-length"]);

    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error("invalid or missing Content-Length header");
    }

    const messageStart = headerEnd + (useLfHeaders ? 2 : 4);
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) {
      return;
    }

    const bodyText = inputBuffer.subarray(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(messageEnd);

    let message;
    try {
      message = JSON.parse(bodyText);
    } catch (error) {
      logError("received invalid JSON", error, bodyText);
      continue;
    }

    outputMode = useLfHeaders ? "headers-lf" : "headers";
    await handleMessage(message);
  }
}

function looksLikeHeaderFrame(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8");
  return prefix.toLowerCase().startsWith("content-length:");
}

function parseHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }
  return headers;
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.id === undefined) {
    return;
  }

  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = handleInitialize(message.params ?? {});
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOL_DEFINITIONS };
        break;
      case "tools/call":
        result = await handleToolCall(message.params ?? {});
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      default:
        sendError(message.id, -32601, `Method not found: ${message.method}`);
        return;
    }

    sendResult(message.id, result);
  } catch (error) {
    logError("request handling failed", error);
    sendError(
      message.id,
      -32603,
      error instanceof Error ? error.message : "Internal server error"
    );
  }
}

function handleInitialize(params) {
  const requested = params.protocolVersion;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];

  return {
    protocolVersion,
    capabilities: {
      tools: {
        listChanged: false
      },
      resources: {
        subscribe: false,
        listChanged: false
      },
      prompts: {
        listChanged: false
      }
    },
    serverInfo: SERVER_INFO
  };
}

export async function handleToolCall(params) {
  const toolName = params.name;
  const args = params.arguments ?? {};

  switch (toolName) {
    case "jira_search":
      return await runToolSafely(() => jiraSearch(args));
    case "jira_get_issue":
      return await runToolSafely(() => jiraGetIssue(args));
    case "jira_list_projects":
      return await runToolSafely(() => jiraListProjects(args));
    case "jira_myself":
      return await runToolSafely(() => jiraMyself());
    case "jira_create_issue":
      return await runToolSafely(() => jiraCreateIssue(args));
    case "jira_update_issue":
      return await runToolSafely(() => jiraUpdateIssue(args));
    case "jira_transition_issue":
      return await runToolSafely(() => jiraTransitionIssue(args));
    case "jira_assign_issue":
      return await runToolSafely(() => jiraAssignIssue(args));
    case "jira_add_comment":
      return await runToolSafely(() => jiraAddComment(args));
    case "jira_list_transitions":
      return await runToolSafely(() => jiraListTransitions(args));
    default:
      return toolError(`Unknown tool: ${toolName}`);
  }
}

async function runToolSafely(fn) {
  try {
    return await fn();
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Tool execution failed");
  }
}

async function jiraSearch(args) {
  const config = readConfig();
  const startAt = clampInteger(args.startAt, 0, 0, 100000);
  const maxResults = clampInteger(args.maxResults, 10, 1, 50);
  const projectKey = stringOrUndefined(args.projectKey) ?? config.defaultProjectKey;
  const jql = buildSearchJql({
    query: stringOrUndefined(args.query),
    rawJql: stringOrUndefined(args.jql),
    projectKey,
    defaultFilter: config.defaultJqlFilter
  });
  const fields = normalizeFieldList(args.fields, DEFAULT_SEARCH_FIELDS);

  const body = {
    jql,
    startAt,
    maxResults,
    fields
  };
  const expand = stringOrUndefined(args.expand);
  if (expand) {
    body.expand = expand;
  }

  const data = await jiraRequest(config, "/search", {
    method: "POST",
    body
  });
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const normalized = issues.map((issue) => normalizeIssue(config.baseUrl, issue));

  return jsonContent({
    jql,
    startAt: data.startAt ?? startAt,
    maxResults: data.maxResults ?? maxResults,
    total: data.total ?? normalized.length,
    count: normalized.length,
    issues: normalized
  });
}

async function jiraGetIssue(args) {
  const config = readConfig();
  const issueKey = stringOrUndefined(args.issueKey);
  if (!issueKey) {
    throw new Error("issueKey is required");
  }

  const fields = normalizeFieldList(args.fields, DEFAULT_ISSUE_FIELDS);
  const queryParams = {
    fields: fields.join(",")
  };
  const expand = stringOrUndefined(args.expand);
  if (expand) {
    queryParams.expand = expand;
  }

  const data = await jiraRequest(
    config,
    `/issue/${encodeURIComponent(issueKey)}`,
    { queryParams }
  );

  return jsonContent(normalizeIssue(config.baseUrl, data, { includeDescription: true }));
}

async function jiraListProjects(args) {
  const config = readConfig();
  const limit = clampInteger(args.limit, 50, 1, 200);
  const data = await jiraRequest(config, "/project", {
    queryParams: {
      expand: "description,lead,url,projectKeys"
    }
  });
  const projects = Array.isArray(data) ? data : [];
  const normalized = projects.slice(0, limit).map((project) => ({
    id: project.id ?? null,
    key: project.key ?? null,
    name: project.name ?? null,
    projectTypeKey: project.projectTypeKey ?? null,
    lead: normalizeUser(project.lead),
    url: buildProjectUrl(config.baseUrl, project),
    apiUrl: project.self ?? null,
    description: sanitizeText(project.description ?? "")
  }));

  return jsonContent({
    count: normalized.length,
    totalAvailable: projects.length,
    projects: normalized
  });
}

async function jiraMyself() {
  const config = readConfig();
  const data = await jiraRequest(config, "/myself");

  return jsonContent({
    name: data.name ?? null,
    key: data.key ?? null,
    accountId: data.accountId ?? null,
    displayName: data.displayName ?? null,
    emailAddress: data.emailAddress ?? null,
    active: data.active ?? null,
    timeZone: data.timeZone ?? null
  });
}

async function jiraCreateIssue(args) {
  const config = readConfig();
  const projectKey = requiredString(args.projectKey, "projectKey");
  const issueType = requiredString(args.issueType, "issueType");
  const summary = requiredString(args.summary, "summary");
  const codexAttribution = args.codexAttribution !== false;
  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary,
    ...buildCommonIssueFields(args),
    ...objectOrUndefined(args.fields, "fields")
  };

  if (codexAttribution) {
    fields.labels = addUniqueLabel(fields.labels, CODEX_ATTRIBUTION_LABEL);
    fields.description = appendDescriptionFooter(
      fields.description,
      `Created with Codex via Jira MCP on ${currentDateString()} at the user's request.`
    );
  }

  const payload = { fields };
  const tokenPayload = buildTokenPayload({
    operation: "jira_create_issue",
    method: "POST",
    endpointPath: "/issue",
    target: { projectKey },
    payload
  });
  const preview = buildWritePreview(config, tokenPayload, {
    target: { projectKey },
    summary
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      const data = await jiraRequest(config, "/issue", {
        method: "POST",
        body: payload
      });
      return normalizeWriteIssueResult(config.baseUrl, data);
    }
  });
}

async function jiraUpdateIssue(args) {
  const config = readConfig();
  const issueKey = requiredString(args.issueKey, "issueKey");
  const fields = {
    ...buildCommonIssueFields(args),
    ...objectOrUndefined(args.fields, "fields")
  };
  const update = objectOrUndefined(args.update, "update");
  if (Object.keys(fields).length === 0 && !update) {
    throw new Error("At least one field or update operation is required");
  }

  const payload = {};
  if (Object.keys(fields).length > 0) {
    payload.fields = fields;
  }
  if (update) {
    payload.update = update;
  }

  const auditComment = args.codexAttribution === false
    ? null
    : `Codex via Jira MCP updated this issue on ${currentDateString()}.`;
  const endpointPath = `/issue/${encodeURIComponent(issueKey)}`;
  const tokenPayload = buildTokenPayload({
    operation: "jira_update_issue",
    method: "PUT",
    endpointPath,
    target: { issueKey },
    payload,
    auditComment
  });
  const preview = buildWritePreview(config, tokenPayload, {
    target: { issueKey }
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      await jiraRequest(config, endpointPath, {
        method: "PUT",
        body: payload
      });
      const audit = auditComment
        ? await postJiraComment(config, issueKey, auditComment)
        : null;
      return normalizeMutationResult(config.baseUrl, issueKey, { auditComment: audit });
    }
  });
}

async function jiraTransitionIssue(args) {
  const config = readConfig();
  const issueKey = requiredString(args.issueKey, "issueKey");
  const transitionId = requiredString(args.transitionId, "transitionId");
  const fields = objectOrUndefined(args.fields, "fields");
  let update = objectOrUndefined(args.update, "update");
  const comment = stringOrUndefined(args.comment);
  if (comment) {
    update = appendUpdateComment(update, comment);
  }

  const payload = {
    transition: { id: transitionId }
  };
  if (fields) {
    payload.fields = fields;
  }
  if (update) {
    payload.update = update;
  }

  const auditComment = args.codexAttribution === false
    ? null
    : `Codex via Jira MCP transitioned this issue using transition ${transitionId} on ${currentDateString()}.`;
  const endpointPath = `/issue/${encodeURIComponent(issueKey)}/transitions`;
  const tokenPayload = buildTokenPayload({
    operation: "jira_transition_issue",
    method: "POST",
    endpointPath,
    target: { issueKey },
    payload,
    auditComment
  });
  const preview = buildWritePreview(config, tokenPayload, {
    target: { issueKey },
    transitionId
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      await jiraRequest(config, endpointPath, {
        method: "POST",
        body: payload
      });
      const audit = auditComment
        ? await postJiraComment(config, issueKey, auditComment)
        : null;
      return normalizeMutationResult(config.baseUrl, issueKey, {
        transitionId,
        auditComment: audit
      });
    }
  });
}

async function jiraAssignIssue(args) {
  const config = readConfig();
  const issueKey = requiredString(args.issueKey, "issueKey");
  const unassign = args.unassign === true;
  const name = stringOrUndefined(args.name);
  const accountId = stringOrUndefined(args.accountId);

  if (!unassign && !name && !accountId) {
    throw new Error("Either name, accountId, or unassign must be provided");
  }
  if (unassign && (name || accountId)) {
    throw new Error("unassign cannot be combined with name or accountId");
  }

  const payload = unassign
    ? { name: null }
    : accountId
      ? { accountId }
      : { name };
  const auditComment = args.codexAttribution === false
    ? null
    : `Codex via Jira MCP updated this issue's assignee on ${currentDateString()}.`;
  const endpointPath = `/issue/${encodeURIComponent(issueKey)}/assignee`;
  const tokenPayload = buildTokenPayload({
    operation: "jira_assign_issue",
    method: "PUT",
    endpointPath,
    target: { issueKey },
    payload,
    auditComment
  });
  const preview = buildWritePreview(config, tokenPayload, {
    target: { issueKey }
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      await jiraRequest(config, endpointPath, {
        method: "PUT",
        body: payload
      });
      const audit = auditComment
        ? await postJiraComment(config, issueKey, auditComment)
        : null;
      return normalizeMutationResult(config.baseUrl, issueKey, { auditComment: audit });
    }
  });
}

async function jiraAddComment(args) {
  const config = readConfig();
  const issueKey = requiredString(args.issueKey, "issueKey");
  const body = requiredString(args.body, "body");
  const commentBody = args.codexAttribution === false
    ? body
    : appendCommentFooter(body, "Posted with Codex via Jira MCP.");
  const payload = { body: commentBody };
  const endpointPath = `/issue/${encodeURIComponent(issueKey)}/comment`;
  const tokenPayload = buildTokenPayload({
    operation: "jira_add_comment",
    method: "POST",
    endpointPath,
    target: { issueKey },
    payload
  });
  const preview = buildWritePreview(config, tokenPayload, {
    target: { issueKey }
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      const comment = await jiraRequest(config, endpointPath, {
        method: "POST",
        body: payload
      });
      return normalizeMutationResult(config.baseUrl, issueKey, {
        comment: normalizeComment(comment)
      });
    }
  });
}

async function jiraListTransitions(args) {
  const config = readConfig();
  const issueKey = requiredString(args.issueKey, "issueKey");
  const data = await jiraRequest(
    config,
    `/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      queryParams: { expand: "transitions.fields" }
    }
  );
  const transitions = Array.isArray(data.transitions) ? data.transitions : [];

  return jsonContent({
    issueKey,
    count: transitions.length,
    transitions: transitions.map((transition) => ({
      id: transition.id ?? null,
      name: transition.name ?? null,
      to: transition.to
        ? {
            id: transition.to.id ?? null,
            name: transition.to.name ?? null,
            statusCategory: transition.to.statusCategory?.name ?? null
          }
        : null,
      hasScreen: transition.hasScreen ?? null,
      fields: normalizeTransitionFields(transition.fields)
    }))
  });
}

function readConfig() {
  const baseUrlValue = stringOrUndefined(process.env.JIRA_BASE_URL);
  if (!baseUrlValue) {
    throw new Error("Missing JIRA_BASE_URL");
  }

  const baseUrl = new URL(baseUrlValue);
  const apiPath = normalizeApiPath(process.env.JIRA_API_PATH ?? "/rest/api/2");
  const authMode = inferAuthMode(process.env.JIRA_AUTH_MODE);
  const username = stringOrUndefined(process.env.JIRA_USERNAME);
  const password = stringOrUndefined(process.env.JIRA_PASSWORD);
  const email = stringOrUndefined(process.env.JIRA_EMAIL);
  const apiToken = stringOrUndefined(process.env.JIRA_API_TOKEN);
  const pat = stringOrUndefined(process.env.JIRA_PAT);
  const token = pat ?? apiToken;

  if (authMode === "basic") {
    const basicUser = username ?? email;
    const basicSecret = password ?? apiToken;
    if (!basicUser || !basicSecret) {
      throw new Error(
        "Basic auth requires either JIRA_USERNAME and JIRA_PASSWORD or JIRA_EMAIL and JIRA_API_TOKEN"
      );
    }
  } else if (!token) {
    throw new Error("Bearer auth requires JIRA_PAT or JIRA_API_TOKEN");
  }

  return {
    baseUrl,
    apiPath,
    authMode,
    username,
    password,
    email,
    apiToken,
    bearerToken: token,
    authSecret: authMode === "basic" ? password ?? apiToken : token,
    defaultProjectKey: stringOrUndefined(process.env.JIRA_PROJECT_KEY),
    defaultJqlFilter: stringOrUndefined(process.env.JIRA_JQL_FILTER)
  };
}

function inferAuthMode(rawMode) {
  const mode = stringOrUndefined(rawMode)?.toLowerCase();
  if (mode === "basic" || mode === "bearer") {
    return mode;
  }

  if (stringOrUndefined(process.env.JIRA_EMAIL)) {
    return "basic";
  }

  return "bearer";
}

function normalizeApiPath(value) {
  const trimmed = value.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function buildSearchJql({ query, rawJql, projectKey, defaultFilter }) {
  if (rawJql) {
    return rawJql;
  }

  if (!query) {
    throw new Error("Either query or jql must be provided");
  }

  const clauses = [`text ~ "${escapeJqlString(query)}"`];
  if (projectKey) {
    clauses.unshift(`project = "${escapeJqlString(projectKey)}"`);
  }
  if (defaultFilter) {
    clauses.push(`(${defaultFilter})`);
  }

  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

function escapeJqlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeFieldList(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const fields = value
    .map((field) => stringOrUndefined(field))
    .filter((field) => field);

  return fields.length > 0 ? fields : fallback;
}

async function previewOrExecuteWrite({ config, args, tokenPayload, preview, execute }) {
  if (args.dryRun !== false) {
    return jsonContent(preview);
  }

  const confirmationToken = requiredString(args.confirmationToken, "confirmationToken");
  verifyConfirmationToken(config, confirmationToken, tokenPayload);
  const result = await execute();

  return jsonContent({
    executed: true,
    dryRun: false,
    result
  });
}

function buildTokenPayload({ operation, method, endpointPath, target, payload, auditComment }) {
  return {
    operation,
    method,
    endpointPath,
    target,
    payload,
    auditComment: auditComment ?? null
  };
}

function buildWritePreview(config, tokenPayload, extras = {}) {
  const confirmationToken = createConfirmationToken(config, tokenPayload);
  const issuedAt = parseConfirmationToken(confirmationToken).issuedAt;

  return {
    dryRun: true,
    operation: tokenPayload.operation,
    method: tokenPayload.method,
    endpointPath: tokenPayload.endpointPath,
    target: extras.target ?? tokenPayload.target,
    summary: extras.summary ?? null,
    transitionId: extras.transitionId ?? null,
    payloadSha256: sha256Hex(stableStringify(tokenPayload.payload)),
    auditCommentSha256: tokenPayload.auditComment
      ? sha256Hex(tokenPayload.auditComment)
      : null,
    confirmationToken,
    expiresAt: new Date(
      (issuedAt + CONFIRMATION_TOKEN_TTL_SECONDS) * 1000
    ).toISOString()
  };
}

function createConfirmationToken(config, tokenPayload, issuedAt = currentEpochSeconds()) {
  const hmacInput = stableStringify({ issuedAt, tokenPayload });
  const hmacHex = createHmac("sha256", config.authSecret)
    .update(hmacInput)
    .digest("hex");

  return `v1.${issuedAt}.${hmacHex}`;
}

function verifyConfirmationToken(config, token, tokenPayload) {
  const parsed = parseConfirmationToken(token);
  const ageSeconds = currentEpochSeconds() - parsed.issuedAt;
  if (ageSeconds < 0 || ageSeconds > CONFIRMATION_TOKEN_TTL_SECONDS) {
    throw new Error("confirmationToken is expired");
  }

  const expected = createConfirmationToken(config, tokenPayload, parsed.issuedAt);
  if (!constantTimeEqual(token, expected)) {
    throw new Error("confirmationToken does not match this write operation");
  }
}

function parseConfirmationToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("confirmationToken is invalid");
  }

  const issuedAt = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || !/^[a-f0-9]{64}$/i.test(parts[2])) {
    throw new Error("confirmationToken is invalid");
  }

  return { issuedAt };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function currentDateString() {
  return new Date(Date.now()).toISOString().slice(0, 10);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildCommonIssueFields(args) {
  const fields = {};
  const summary = stringOrUndefined(args.summary);
  const description = stringOrUndefined(args.description);
  const priority = stringOrUndefined(args.priority);
  const labels = normalizeStringArray(args.labels);
  const components = normalizeNameList(args.components);
  const fixVersions = normalizeNameList(args.fixVersions);
  const assignee = normalizeAssignee(args.assignee);

  if (summary !== undefined) {
    fields.summary = summary;
  }
  if (description !== undefined) {
    fields.description = description;
  }
  if (priority) {
    fields.priority = { name: priority };
  }
  if (assignee) {
    fields.assignee = assignee;
  }
  if (labels) {
    fields.labels = labels;
  }
  if (components) {
    fields.components = components;
  }
  if (fixVersions) {
    fields.fixVersions = fixVersions;
  }

  return fields;
}

function normalizeAssignee(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const name = stringOrUndefined(value.name);
  const accountId = stringOrUndefined(value.accountId);
  if (accountId) {
    return { accountId };
  }
  if (name) {
    return { name };
  }
  return null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value
    .map((item) => stringOrUndefined(item))
    .filter((item) => item);
  return items.length > 0 ? items : [];
}

function normalizeNameList(value) {
  const items = normalizeStringArray(value);
  return items ? items.map((name) => ({ name })) : null;
}

function objectOrUndefined(value, fieldName) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

function addUniqueLabel(labels, label) {
  const normalized = Array.isArray(labels) ? labels.slice() : [];
  if (!normalized.includes(label)) {
    normalized.push(label);
  }
  return normalized;
}

function appendDescriptionFooter(description, footer) {
  if (description === undefined || description === null || description === "") {
    return footer;
  }
  if (typeof description !== "string") {
    return description;
  }
  return `${description.trim()}\n\n${footer}`;
}

function appendCommentFooter(body, footer) {
  return `${body.trim()}\n\n${footer}`;
}

function appendUpdateComment(update, body) {
  const nextUpdate = update ? { ...update } : {};
  const comments = Array.isArray(nextUpdate.comment) ? nextUpdate.comment.slice() : [];
  comments.push({ add: { body } });
  nextUpdate.comment = comments;
  return nextUpdate;
}

async function postJiraComment(config, issueKey, body) {
  const data = await jiraRequest(
    config,
    `/issue/${encodeURIComponent(issueKey)}/comment`,
    {
      method: "POST",
      body: { body }
    }
  );
  return normalizeComment(data);
}

async function jiraRequest(config, endpointPath, options = {}) {
  const url = new URL(`${config.apiPath}${endpointPath}`, config.baseUrl);
  const queryParams = options.queryParams ?? {};
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Accept: "application/json"
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (config.authMode === "basic") {
    const basicUser = config.username ?? config.email;
    const basicSecret = config.password ?? config.apiToken;
    headers.Authorization = `Basic ${Buffer.from(
      `${basicUser}:${basicSecret}`
    ).toString("base64")}`;
  } else {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const rawText = await response.text();
  const parsedBody = tryParseJson(rawText);

  if (!response.ok) {
    const detail = extractJiraErrorDetail(parsedBody, rawText);
    throw new Error(
      `Jira request failed (${response.status} ${response.statusText}): ${detail}`
    );
  }

  return parsedBody ?? {};
}

function extractJiraErrorDetail(parsedBody, rawText) {
  const details = [];

  if (Array.isArray(parsedBody?.errorMessages)) {
    details.push(...parsedBody.errorMessages.filter((message) => message));
  }

  if (parsedBody?.errors && typeof parsedBody.errors === "object") {
    for (const [field, message] of Object.entries(parsedBody.errors)) {
      if (message) {
        details.push(`${field}: ${message}`);
      }
    }
  }

  if (typeof parsedBody?.message === "string" && parsedBody.message) {
    details.push(parsedBody.message);
  }

  if (typeof parsedBody?.error === "string" && parsedBody.error) {
    details.push(parsedBody.error);
  }

  if (details.length > 0) {
    return details.join("; ");
  }

  return rawText ? rawText.slice(0, 1000) : "No error details returned by Jira";
}

function normalizeIssue(baseUrl, issue, options = {}) {
  const fields = issue.fields ?? {};
  const normalized = {
    id: issue.id ?? null,
    key: issue.key ?? null,
    summary: fields.summary ?? null,
    issueType: fields.issuetype?.name ?? null,
    status: fields.status?.name ?? null,
    statusCategory: fields.status?.statusCategory?.name ?? null,
    priority: fields.priority?.name ?? null,
    projectKey: fields.project?.key ?? null,
    projectName: fields.project?.name ?? null,
    assignee: normalizeUser(fields.assignee),
    reporter: normalizeUser(fields.reporter),
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    resolution: fields.resolution?.name ?? null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    components: normalizeNamedArray(fields.components),
    fixVersions: normalizeNamedArray(fields.fixVersions),
    versions: normalizeNamedArray(fields.versions),
    url: issue.key ? buildIssueUrl(baseUrl, issue.key) : null
  };

  if (options.includeDescription) {
    normalized.description = normalizeDescription(fields.description);
  }

  return normalized;
}

function normalizeWriteIssueResult(baseUrl, issue) {
  if (issue?.fields) {
    return normalizeIssue(baseUrl, issue, { includeDescription: true });
  }

  return {
    id: issue?.id ?? null,
    key: issue?.key ?? null,
    url: issue?.key ? buildIssueUrl(baseUrl, issue.key) : null,
    apiUrl: issue?.self ?? null
  };
}

function normalizeMutationResult(baseUrl, issueKey, extras = {}) {
  return {
    issueKey,
    url: buildIssueUrl(baseUrl, issueKey),
    transitionId: extras.transitionId ?? null,
    comment: extras.comment ?? null,
    auditComment: extras.auditComment ?? null
  };
}

function normalizeComment(comment) {
  if (!comment || typeof comment !== "object") {
    return null;
  }

  return {
    id: comment.id ?? null,
    author: normalizeUser(comment.author),
    created: comment.created ?? null,
    updated: comment.updated ?? null,
    body: typeof comment.body === "string" ? comment.body : null,
    apiUrl: comment.self ?? null
  };
}

function normalizeTransitionFields(fields) {
  if (!fields || typeof fields !== "object") {
    return {};
  }

  const normalized = {};
  for (const [key, field] of Object.entries(fields)) {
    normalized[key] = {
      required: field?.required ?? null,
      name: field?.name ?? null,
      schema: field?.schema ?? null,
      allowedValues: Array.isArray(field?.allowedValues)
        ? field.allowedValues.map((value) => ({
            id: value.id ?? null,
            name: value.name ?? value.value ?? null
          }))
        : []
    };
  }
  return normalized;
}

function normalizeUser(user) {
  if (!user || typeof user !== "object") {
    return null;
  }

  return {
    name: user.name ?? null,
    key: user.key ?? null,
    accountId: user.accountId ?? null,
    displayName: user.displayName ?? null,
    emailAddress: user.emailAddress ?? null,
    active: user.active ?? null
  };
}

function normalizeNamedArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => ({
    id: item.id ?? null,
    name: item.name ?? null
  }));
}

function normalizeDescription(value) {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (value && typeof value === "object") {
    return value;
  }

  return null;
}

function tryParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeText(value) {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function buildIssueUrl(baseUrl, issueKey) {
  return new URL(`/browse/${encodeURIComponent(issueKey)}`, baseUrl).toString();
}

function buildProjectUrl(baseUrl, project) {
  if (project.key) {
    return new URL(
      `/projects/${encodeURIComponent(project.key)}/summary`,
      baseUrl
    ).toString();
  }

  return null;
}

function clampInteger(value, defaultValue, min, max) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, numeric));
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value, fieldName) {
  const normalized = stringOrUndefined(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function toolError(message) {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    isError: true
  };
}

function sendResult(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function sendError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  if (outputMode === "line") {
    process.stdout.write(`${body}\n`);
    return;
  }

  if (outputMode === "headers-lf") {
    const headers =
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\n` +
      "Content-Type: application/json\n\n";
    process.stdout.write(headers);
    process.stdout.write(body);
    return;
  }

  const headers =
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
    "Content-Type: application/json\r\n\r\n";
  process.stdout.write(headers);
  process.stdout.write(body);
}

function logError(message, error, context) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[jira-mcp] ${message}: ${detail}\n`);
  if (context) {
    process.stderr.write(`[jira-mcp] context: ${context}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startStdioServer();
}
