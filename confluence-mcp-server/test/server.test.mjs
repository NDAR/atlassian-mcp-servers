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

test("search wraps raw CQL with blocked spaces and blocked label filters", async () => {
  process.env.CONFLUENCE_BLOCKED_SPACES = "SEC";
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    return jsonResponse({
      results: [
        pageResponse({ id: "1", title: "Allowed", version: 1, spaceKey: "NOR", labels: ["public"] }),
        pageResponse({ id: "2", title: "Blocked Space", version: 1, spaceKey: "SEC", labels: [] }),
        pageResponse({ id: "3", title: "Sensitive", version: 1, spaceKey: "PM", labels: ["sensitive"] })
      ]
    });
  };

  const result = parseToolJson(await callTool("confluence_search", {
    cql: 'title ~ "budget" ORDER BY lastmodified DESC',
    limit: 10
  }));
  const requestUrl = new URL(fetchCalls[0].url);

  assert.equal(
    requestUrl.searchParams.get("cql"),
    '(title ~ "budget") AND space not in ("SEC") AND label not in ("sensitive", "internal", "restricted") ORDER BY lastmodified DESC'
  );
  assert.equal(requestUrl.searchParams.get("expand"), "space,version,metadata.labels");
  assert.equal(result.count, 1);
  assert.equal(result.results[0].spaceKey, "NOR");
});

test("generated search rejects a requested blocked space", async () => {
  process.env.CONFLUENCE_BLOCKED_SPACES = "SEC";
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error("fetch should not be called");
  };

  const result = await callTool("confluence_search", {
    query: "runbook",
    spaceKey: "SEC"
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONFLUENCE_BLOCKED_SPACES/);
  assert.equal(fetchCalls.length, 0);
});

test("get page rejects pages in blocked spaces before returning body", async () => {
  process.env.CONFLUENCE_BLOCKED_SPACES = "SEC";
  global.fetch = async () => jsonResponse(
    pageResponse({ id: "123", title: "Outside", version: 1, spaceKey: "SEC", body: "<p>secret</p>" })
  );

  const result = await callTool("confluence_get_page", { pageId: "123" });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONFLUENCE_BLOCKED_SPACES/);
  assert.doesNotMatch(result.content[0].text, /secret/);
});

test("get page rejects blocked labels before returning body", async () => {
  global.fetch = async () => jsonResponse(
    pageResponse({ id: "123", title: "Sensitive", version: 1, labels: ["internal"], body: "<p>private</p>" })
  );

  const result = await callTool("confluence_get_page", { pageId: "123" });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /blocked label internal/);
  assert.doesNotMatch(result.content[0].text, /private/);
});

test("get page rejects blocked ancestor labels before returning body", async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url.toString());
    if (url.toString().includes("/content/parent")) {
      return jsonResponse(
        pageResponse({
          id: "parent",
          title: "Parent",
          version: 1,
          labels: ["restricted"],
          body: "<p>parent private</p>"
        })
      );
    }
    return jsonResponse(
      pageResponse({
        id: "child",
        title: "Child",
        version: 1,
        body: "<p>child private</p>",
        ancestors: [{ id: "parent", title: "Parent" }]
      })
    );
  };

  const result = await callTool("confluence_get_page", { pageId: "child" });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ancestor page parent has blocked label restricted/);
  assert.doesNotMatch(result.content[0].text, /child private/);
  assert.doesNotMatch(result.content[0].text, /parent private/);
  assert.equal(fetchCalls.length, 2);
});

test("search filters pages with blocked ancestor labels", async () => {
  const child = pageResponse({
    id: "child",
    title: "Child",
    version: 1,
    body: "<p>child private</p>"
  });
  delete child.ancestors;

  global.fetch = async (url) => {
    const textUrl = url.toString();
    if (textUrl.includes("/content/search")) {
      return jsonResponse({ results: [child] });
    }
    if (textUrl.includes("/content/child")) {
      return jsonResponse(
        pageResponse({
          id: "child",
          title: "Child",
          version: 1,
          ancestors: [{ id: "parent", title: "Parent" }]
        })
      );
    }
    if (textUrl.includes("/content/parent")) {
      return jsonResponse(
        pageResponse({
          id: "parent",
          title: "Parent",
          version: 1,
          labels: ["restricted"],
          body: "<p>parent private</p>"
        })
      );
    }
    throw new Error(`unexpected URL ${textUrl}`);
  };

  const result = parseToolJson(await callTool("confluence_search", {
    query: "child"
  }));

  assert.equal(result.count, 0);
  assert.deepEqual(result.results, []);
});

test("single-page blocked ancestor labels do not block child pages", async () => {
  const child = pageResponse({
    id: "child",
    title: "Child",
    version: 1,
    body: "<p>child body</p>"
  });
  delete child.ancestors;

  global.fetch = async (url) => {
    const textUrl = url.toString();
    if (textUrl.includes("/content/search")) {
      return jsonResponse({ results: [child] });
    }
    if (textUrl.includes("/content/child")) {
      return jsonResponse(
        pageResponse({
          id: "child",
          title: "Child",
          version: 1,
          ancestors: [{ id: "parent", title: "Parent" }]
        })
      );
    }
    if (textUrl.includes("/content/parent")) {
      return jsonResponse(
        pageResponse({
          id: "parent",
          title: "Parent",
          version: 1,
          labels: ["sensitive"]
        })
      );
    }
    throw new Error(`unexpected URL ${textUrl}`);
  };

  const result = parseToolJson(await callTool("confluence_search", {
    query: "child"
  }));

  assert.equal(result.count, 1);
  assert.equal(result.results[0].id, "child");
});

