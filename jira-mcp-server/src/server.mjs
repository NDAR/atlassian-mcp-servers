import { Buffer } from "node:buffer";

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

const TOOL_DEFINITIONS = [
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
  }
];

let inputBuffer = Buffer.alloc(0);
let outputMode = "line";

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processIncomingMessages().catch((error) => {
    logError("failed to process incoming message", error);
  });
});

process.stdin.on("end", () => {
  process.exit(0);
});

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

async function handleToolCall(params) {
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
    const detail =
      parsedBody?.errorMessages?.join("; ") ??
      parsedBody?.message ??
      parsedBody?.error ??
      rawText.slice(0, 1000);
    throw new Error(
      `Jira request failed (${response.status} ${response.statusText}): ${detail}`
    );
  }

  return parsedBody ?? {};
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
