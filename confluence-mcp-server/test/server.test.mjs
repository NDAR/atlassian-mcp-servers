import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { TOOL_DEFINITIONS, handleToolCall } from "../src/server.mjs";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_DATE_NOW = Date.now;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    CONFLUENCE_BASE_URL: "https://wiki.example.test",
    CONFLUENCE_API_PATH: "/rest/api",
    CONFLUENCE_AUTH_MODE: "bearer",
    CONFLUENCE_PAT: "test-token"
  };
  Date.now = ORIGINAL_DATE_NOW;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  Date.now = ORIGINAL_DATE_NOW;
});

test("tool list includes Confluence write tools", () => {
  const toolNames = TOOL_DEFINITIONS.map((tool) => tool.name);

  assert.ok(toolNames.includes("confluence_create_page"));
  assert.ok(toolNames.includes("confluence_update_page"));
  assert.ok(toolNames.includes("confluence_add_comment"));
});

test("create page dry-run returns a preview without writing", async () => {
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error("fetch should not be called");
  };

  const result = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "New Page",
    bodyStorage: "<p>Hello</p>"
  });
  const preview = parseToolJson(result);

  assert.equal(result.isError, undefined);
  assert.equal(fetchCalls.length, 0);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.operation, "confluence_create_page");
  assert.equal(preview.method, "POST");
  assert.equal(preview.endpointPath, "/content");
  assert.equal(preview.target.spaceKey, "ENG");
  assert.equal(preview.title, "New Page");
  assert.equal(preview.bodyLength, "<p>Hello</p>".length);
  assert.match(preview.bodySha256, /^[a-f0-9]{64}$/);
  assert.match(preview.confirmationToken, /^v1\.\d+\.[a-f0-9]{64}$/);
});

test("create page execute rejects missing, expired, and mismatched tokens", async () => {
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    return jsonResponse({ id: "1" });
  };

  const missing = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "New Page",
    bodyStorage: "<p>Hello</p>",
    dryRun: false
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /confirmationToken/);

  Date.now = () => 1_700_000_000_000;
  const previewResult = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "New Page",
    bodyStorage: "<p>Hello</p>"
  });
  const token = parseToolJson(previewResult).confirmationToken;

  Date.now = () => 1_700_000_601_000;
  const expired = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "New Page",
    bodyStorage: "<p>Hello</p>",
    dryRun: false,
    confirmationToken: token
  });
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /expired/);

  Date.now = () => 1_700_000_100_000;
  const mismatched = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "Changed Title",
    bodyStorage: "<p>Hello</p>",
    dryRun: false,
    confirmationToken: token
  });
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.content[0].text, /does not match/);
  assert.equal(fetchCalls.length, 0);
});

test("update page rejects stale currentVersion", async () => {
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    return jsonResponse(pageResponse({ id: "123", title: "Existing", version: 3 }));
  };

  const result = await callTool("confluence_update_page", {
    pageId: "123",
    currentVersion: 2,
    title: "Updated"
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /version mismatch/);
  assert.equal(fetchCalls.length, 1);
});

test("update page executes with next version number", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    if (options.method === "PUT") {
      return jsonResponse(
        pageResponse({ id: "123", title: "Existing", version: 3, body: "<p>Updated</p>" })
      );
    }
    return jsonResponse(
      pageResponse({ id: "123", title: "Existing", version: 2, body: "<p>Old</p>" })
    );
  };

  const preview = await callTool("confluence_update_page", {
    pageId: "123",
    currentVersion: 2,
    bodyStorage: "<p>Updated</p>",
    versionMessage: "Updated by MCP"
  });
  const token = parseToolJson(preview).confirmationToken;

  const executeResult = await callTool("confluence_update_page", {
    pageId: "123",
    currentVersion: 2,
    bodyStorage: "<p>Updated</p>",
    versionMessage: "Updated by MCP",
    dryRun: false,
    confirmationToken: token
  });
  const writeCall = fetchCalls.find((call) => call.options.method === "PUT");
  const requestBody = JSON.parse(writeCall.options.body);
  const result = parseToolJson(executeResult);

  assert.equal(executeResult.isError, undefined);
  assert.equal(writeCall.url, "https://wiki.example.test/rest/api/content/123?expand=space%2Cversion");
  assert.equal(requestBody.type, "page");
  assert.equal(requestBody.title, "Existing");
  assert.equal(requestBody.version.number, 3);
  assert.equal(requestBody.version.message, "Updated by MCP");
  assert.equal(requestBody.body.storage.value, "<p>Updated</p>");
  assert.equal(result.executed, true);
  assert.equal(result.result.version, 3);
});

test("add comment executes with expected comment payload", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    return jsonResponse({
      id: "900",
      type: "comment",
      title: "Re: Existing",
      version: { number: 1 },
      _links: { webui: "/display/ENG/Existing?focusedCommentId=900" }
    });
  };

  const preview = await callTool("confluence_add_comment", {
    pageId: "123",
    bodyStorage: "<p>Looks good.</p>"
  });
  const token = parseToolJson(preview).confirmationToken;

  const executeResult = await callTool("confluence_add_comment", {
    pageId: "123",
    bodyStorage: "<p>Looks good.</p>",
    dryRun: false,
    confirmationToken: token
  });
  const writeCall = fetchCalls.find((call) => call.options.method === "POST");
  const requestBody = JSON.parse(writeCall.options.body);
  const result = parseToolJson(executeResult);

  assert.equal(executeResult.isError, undefined);
  assert.equal(writeCall.url, "https://wiki.example.test/rest/api/content?expand=space%2Cversion");
  assert.equal(requestBody.type, "comment");
  assert.deepEqual(requestBody.container, { id: "123", type: "page" });
  assert.equal(requestBody.body.storage.value, "<p>Looks good.</p>");
  assert.equal(requestBody.body.storage.representation, "storage");
  assert.equal(result.executed, true);
  assert.equal(result.result.id, "900");
});

async function callTool(name, args) {
  return await handleToolCall({
    name,
    arguments: args
  });
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function pageResponse({ id, title, version, body = "<p>Existing</p>" }) {
  return {
    id,
    type: "page",
    title,
    space: { key: "ENG" },
    version: { number: version, when: "2026-06-26T00:00:00.000Z" },
    body: { storage: { value: body } },
    _links: { webui: `/display/ENG/${encodeURIComponent(title)}` }
  };
}
