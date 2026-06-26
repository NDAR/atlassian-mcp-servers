import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

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

const CONFIRMATION_TOKEN_TTL_SECONDS = 600;

export const TOOL_DEFINITIONS = [
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
  },
  {
    name: "confluence_create_page",
    description: "Dry-run or create a Confluence page using storage-format XHTML.",
    inputSchema: {
      type: "object",
      properties: {
        spaceKey: {
          type: "string",
          description: "Confluence space key where the page will be created."
        },
        title: {
          type: "string",
          description: "Title for the new page."
        },
        bodyStorage: {
          type: "string",
          description: "Confluence storage-format XHTML body. For generated pages, put the generated date and a brief Codex update description at the top; the server wraps that standard intro in a quote block by default."
        },
        parentPageId: {
          type: "string",
          description: "Optional parent page ID."
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
      required: ["spaceKey", "title", "bodyStorage"],
      additionalProperties: false
    }
  },
  {
    name: "confluence_update_page",
    description: "Dry-run or update a Confluence page title/body using storage-format XHTML.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "Confluence page ID."
        },
        currentVersion: {
          type: "integer",
          minimum: 1,
          description: "Current page version from confluence_get_page."
        },
        title: {
          type: "string",
          description: "Optional replacement title. Defaults to current title."
        },
        bodyStorage: {
          type: "string",
          description: "Optional replacement storage-format XHTML body. Defaults to current body. For generated updates, put the generated date and a brief Codex update description at the top; the server wraps that standard intro in a quote block by default."
        },
        versionMessage: {
          type: "string",
          description: "Optional version comment/message."
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
      required: ["pageId", "currentVersion"],
      additionalProperties: false
    }
  },
  {
    name: "confluence_add_comment",
    description: "Dry-run or add a comment to a Confluence page using storage-format XHTML.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "Confluence page ID to comment on."
        },
        bodyStorage: {
          type: "string",
          description: "Confluence storage-format XHTML comment body."
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
      required: ["pageId", "bodyStorage"],
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
    case "confluence_search":
      return await runToolSafely(() => confluenceSearch(args));
    case "confluence_get_page":
      return await runToolSafely(() => confluenceGetPage(args));
    case "confluence_create_page":
      return await runToolSafely(() => confluenceCreatePage(args));
    case "confluence_update_page":
      return await runToolSafely(() => confluenceUpdatePage(args));
    case "confluence_add_comment":
      return await runToolSafely(() => confluenceAddComment(args));
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
    queryParams: {
      cql,
      limit: String(limit),
      expand: "space,version"
    }
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

  return jsonContent({
    cql,
    count: normalized.length,
    results: normalized
  });
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
    {
      queryParams: { expand }
    }
  );

  return jsonContent(normalizePage(config, data));
}

async function confluenceCreatePage(args) {
  const config = readConfig();
  const spaceKey = requiredString(args.spaceKey, "spaceKey");
  const title = requiredString(args.title, "title");
  const bodyStorage = quoteGeneratedIntro(requiredString(args.bodyStorage, "bodyStorage"));
  const parentPageId = stringOrUndefined(args.parentPageId);
  const payload = buildCreatePagePayload({ spaceKey, title, bodyStorage, parentPageId });
  const tokenPayload = {
    operation: "confluence_create_page",
    method: "POST",
    endpointPath: "/content",
    spaceKey,
    title,
    bodyStorage,
    parentPageId: parentPageId ?? null
  };
  const preview = buildWritePreview(config, tokenPayload, {
    target: { spaceKey, parentPageId: parentPageId ?? null },
    version: null
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      const data = await confluenceRequest(config, "/content", {
        method: "POST",
        body: payload,
        queryParams: { expand: "space,version" }
      });
      return normalizeWriteResult(config, data);
    }
  });
}

