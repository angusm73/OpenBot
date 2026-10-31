// Checks that the end of an MCP sign-in starts a turn of the agent whose Sign in card waits for it,
// so the user does not have to tell the agent. Runs the real agent service on a temporary profile
// with a fake Codex app-server and a local MCP server that refuses requests without a sign-in.
// The current message names one OpenBot tool call in `<<CALL{...}CALL>>`; every other turn answers.
// Checks:
//   1. test_mcp_server posts the Sign in card and tells the agent that OpenBot wakes it.
//   2. A sign-in that does not finish starts a turn with the reason, and the watch stays.
//   3. A sign-in that connects starts a turn that tells the agent to test the server, and ends the watch.
//   4. A sign-in that no card waits for starts no turn.
// Not checked: the browser sign-in itself (this profile has no OAuth store, as in
// agent-mcp-tools-e2e.ts; a cancel ends the same way, with its reason), and the card's Continue
// button in the renderer.
// No provider, account or network is used. `bun run test:mcp-sign-in-wake`.
// Writes .openbot-build/mcp-sign-in-wake-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS, mcpSignInItemType } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mcp-sign-in-wake-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-mcp-sign-in-wake-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");
const NOTE = "OpenBot note: the sign-in to the MCP server";

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + process.pid + "-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      log({ method: "turn", turnId, text });
      const named = /<<CALL([\\s\\S]*?)CALL>>/.exec(text.split("--- current message ---").at(-1));
      if (!named) return setTimeout(() => finish(params.threadId, turnId), 5);
      const call = JSON.parse(named[1]);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId });
      return write({ id, method: "item/tool/call", params: { threadId: params.threadId, turnId, callId: "call-" + id, namespace: "openbot", tool: call.tool, arguments: call.arguments } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ method: "toolResult", result: message.result });
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const report: { checks: { name: string; passed: boolean; detail?: unknown }[]; passed: boolean; error?: string } = {
  checks: [],
  passed: false,
};

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** Waits for a state of the service or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

interface LoggedEntry {
  method: "turn" | "toolResult";
  text?: string;
  result?: { contentItems?: { text?: string }[] };
}

