import { Buffer } from "node:buffer";

const SERVER_INFO = {
  name: "confluence-mcp-server",
  version: "0.1.0"
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
  "2024-09-03"
];

const TOOL_DEFINITIONS = [
  {
    name: "confluence_search",
    description: "Search Confluence pages by free-text query or raw CQL.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text query to convert into Confluence CQL."
        },
        cql: {
          type: "string",
          description: "Raw Confluence CQL. If set, it takes precedence over query."
        },
        spaceKey: {
          type: "string",
          description: "Optional Confluence space key to scope the search."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of results to return. Default is 10."
        },
        includeArchived: {
          type: "boolean",
          description: "Include archived/non-current content. Default is false."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "confluence_get_page",
    description: "Fetch a Confluence page by page ID, including body.storage.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "Confluence page ID."
        },
        expand: {
          type: "string",
          description: "Comma-separated expand fields. Default is body.storage,space,version,ancestors."
        }
      },
      required: ["pageId"],
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
    case "confluence_search":
      return await runToolSafely(() => confluenceSearch(args));
    case "confluence_get_page":
      return await runToolSafely(() => confluenceGetPage(args));
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

async function confluenceSearch(args) {
  const config = readConfig();
  const limit = clampInteger(args.limit, 10, 1, 50);
  const includeArchived = args.includeArchived === true;
  const spaceKey = stringOrUndefined(args.spaceKey) ?? config.defaultSpaceKey;
  const cql = buildSearchCql({
    query: stringOrUndefined(args.query),
    rawCql: stringOrUndefined(args.cql),
    spaceKey,
    includeArchived,
    defaultFilter: config.defaultCqlFilter
  });

  const data = await confluenceRequest(config, "/content/search", {
    cql,
    limit: String(limit),
    expand: "space,version"
  });

  const results = Array.isArray(data.results) ? data.results : [];
  const normalized = results.map((item) => ({
    id: item.id ?? null,
    title: item.title ?? null,
    type: item.type ?? null,
    spaceKey: item.space?.key ?? null,
    lastUpdated: item.version?.when ?? null,
    url: buildContentUrl(config.baseUrl, item._links),
    excerpt: extractExcerpt(item)
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            cql,
            count: normalized.length,
            results: normalized
          },
          null,
          2
        )
      }
    ]
  };
}

async function confluenceGetPage(args) {
  const config = readConfig();
  const pageId = stringOrUndefined(args.pageId);
  if (!pageId) {
    throw new Error("pageId is required");
  }

  const expand = stringOrUndefined(args.expand) ?? "body.storage,space,version,ancestors";
  const data = await confluenceRequest(
    config,
    `/content/${encodeURIComponent(pageId)}`,
    { expand }
  );

  const page = {
    id: data.id ?? null,
    title: data.title ?? null,
    type: data.type ?? null,
    spaceKey: data.space?.key ?? null,
    version: data.version?.number ?? null,
    lastUpdated: data.version?.when ?? null,
    url: buildContentUrl(config.baseUrl, data._links),
    ancestors: Array.isArray(data.ancestors)
      ? data.ancestors.map((ancestor) => ({
          id: ancestor.id ?? null,
          title: ancestor.title ?? null
        }))
      : [],
    bodyStorage: data.body?.storage?.value ?? null
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(page, null, 2)
      }
    ]
  };
}