async function confluenceUpdatePage(args) {
  const config = readConfig();
  const pageId = requiredString(args.pageId, "pageId");
  const currentVersion = requiredPositiveInteger(args.currentVersion, "currentVersion");
  const nextTitle = stringOrUndefined(args.title);
  const nextBodyStorage = stringOrUndefined(args.bodyStorage);
  const versionMessage = stringOrUndefined(args.versionMessage);

  if (!nextTitle && !nextBodyStorage) {
    throw new Error("Either title or bodyStorage must be provided");
  }

  const currentPage = await fetchCurrentPageForUpdate(config, pageId);
  assertCurrentVersion(currentPage, currentVersion);

  const title = nextTitle ?? currentPage.title;
  const bodyStorage =
    nextBodyStorage === undefined
      ? currentPage.bodyStorage
      : quoteGeneratedIntro(nextBodyStorage);
  if (!title) {
    throw new Error("Current page title is unavailable; title is required");
  }
  if (!bodyStorage) {
    throw new Error("Current page body is unavailable; bodyStorage is required");
  }

  const payload = buildUpdatePagePayload({
    title,
    bodyStorage,
    nextVersion: currentVersion + 1,
    versionMessage
  });
  const endpointPath = `/content/${encodeURIComponent(pageId)}`;
  const tokenPayload = {
    operation: "confluence_update_page",
    method: "PUT",
    endpointPath,
    pageId,
    currentVersion,
    nextVersion: currentVersion + 1,
    title,
    bodyStorage,
    versionMessage: versionMessage ?? null
  };
  const preview = buildWritePreview(config, tokenPayload, {
    target: { pageId },
    version: {
      current: currentVersion,
      next: currentVersion + 1
    }
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      const latestPage = await fetchCurrentPageForUpdate(config, pageId);
      assertCurrentVersion(latestPage, currentVersion);
      const data = await confluenceRequest(config, endpointPath, {
        method: "PUT",
        body: payload,
        queryParams: { expand: "space,version" }
      });
      return normalizeWriteResult(config, data);
    }
  });
}