function logged(): LoggedEntry[] {
  try {
    return readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): LoggedEntry => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The current message of each turn. A new provider session also gets the earlier chat in front of it. */
const turnTexts = () =>
  logged().flatMap((entry) =>
    entry.method === "turn" ? [(entry.text ?? "").split("--- current message ---").at(-1) ?? ""] : [],
  );

async function check(name: string, run: () => Promise<unknown>) {
  const detail = await run();
  report.checks.push({ name, passed: true, detail });
}

/** A local MCP server that answers 401 with a sign-in challenge until `accept` is set. */
let accept = false;
const mcp: Server = createServer((request, response) => {
  void (async () => {
    if (!accept) {
      response.writeHead(401, { "www-authenticate": 'Bearer realm="e2e"', "content-type": "application/json" });
      return response.end('{"error":"unauthorized"}');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message: { id?: number | string; method?: string } = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : {};
    if (message.id === undefined) return response.writeHead(202).end();
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "e2e", version: "1" },
          }
        : { tools: [{ name: "search", description: "search", inputSchema: { type: "object", properties: {} } }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch((error: unknown) => response.writeHead(500).end(String(error)));
});
await new Promise<void>((done) => mcp.listen(0, "127.0.0.1", done));
const address = mcp.address();
assert.ok(address !== null && typeof address === "object");
const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
});

const ended = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";
const idle = (agentId: string) => service.listQueue(agentId).deliveries.every((delivery) => ended(delivery.status));
const call = (tool: string, args: Record<string, string>) => `<<CALL${JSON.stringify({ tool, arguments: args })}CALL>>`;

try {
  await runCauseEffect(service.initialize());
  const saved = await runCauseEffect(
    service.saveMcpServer({
      config: {
        id: "",
        name: "Notes",
        transport: "http",
        enabled: true,
        command: "",
        args: [],
        env: [],
        envPassthrough: [],
        workingDirectory: "",
        url: mcpUrl,
        headers: [],
      },
    }),
  );
  const server = saved.find((config) => config.name === "Notes");
  assert.ok(server, "The server is saved.");
  const agent = await runCauseEffect(
    service.createAgent({
      name: "Connector",
      description: "Adds MCP servers.",
      avatarSeed: "connector",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("the first turn", () => idle(agent.id));
  const signIn = () => runCauseEffect(service.signInMcpServer({ config: server }));

  await check("test_mcp_server posts the Sign in card and says that OpenBot wakes the agent", async () => {
    const receipt = await runCauseEffect(
      service.sendMessage({ agentId: agent.id, text: `Test Notes. ${call("test_mcp_server", { name: "Notes" })}` }),
    );
    await waitFor("the test turn", () => idle(agent.id) && receipt.deliveries.length > 0);
    const result = logged().findLast((entry) => entry.method === "toolResult")?.result?.contentItems?.[0]?.text ?? "";
    assert.ok(result.includes('"needs_sign_in"'), result);
    assert.ok(result.includes("OpenBot starts your next turn with the outcome"), result);
    const threadId = store.list().find((entry) => entry.id === agent.id)?.threadId ?? null;
    const card = database
      .readConversation(agent.id, threadId)
      .messages.find((message) => message.itemType === mcpSignInItemType({ mcpServerId: server.id }));
    assert.ok(card, "The Sign in card is in the chat.");
    return { result: JSON.parse(result) };
  });

  await check("a sign-in that does not finish starts a turn with the reason", async () => {
    const before = turnTexts().length;
    const outcome = await signIn();
    assert.notEqual(outcome.error, null, "The server still refuses.");
    const text = await waitFor("the wake turn", () =>
      turnTexts()
        .slice(before)
        .find((turn) => turn.includes(NOTE)),
    );
    assert.ok(text.includes('"Notes" did not finish.'), text);
    assert.ok(text.includes(`Reason, as the sign-in reported it: ${outcome.error}`), text);
    await waitFor("the wake turn to end", () => idle(agent.id));
    assert.equal(turnTexts().length - before, 1, "One turn runs.");
    return { reason: outcome.error };
  });

  await check("a sign-in that connects starts a turn that tests the server, and ends the watch", async () => {
    accept = true;
    const before = turnTexts().length;
    const outcome = await signIn();
    assert.equal(outcome.error, null, "The server answers.");
    const text = await waitFor("the wake turn", () =>
      turnTexts()
        .slice(before)
        .find((turn) => turn.includes(NOTE)),
    );
    assert.ok(text.includes('"Notes" is done. Call openbot.test_mcp_server with name "Notes"'), text);
    await waitFor("the wake turn to end", () => idle(agent.id));
    assert.equal(turnTexts().length - before, 1, "One turn runs.");
    return { toolCount: outcome.toolCount };
  });

  await check("a sign-in that no card waits for starts no turn", async () => {
    const before = turnTexts().length;
    await signIn();
    // A wake would already be in the queue: the sign-in answers after it queues its wakes.
    await runCauseEffect(service.sendMessage({ agentId: agent.id, text: "Next request." }));
    await waitFor("the next request", () =>
      turnTexts()
        .slice(before)
        .some((turn) => turn.includes("Next request.")),
    );
    await waitFor("the next request to end", () => idle(agent.id));
    assert.deepEqual(
      turnTexts()
        .slice(before)
        .map((turn) => turn.includes(NOTE)),
      [false],
      "Only the next request runs.",
    );
    return { turns: 1 };
  });

  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  await new Promise<void>((done) => mcp.close(() => done()));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  for (const entry of report.checks) process.stdout.write(`PASS ${entry.name}\n`);
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${join(OUT, "report.json")}\n`);
  if (report.error) process.stdout.write(`${report.error}\n`);
}