function readConfig() {
  const baseUrlValue = stringOrUndefined(process.env.CONFLUENCE_BASE_URL);
  if (!baseUrlValue) {
    throw new Error("Missing CONFLUENCE_BASE_URL");
  }

  const baseUrl = new URL(baseUrlValue);
  const apiPath = normalizeApiPath(process.env.CONFLUENCE_API_PATH ?? "/wiki/rest/api");
  const authMode = inferAuthMode(process.env.CONFLUENCE_AUTH_MODE);
  const username = stringOrUndefined(process.env.CONFLUENCE_USERNAME);
  const password = stringOrUndefined(process.env.CONFLUENCE_PASSWORD);
  const email = stringOrUndefined(process.env.CONFLUENCE_EMAIL);
  const apiToken = stringOrUndefined(process.env.CONFLUENCE_API_TOKEN);
  const pat = stringOrUndefined(process.env.CONFLUENCE_PAT);
  const token = pat ?? apiToken;

  if (authMode === "basic") {
    const basicUser = username ?? email;
    const basicSecret = password ?? apiToken;
    if (!basicUser || !basicSecret) {
      throw new Error(
        "Basic auth requires either CONFLUENCE_USERNAME and CONFLUENCE_PASSWORD or CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN"
      );
    }
  } else if (!token) {
    throw new Error(
      "Bearer auth requires CONFLUENCE_PAT or CONFLUENCE_API_TOKEN"
    );
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
    defaultSpaceKey: stringOrUndefined(process.env.CONFLUENCE_SPACE_KEY),
    defaultCqlFilter: stringOrUndefined(process.env.CONFLUENCE_CQL_FILTER)
  };
}

function inferAuthMode(rawMode) {
  const mode = stringOrUndefined(rawMode)?.toLowerCase();
  if (mode === "basic" || mode === "bearer") {
    return mode;
  }

  if (stringOrUndefined(process.env.CONFLUENCE_EMAIL)) {
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

function buildSearchCql({ query, rawCql, spaceKey, includeArchived, defaultFilter }) {
  if (rawCql) {
    return rawCql;
  }

  if (!query) {
    throw new Error("Either query or cql must be provided");
  }

  const clauses = [
    "type = page",
    `text ~ "${escapeCqlString(query)}"`
  ];

  if (spaceKey) {
    clauses.push(`space = "${escapeCqlString(spaceKey)}"`);
  }

  if (defaultFilter) {
    clauses.push(`(${defaultFilter})`);
  }

  return clauses.join(" AND ");
}

function escapeCqlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function confluenceRequest(config, endpointPath, queryParams = {}) {
  const url = new URL(`${config.apiPath}${endpointPath}`, config.baseUrl);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const headers = {
    Accept: "application/json"
  };

  if (config.authMode === "basic") {
    const basicUser = config.username ?? config.email;
    const basicSecret = config.password ?? config.apiToken;
    headers.Authorization = `Basic ${Buffer.from(
      `${basicUser}:${basicSecret}`
    ).toString("base64")}`;
  } else {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  const response = await fetch(url, { headers });
  const rawText = await response.text();
  const parsedBody = tryParseJson(rawText);

  if (!response.ok) {
    const detail =
      parsedBody?.message ??
      parsedBody?.error ??
      parsedBody?.reason ??
      rawText.slice(0, 1000);
    throw new Error(
      `Confluence request failed (${response.status} ${response.statusText}): ${detail}`
    );
  }

  return parsedBody ?? {};
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

function extractExcerpt(item) {
  if (typeof item.excerpt === "string" && item.excerpt.trim()) {
    return sanitizeText(item.excerpt);
  }

  const storageValue = item.body?.storage?.value;
  if (typeof storageValue === "string" && storageValue.trim()) {
    return sanitizeText(storageValue).slice(0, 280);
  }

  return null;
}

function sanitizeText(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function buildContentUrl(baseUrl, links) {
  if (!links || typeof links !== "object") {
    return null;
  }

  const relative =
    stringOrUndefined(links.webui) ??
    stringOrUndefined(links.tinyui) ??
    stringOrUndefined(links.self);

  if (!relative) {
    return null;
  }

  try {
    return new URL(relative, baseUrl).toString();
  } catch {
    return relative;
  }
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
  process.stderr.write(`[confluence-mcp] ${message}: ${detail}\n`);
  if (context) {
    process.stderr.write(`[confluence-mcp] context: ${context}\n`);
  }
}