async function confluenceAddComment(args) {
  const config = readConfig();
  const pageId = requiredString(args.pageId, "pageId");
  const bodyStorage = requiredString(args.bodyStorage, "bodyStorage");
  const payload = buildAddCommentPayload({ pageId, bodyStorage });
  const tokenPayload = {
    operation: "confluence_add_comment",
    method: "POST",
    endpointPath: "/content",
    pageId,
    bodyStorage
  };
  const preview = buildWritePreview(config, tokenPayload, {
    target: { pageId },
    version: null
  });

  return await previewOrExecuteWrite({
    config,
    args,
    tokenPayload,
    preview,
    execute: async () => {
      const data = await confluenceRequest(config, "/content", {
        method: "POST",
        body: payload,
        queryParams: { expand: "space,version" }
      });
      return normalizeWriteResult(config, data);
    }
  });
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

function buildCreatePagePayload({ spaceKey, title, bodyStorage, parentPageId }) {
  const payload = {
    type: "page",
    title,
    space: {
      key: spaceKey
    },
    body: {
      storage: {
        value: bodyStorage,
        representation: "storage"
      }
    }
  };

  if (parentPageId) {
    payload.ancestors = [{ id: parentPageId }];
  }

  return payload;
}

function buildUpdatePagePayload({ title, bodyStorage, nextVersion, versionMessage }) {
  const payload = {
    type: "page",
    title,
    version: {
      number: nextVersion
    },
    body: {
      storage: {
        value: bodyStorage,
        representation: "storage"
      }
    }
  };

  if (versionMessage) {
    payload.version.message = versionMessage;
  }

  return payload;
}

function buildAddCommentPayload({ pageId, bodyStorage }) {
  return {
    type: "comment",
    container: {
      id: pageId,
      type: "page"
    },
    body: {
      storage: {
        value: bodyStorage,
        representation: "storage"
      }
    }
  };
}

function quoteGeneratedIntro(bodyStorage) {
  const metadataParagraphPattern =
    /<p\b[^>]*>\s*<strong>\s*(?:Generated|Latest source snapshot found|Codex update)\s*:\s*<\/strong>[\s\S]*?<\/p>/gi;
  const firstMetadataMatch = metadataParagraphPattern.exec(bodyStorage);

  if (!firstMetadataMatch) {
    return bodyStorage;
  }

  const prefix = bodyStorage.slice(0, firstMetadataMatch.index);
  const generatedStartsAfterTitle =
    prefix.trim() === "" || /^<h1\b[\s\S]*<\/h1>$/i.test(prefix.trim());
  if (!generatedStartsAfterTitle || /<blockquote\b/i.test(prefix)) {
    return bodyStorage;
  }

  metadataParagraphPattern.lastIndex = firstMetadataMatch.index;
  const matches = [];
  let searchIndex = firstMetadataMatch.index;
  let match;
  while ((match = metadataParagraphPattern.exec(bodyStorage)) !== null) {
    if (bodyStorage.slice(searchIndex, match.index).trim() !== "") {
      break;
    }
    matches.push(match);
    searchIndex = match.index + match[0].length;
  }

  const hasGenerated = matches.some((item) => /<strong>\s*Generated\s*:/i.test(item[0]));
  const hasCodexUpdate = matches.some((item) => /<strong>\s*Codex update\s*:/i.test(item[0]));
  if (!hasGenerated || !hasCodexUpdate) {
    return bodyStorage;
  }

  const quoteStart = matches[0].index;
  const quoteEnd = matches.at(-1).index + matches.at(-1)[0].length;
  if (/^<blockquote\b/i.test(bodyStorage.slice(quoteStart).trimStart())) {
    return bodyStorage;
  }

  return `${bodyStorage.slice(0, quoteStart)}<blockquote>${bodyStorage.slice(
    quoteStart,
    quoteEnd
  )}</blockquote>${bodyStorage.slice(quoteEnd)}`;
}

async function fetchCurrentPageForUpdate(config, pageId) {
  const data = await confluenceRequest(
    config,
    `/content/${encodeURIComponent(pageId)}`,
    {
      queryParams: { expand: "body.storage,space,version" }
    }
  );
  return normalizePage(config, data);
}

function assertCurrentVersion(page, expectedVersion) {
  if (page.version !== expectedVersion) {
    throw new Error(
      `Page version mismatch for ${page.id}: expected ${expectedVersion}, found ${page.version}`
    );
  }
}

function buildWritePreview(config, tokenPayload, extras) {
  const confirmationToken = createConfirmationToken(config, tokenPayload);
  const issuedAt = parseConfirmationToken(confirmationToken).issuedAt;

  return {
    dryRun: true,
    operation: tokenPayload.operation,
    method: tokenPayload.method,
    endpointPath: tokenPayload.endpointPath,
    target: extras.target,
    title: tokenPayload.title ?? null,
    version: extras.version,
    bodyLength: tokenPayload.bodyStorage.length,
    bodySha256: sha256Hex(tokenPayload.bodyStorage),
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
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
    authSecret: authMode === "basic" ? password ?? apiToken : token,
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

async function confluenceRequest(config, endpointPath, options = {}) {
  const url = new URL(`${config.apiPath}${endpointPath}`, config.baseUrl);
  const queryParams = options.queryParams ?? options;
  for (const [key, value] of Object.entries(queryParams)) {
    if (
      key !== "method" &&
      key !== "body" &&
      key !== "queryParams" &&
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, value);
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

function normalizePage(config, data) {
  return {
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
}

function normalizeWriteResult(config, data) {
  return {
    id: data.id ?? null,
    title: data.title ?? null,
    type: data.type ?? null,
    version: data.version?.number ?? null,
    spaceKey: data.space?.key ?? null,
    url: buildContentUrl(config.baseUrl, data._links)
  };
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

function requiredPositiveInteger(value, name) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return numeric;
}

function requiredString(value, name) {
  const normalized = stringOrUndefined(value);
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
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
  process.stderr.write(`[confluence-mcp] ${message}: ${detail}\n`);
  if (context) {
    process.stderr.write(`[confluence-mcp] context: ${context}\n`);
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  startStdioServer();
}