test("writes reject blocked spaces and blocked target pages before preview", async () => {
  process.env.CONFLUENCE_BLOCKED_SPACES = "SEC";
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    return jsonResponse(
      pageResponse({ id: "123", title: "Sensitive", version: 1, spaceKey: "NOR", labels: ["restricted"] })
    );
  };

  const create = await callTool("confluence_create_page", {
    spaceKey: "SEC",
    title: "New Page",
    bodyStorage: "<p>Hello</p>"
  });
  const update = await callTool("confluence_update_page", {
    pageId: "123",
    currentVersion: 1,
    title: "Updated"
  });

  assert.equal(create.isError, true);
  assert.match(create.content[0].text, /CONFLUENCE_BLOCKED_SPACES/);
  assert.equal(update.isError, true);
  assert.match(update.content[0].text, /blocked label restricted/);
  assert.equal(fetchCalls.length, 1);
});

test("create page rejects blocked parent pages before preview", async () => {
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    return jsonResponse(
      pageResponse({ id: "parent", title: "Parent", version: 1, labels: ["restricted"] })
    );
  };

  const result = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    parentPageId: "parent",
    title: "Child",
    bodyStorage: "<p>Child</p>"
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /blocked label restricted/);
  assert.equal(fetchCalls.length, 1);
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

test("create page wraps generated metadata intro in quote format", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    return jsonResponse(pageResponse({ id: "123", title: "Generated Page", version: 1 }));
  };

  const bodyStorage =
    "<h1>Generated Page</h1>" +
    "<p><strong>Generated:</strong> 2026-06-26</p>" +
    "<p><strong>Latest source snapshot found:</strong> Source Page.</p>" +
    "<p><strong>Codex update:</strong> Added a current snapshot.</p>" +
    "<h2>Details</h2><p>Body.</p>";

  const preview = await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "Generated Page",
    bodyStorage
  });
  const token = parseToolJson(preview).confirmationToken;

  await callTool("confluence_create_page", {
    spaceKey: "ENG",
    title: "Generated Page",
    bodyStorage,
    dryRun: false,
    confirmationToken: token
  });
  const writeCall = fetchCalls.find((call) => call.options.method === "POST");
  const requestBody = JSON.parse(writeCall.options.body);

  assert.equal(
    requestBody.body.storage.value,
    "<h1>Generated Page</h1><blockquote>" +
      "<p><strong>Generated:</strong> 2026-06-26</p>" +
      "<p><strong>Latest source snapshot found:</strong> Source Page.</p>" +
      "<p><strong>Codex update:</strong> Added a current snapshot.</p>" +
      "</blockquote><h2>Details</h2><p>Body.</p>"
  );
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

test("update page wraps generated metadata intro in quote format", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    if (options.method === "PUT") {
      return jsonResponse(pageResponse({ id: "123", title: "Existing", version: 3 }));
    }
    return jsonResponse(pageResponse({ id: "123", title: "Existing", version: 2 }));
  };

  const bodyStorage =
    "<h1>Existing</h1>" +
    "<p><strong>Generated:</strong> 2026-06-26</p>" +
    "<p><strong>Codex update:</strong> Refreshed a status table.</p>" +
    "<h2>Status</h2><p>Body.</p>";

  const preview = await callTool("confluence_update_page", {
    pageId: "123",
    currentVersion: 2,
    bodyStorage
  });
  const token = parseToolJson(preview).confirmationToken;

  await callTool("confluence_update_page", {
    pageId: "123",
    currentVersion: 2,
    bodyStorage,
    dryRun: false,
    confirmationToken: token
  });
  const writeCall = fetchCalls.find((call) => call.options.method === "PUT");
  const requestBody = JSON.parse(writeCall.options.body);

  assert.equal(
    requestBody.body.storage.value,
    "<h1>Existing</h1><blockquote>" +
      "<p><strong>Generated:</strong> 2026-06-26</p>" +
      "<p><strong>Codex update:</strong> Refreshed a status table.</p>" +
      "</blockquote><h2>Status</h2><p>Body.</p>"
  );
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

function pageResponse({
  id,
  title,
  version,
  body = "<p>Existing</p>",
  spaceKey = "ENG",
  labels = [],
  ancestors = []
}) {
  return {
    id,
    type: "page",
    title,
    space: { key: spaceKey },
    version: { number: version, when: "2026-06-26T00:00:00.000Z" },
    metadata: {
      labels: {
        results: labels.map((name) => ({ name }))
      }
    },
    ancestors,
    body: { storage: { value: body } },
    _links: { webui: `/display/${spaceKey}/${encodeURIComponent(title)}` }
  };
}
