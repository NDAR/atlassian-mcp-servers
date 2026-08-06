#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const codexDir = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const configPath = path.join(codexDir, "config.toml");
const skillSource = path.join(repoRoot, "skills", "nda-atlassian");
const skillTarget = path.join(codexDir, "skills", "nda-atlassian");

const confluenceServer = path.join(repoRoot, "confluence-mcp-server", "src", "server.mjs");
const jiraServer = path.join(repoRoot, "jira-mcp-server", "src", "server.mjs");
const DEFAULT_CONFLUENCE_BLOCKED_SPACES = "SEC";
const DEFAULT_JIRA_BLOCKED_PROJECTS = "";
const DEFAULT_CONFLUENCE_BLOCKED_LABELS = "sensitive,internal";
const DEFAULT_CONFLUENCE_BLOCKED_DESCENDANT_LABELS = "restricted";
const DEFAULT_JIRA_BLOCKED_LABELS = "sensitive,internal";

main().catch((error) => {
  console.error(`\nInstall failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  console.log("NDAR Atlassian MCP installer for Codex Desktop\n");

  assertNodeVersion();
  assertFile(confluenceServer, "Confluence MCP server");
  assertFile(jiraServer, "Jira MCP server");
  assertFile(path.join(skillSource, "SKILL.md"), "Codex skill");

  fs.mkdirSync(codexDir, { recursive: true });

  const existingConfig = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";

  const existingConfluencePat = readTomlValue(existingConfig, "CONFLUENCE_PAT");
  const existingJiraPat = readTomlValue(existingConfig, "JIRA_PAT");
  const existingConfluenceBaseUrl = readTomlValue(existingConfig, "CONFLUENCE_BASE_URL");
  const existingJiraBaseUrl = readTomlValue(existingConfig, "JIRA_BASE_URL");
  const existingConfluenceBlockedSpaces = readTomlValue(existingConfig, "CONFLUENCE_BLOCKED_SPACES");
  const existingJiraBlockedProjects = readTomlValue(existingConfig, "JIRA_BLOCKED_PROJECTS");
  const existingConfluenceBlockedLabels = readTomlValue(existingConfig, "CONFLUENCE_BLOCKED_LABELS");
  const existingConfluenceBlockedDescendantLabels = readTomlValue(
    existingConfig,
    "CONFLUENCE_BLOCKED_DESCENDANT_LABELS"
  );
  const existingJiraBlockedLabels = readTomlValue(existingConfig, "JIRA_BLOCKED_LABELS");

  console.log("You need your Confluence URL, Jira URL, and one personal access token for each service.");
  console.log("The tokens are saved only in your local Codex config file.\n");

  const confluenceBaseUrl = process.env.CONFLUENCE_BASE_URL || await askText("Confluence URL", existingConfluenceBaseUrl);
  const jiraBaseUrl = process.env.JIRA_BASE_URL || await askText("Jira URL", existingJiraBaseUrl);
  const confluencePat = process.env.CONFLUENCE_PAT || await askToken("Confluence PAT", existingConfluencePat);
  const jiraPat = process.env.JIRA_PAT || await askToken("Jira PAT", existingJiraPat);
  const confluenceBlockedSpaces =
    process.env.CONFLUENCE_BLOCKED_SPACES ||
    existingConfluenceBlockedSpaces ||
    DEFAULT_CONFLUENCE_BLOCKED_SPACES;
  const jiraBlockedProjects =
    process.env.JIRA_BLOCKED_PROJECTS ??
    existingJiraBlockedProjects ??
    DEFAULT_JIRA_BLOCKED_PROJECTS;
  const confluenceBlockedLabels =
    process.env.CONFLUENCE_BLOCKED_LABELS ||
    existingConfluenceBlockedLabels ||
    DEFAULT_CONFLUENCE_BLOCKED_LABELS;
  const confluenceBlockedDescendantLabels =
    process.env.CONFLUENCE_BLOCKED_DESCENDANT_LABELS ||
    existingConfluenceBlockedDescendantLabels ||
    DEFAULT_CONFLUENCE_BLOCKED_DESCENDANT_LABELS;
  const jiraBlockedLabels =
    process.env.JIRA_BLOCKED_LABELS ||
    existingJiraBlockedLabels ||
    DEFAULT_JIRA_BLOCKED_LABELS;

  if (!confluenceBaseUrl) {
    throw new Error("Confluence URL is required");
  }
  if (!jiraBaseUrl) {
    throw new Error("Jira URL is required");
  }
  if (!confluencePat) {
    throw new Error("Confluence PAT is required");
  }
  if (!jiraPat) {
    throw new Error("Jira PAT is required");
  }

  const nextConfig = buildConfig(existingConfig, {
    nodePath: toTomlPath(process.execPath),
    confluenceServer: toTomlPath(confluenceServer),
    jiraServer: toTomlPath(jiraServer),
    confluenceBaseUrl: normalizeBaseUrl(confluenceBaseUrl),
    jiraBaseUrl: normalizeBaseUrl(jiraBaseUrl),
    confluencePat,
    jiraPat,
    confluenceBlockedSpaces,
    jiraBlockedProjects,
    confluenceBlockedLabels,
    confluenceBlockedDescendantLabels,
    jiraBlockedLabels
  });

  if (fs.existsSync(configPath)) {
    const backupPath = `${configPath}.backup-${timestamp()}`;
    fs.copyFileSync(configPath, backupPath);
    console.log(`Created backup: ${backupPath}`);
  }

  fs.writeFileSync(configPath, nextConfig, "utf8");
  installSkill();

  console.log("\nDone.");
  console.log(`Confluence blocked spaces: ${confluenceBlockedSpaces}`);
  console.log(`Jira blocked projects: ${jiraBlockedProjects || "(none)"}`);
  console.log("\nNext steps:");
  console.log("1. Quit and reopen Codex Desktop.");
  console.log("2. Ask Codex: Search Confluence for NDA data dictionary");
  console.log("3. Optional check from Terminal: codex mcp list");
}

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node.js 18 or newer is required. Current version: ${process.version}`);
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}`);
  }
}

async function askToken(label, existingValue) {
  const suffix = existingValue ? " (press Enter to keep existing)" : "";
  const value = await askHidden(`${label}${suffix}: `);
  return value.trim() || existingValue || "";
}

async function askText(label, existingValue) {
  const suffix = existingValue ? ` [${existingValue}]` : "";
  const value = await askVisible(`${label}${suffix}: `);
  return value.trim() || existingValue || "";
}

function askVisible(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function writeMasked(output) {
      if (output === prompt) {
        originalWrite.call(rl, output);
        return;
      }
      if (output.includes("\n") || output.includes("\r")) {
        originalWrite.call(rl, output.replace(/[^\r\n]/g, ""));
        return;
      }
      originalWrite.call(rl, "*");
    };

    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function buildConfig(existingConfig, values) {
  const cleaned = removeSections(existingConfig, [
    "mcp_servers.confluence",
    "mcp_servers.confluence.env",
    "mcp_servers.jira",
    "mcp_servers.jira.env"
  ]).trimEnd();

  const block = `

[mcp_servers.confluence]
enabled = true
command = "${escapeToml(values.nodePath)}"
args = ["--use-system-ca", "${escapeToml(values.confluenceServer)}"]

[mcp_servers.confluence.env]
CONFLUENCE_AUTH_MODE = "bearer"
CONFLUENCE_BASE_URL = "${escapeToml(values.confluenceBaseUrl)}"
CONFLUENCE_API_PATH = "/rest/api"
CONFLUENCE_PAT = "${escapeToml(values.confluencePat)}"
# Guardrails. Edit these comma-separated lists for testing or rollout.
CONFLUENCE_BLOCKED_SPACES = "${escapeToml(values.confluenceBlockedSpaces)}"
CONFLUENCE_BLOCKED_LABELS = "${escapeToml(values.confluenceBlockedLabels)}"
CONFLUENCE_BLOCKED_DESCENDANT_LABELS = "${escapeToml(values.confluenceBlockedDescendantLabels)}"

[mcp_servers.jira]
enabled = true
command = "${escapeToml(values.nodePath)}"
args = ["--use-system-ca", "${escapeToml(values.jiraServer)}"]

[mcp_servers.jira.env]
JIRA_AUTH_MODE = "bearer"
JIRA_BASE_URL = "${escapeToml(values.jiraBaseUrl)}"
JIRA_API_PATH = "/rest/api/2"
JIRA_PAT = "${escapeToml(values.jiraPat)}"
# Guardrails. Edit these comma-separated lists for testing or rollout.
JIRA_BLOCKED_PROJECTS = "${escapeToml(values.jiraBlockedProjects)}"
JIRA_BLOCKED_LABELS = "${escapeToml(values.jiraBlockedLabels)}"
`;

  return `${cleaned}${block}`;
}

function removeSections(toml, sectionNames) {
  const remove = new Set(sectionNames);
  const lines = toml.split(/\r?\n/);
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      skipping = remove.has(sectionMatch[1]);
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n");
}

function installSkill() {
  fs.mkdirSync(path.dirname(skillTarget), { recursive: true });

  if (fs.existsSync(skillTarget)) {
    const backupPath = `${skillTarget}.backup-${timestamp()}`;
    fs.cpSync(skillTarget, backupPath, { recursive: true });
    fs.rmSync(skillTarget, { recursive: true, force: true });
    console.log(`Created skill backup: ${backupPath}`);
  }

  fs.cpSync(skillSource, skillTarget, { recursive: true });
  console.log(`Installed Codex skill: ${skillTarget}`);
}

function readTomlValue(toml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = toml.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*"((?:\\\\.|[^"])*)"`, "m"));
  return match ? unescapeToml(match[1]) : "";
}

function toTomlPath(filePath) {
  return path.resolve(filePath).split(path.sep).join("/");
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function escapeToml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeToml(value) {
  return String(value).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}
