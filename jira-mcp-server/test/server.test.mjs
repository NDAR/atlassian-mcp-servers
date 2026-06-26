import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { TOOL_DEFINITIONS, handleToolCall } from "../src/server.mjs";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_DATE_NOW = Date.now;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    JIRA_BASE_URL: "https://jira.example.test",
    JIRA_API_PATH: "/rest/api/2",
    JIRA_AUTH_MODE: "bearer",
    JIRA_PAT: "test-token"
  };
  Date.now = () => Date.parse("2026-06-26T12:00:00.000Z");
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  Date.now = ORIGINAL_DATE_NOW;
});

test("tool list includes Jira read and write tools", () => {
  const toolNames = TOOL_DEFINITIONS.map((tool) => tool.name);

  assert.ok(toolNames.includes("jira_search"));
  assert.ok(toolNames.includes("jira_get_issue"));
  assert.ok(toolNames.includes("jira_create_issue"));
  assert.ok(toolNames.includes("jira_update_issue"));
  assert.ok(toolNames.includes("jira_transition_issue"));
  assert.ok(toolNames.includes("jira_assign_issue"));
  assert.ok(toolNames.includes("jira_add_comment"));
  assert.ok(toolNames.includes("jira_list_transitions"));
});

test("create issue dry-run returns a preview without writing", async () => {
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error("fetch should not be called");
  };

  const result = await callTool("jira_create_issue", {
    projectKey: "ENG",
    issueType: "Task",
    summary: "New issue"
  });
  const preview = parseToolJson(result);

  assert.equal(result.isError, undefined);
  assert.equal(fetchCalls.length, 0);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.operation, "jira_create_issue");
  assert.equal(preview.method, "POST");
  assert.equal(preview.endpointPath, "/issue");
  assert.equal(preview.target.projectKey, "ENG");
  assert.equal(preview.summary, "New issue");
  assert.match(preview.payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(preview.confirmationToken, /^v1\.\d+\.[a-f0-9]{64}$/);
});

test("write execute rejects missing, expired, and mismatched tokens", async () => {
  const fetchCalls = [];
  global.fetch = async (...args) => {
    fetchCalls.push(args);
    return jsonResponse({ id: "1", key: "ENG-1" });
  };

  const missing = await callTool("jira_create_issue", {
    projectKey: "ENG",
    issueType: "Task",
    summary: "New issue",
    dryRun: false
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /confirmationToken/);

  Date.now = () => 1_700_000_000_000;
  const preview = await callTool("jira_create_issue", {
    projectKey: "ENG",
    issueType: "Task",
    summary: "New issue"
  });
  const token = parseToolJson(preview).confirmationToken;

  Date.now = () => 1_700_000_601_000;
  const expired = await callTool("jira_create_issue", {
    projectKey: "ENG",
    issueType: "Task",
    summary: "New issue",
    dryRun: false,
    confirmationToken: token
  });
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /expired/);

  Date.now = () => 1_700_000_100_000;
  const mismatched = await callTool("jira_create_issue", {
    projectKey: "ENG",
    issueType: "Task",
    summary: "Changed issue",
    dryRun: false,
    confirmationToken: token
  });
  assert.equal(mismatched.isError, true);
  assert.match(mismatched.content[0].text, /does not match/);
  assert.equal(fetchCalls.length, 0);
});

test("write execute surfaces Jira field-specific error details", async () => {
  global.fetch = async () => jsonResponse({
    errorMessages: [],
    errors: {
      customfield_12345: "Start date is required."
    }
  }, 400);

  const args = {
    projectKey: "PMO",
    issueType: "PTO",
    summary: "Nathan - PTO (6/29-7/10)"
  };
  const preview = await callTool("jira_create_issue", args);
  const token = parseToolJson(preview).confirmationToken;

  const result = await callTool("jira_create_issue", {
    ...args,
    dryRun: false,
    confirmationToken: token
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /customfield_12345: Start date is required\./);
});

test("create issue maps common fields, merges raw fields, and applies attribution", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    return jsonResponse({ id: "10001", key: "ENG-42", self: "https://jira.example.test/rest/api/2/issue/10001" });
  };

  const args = {
    projectKey: "ENG",
    issueType: "Story",
    summary: "Build write tool",
    description: "Initial description",
    priority: "High",
    assignee: { name: "kimny" },
    labels: ["mcp"],
    components: ["API"],
    fixVersions: ["2026 Jun"],
    fields: {
      customfield_10010: "raw value"
    }
  };
  const preview = await callTool("jira_create_issue", args);
  const token = parseToolJson(preview).confirmationToken;

  const execute = await callTool("jira_create_issue", {
    ...args,
    dryRun: false,
    confirmationToken: token
  });
  const writeCall = fetchCalls.find((call) => call.options.method === "POST");
  const requestBody = JSON.parse(writeCall.options.body);
  const result = parseToolJson(execute);

  assert.equal(writeCall.url, "https://jira.example.test/rest/api/2/issue");
  assert.deepEqual(requestBody.fields.project, { key: "ENG" });
  assert.deepEqual(requestBody.fields.issuetype, { name: "Story" });
  assert.equal(requestBody.fields.summary, "Build write tool");
  assert.equal(requestBody.fields.priority.name, "High");
  assert.deepEqual(requestBody.fields.assignee, { name: "kimny" });
  assert.deepEqual(requestBody.fields.components, [{ name: "API" }]);
  assert.deepEqual(requestBody.fields.fixVersions, [{ name: "2026 Jun" }]);
  assert.equal(requestBody.fields.customfield_10010, "raw value");
  assert.deepEqual(requestBody.fields.labels, ["mcp", "codex-assisted"]);
  assert.match(
    requestBody.fields.description,
    /Created with Codex via Jira MCP on 2026-06-26 at the user's request\./
  );
  assert.equal(result.executed, true);
  assert.equal(result.result.key, "ENG-42");
});

test("update issue applies fields and creates attribution comment", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    if (url.toString().endsWith("/comment")) {
      return jsonResponse({ id: "900", body: JSON.parse(options.body).body });
    }
    return emptyResponse();
  };

  const args = {
    issueKey: "ENG-42",
    summary: "Updated summary",
    labels: ["updated"],
    update: {
      fixVersions: [{ add: { name: "2026 Jul" } }]
    }
  };
  const preview = await callTool("jira_update_issue", args);
  const token = parseToolJson(preview).confirmationToken;

  const execute = await callTool("jira_update_issue", {
    ...args,
    dryRun: false,
    confirmationToken: token
  });
  const issueCall = fetchCalls.find((call) => call.options.method === "PUT");
  const commentCall = fetchCalls.find((call) => call.options.method === "POST");
  const requestBody = JSON.parse(issueCall.options.body);
  const commentBody = JSON.parse(commentCall.options.body);
  const result = parseToolJson(execute);

  assert.equal(issueCall.url, "https://jira.example.test/rest/api/2/issue/ENG-42");
  assert.deepEqual(requestBody.fields, {
    summary: "Updated summary",
    labels: ["updated"]
  });
  assert.deepEqual(requestBody.update, {
    fixVersions: [{ add: { name: "2026 Jul" } }]
  });
  assert.equal(commentCall.url, "https://jira.example.test/rest/api/2/issue/ENG-42/comment");
  assert.equal(commentBody.body, "Codex via Jira MCP updated this issue on 2026-06-26.");
  assert.equal(result.result.auditComment.id, "900");
});

test("transition issue posts transition payload and audit comment", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    if (url.toString().endsWith("/comment")) {
      return jsonResponse({ id: "901", body: JSON.parse(options.body).body });
    }
    return emptyResponse();
  };

  const args = {
    issueKey: "ENG-42",
    transitionId: "31",
    comment: "Moving forward."
  };
  const preview = await callTool("jira_transition_issue", args);
  const token = parseToolJson(preview).confirmationToken;

  await callTool("jira_transition_issue", {
    ...args,
    dryRun: false,
    confirmationToken: token
  });
  const transitionCall = fetchCalls.find((call) => call.url.endsWith("/transitions"));
  const commentCall = fetchCalls.find((call) => call.url.endsWith("/comment"));
  const transitionBody = JSON.parse(transitionCall.options.body);
  const commentBody = JSON.parse(commentCall.options.body);

  assert.equal(transitionCall.options.method, "POST");
  assert.deepEqual(transitionBody.transition, { id: "31" });
  assert.deepEqual(transitionBody.update.comment, [{ add: { body: "Moving forward." } }]);
  assert.equal(
    commentBody.body,
    "Codex via Jira MCP transitioned this issue using transition 31 on 2026-06-26."
  );
});

test("list transitions returns available workflow actions", async () => {
  global.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(
      url.toString(),
      "https://jira.example.test/rest/api/2/issue/ENG-42/transitions?expand=transitions.fields"
    );
    return jsonResponse({
      transitions: [
        {
          id: "51",
          name: "Done",
          to: {
            id: "10001",
            name: "Done",
            statusCategory: { name: "Done" }
          },
          hasScreen: false,
          fields: {
            resolution: {
              required: true,
              name: "Resolution",
              allowedValues: [{ id: "1", name: "Done" }]
            }
          }
        }
      ]
    });
  };

  const result = parseToolJson(await callTool("jira_list_transitions", {
    issueKey: "ENG-42"
  }));

  assert.equal(result.count, 1);
  assert.deepEqual(result.transitions[0], {
    id: "51",
    name: "Done",
    to: {
      id: "10001",
      name: "Done",
      statusCategory: "Done"
    },
    hasScreen: false,
    fields: {
      resolution: {
        required: true,
        name: "Resolution",
        schema: null,
        allowedValues: [{ id: "1", name: "Done" }]
      }
    }
  });
});

test("assign issue posts assignee payload and audit comment", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    if (url.toString().endsWith("/comment")) {
      return jsonResponse({ id: "902", body: JSON.parse(options.body).body });
    }
    return emptyResponse();
  };

  const args = {
    issueKey: "ENG-42",
    name: "kimny"
  };
  const preview = await callTool("jira_assign_issue", args);
  const token = parseToolJson(preview).confirmationToken;

  await callTool("jira_assign_issue", {
    ...args,
    dryRun: false,
    confirmationToken: token
  });
  const assignCall = fetchCalls.find((call) => call.url.endsWith("/assignee"));
  const commentCall = fetchCalls.find((call) => call.url.endsWith("/comment"));

  assert.equal(assignCall.options.method, "PUT");
  assert.deepEqual(JSON.parse(assignCall.options.body), { name: "kimny" });
  assert.equal(
    JSON.parse(commentCall.options.body).body,
    "Codex via Jira MCP updated this issue's assignee on 2026-06-26."
  );
});

test("add comment appends attribution footer by default", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    return jsonResponse({ id: "903", body: JSON.parse(options.body).body });
  };

  const args = {
    issueKey: "ENG-42",
    body: "Looks good."
  };
  const preview = await callTool("jira_add_comment", args);
  const token = parseToolJson(preview).confirmationToken;

  const execute = await callTool("jira_add_comment", {
    ...args,
    dryRun: false,
    confirmationToken: token
  });
  const requestBody = JSON.parse(fetchCalls[0].options.body);
  const result = parseToolJson(execute);

  assert.equal(requestBody.body, "Looks good.\n\nPosted with Codex via Jira MCP.");
  assert.equal(result.result.comment.id, "903");
});

test("codexAttribution false suppresses labels, footers, and audit comments", async () => {
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url: url.toString(), options });
    if (url.toString().endsWith("/comment")) {
      return jsonResponse({ id: "904", body: JSON.parse(options.body).body });
    }
    return url.toString().endsWith("/issue")
      ? jsonResponse({ id: "10002", key: "ENG-43" })
      : emptyResponse();
  };

  const createArgs = {
    projectKey: "ENG",
    issueType: "Task",
    summary: "Exact issue",
    description: "Exact description",
    labels: ["exact"],
    codexAttribution: false
  };
  const createPreview = await callTool("jira_create_issue", createArgs);
  await callTool("jira_create_issue", {
    ...createArgs,
    dryRun: false,
    confirmationToken: parseToolJson(createPreview).confirmationToken
  });

  const updateArgs = {
    issueKey: "ENG-43",
    summary: "Exact summary",
    codexAttribution: false
  };
  const updatePreview = await callTool("jira_update_issue", updateArgs);
  await callTool("jira_update_issue", {
    ...updateArgs,
    dryRun: false,
    confirmationToken: parseToolJson(updatePreview).confirmationToken
  });

  const commentArgs = {
    issueKey: "ENG-43",
    body: "Exact comment",
    codexAttribution: false
  };
  const commentPreview = await callTool("jira_add_comment", commentArgs);
  await callTool("jira_add_comment", {
    ...commentArgs,
    dryRun: false,
    confirmationToken: parseToolJson(commentPreview).confirmationToken
  });

  const createBody = JSON.parse(fetchCalls[0].options.body);
  const commentCalls = fetchCalls.filter((call) => call.url.endsWith("/comment"));
  assert.deepEqual(createBody.fields.labels, ["exact"]);
  assert.equal(createBody.fields.description, "Exact description");
  assert.equal(commentCalls.length, 1);
  assert.equal(JSON.parse(commentCalls[0].options.body).body, "Exact comment");
});

test("existing read tools still work", async () => {
  global.fetch = async (url, options) => {
    if (url.toString().endsWith("/search")) {
      assert.equal(options.method, "POST");
      return jsonResponse({
        startAt: 0,
        maxResults: 10,
        total: 1,
        issues: [issueResponse()]
      });
    }
    if (url.toString().includes("/issue/ENG-42")) {
      return jsonResponse(issueResponse());
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const search = parseToolJson(await callTool("jira_search", { query: "write" }));
  const issue = parseToolJson(await callTool("jira_get_issue", { issueKey: "ENG-42" }));

  assert.equal(search.issues[0].key, "ENG-42");
  assert.equal(issue.key, "ENG-42");
  assert.equal(issue.description, "Description");
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

function emptyResponse() {
  return new Response(null, {
    status: 204,
    statusText: "No Content"
  });
}

function issueResponse() {
  return {
    id: "10001",
    key: "ENG-42",
    fields: {
      summary: "Existing issue",
      issuetype: { name: "Task" },
      status: {
        name: "In Progress",
        statusCategory: { name: "In Progress" }
      },
      priority: { name: "High" },
      project: { key: "ENG", name: "Engineering" },
      assignee: { name: "kimny", displayName: "Kim Ny", active: true },
      reporter: { name: "reporter", displayName: "Reporter", active: true },
      created: "2026-06-26T00:00:00.000+0000",
      updated: "2026-06-26T12:00:00.000+0000",
      resolution: null,
      labels: ["mcp"],
      components: [{ id: "1", name: "API" }],
      fixVersions: [{ id: "2", name: "2026 Jun" }],
      versions: [],
      description: "Description"
    }
  };
}
