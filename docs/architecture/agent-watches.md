# Agent watches

A watch lets an agent end its turn and continue when an event that it waits for occurs. The user
does not send a message, and the agent does not poll. The host detects the event and starts the
agent's next turn with the outcome.

Status: the first source, the end of an MCP sign-in, is in `src/backend/agent-watches/`. The other
sources in this document are follow-ups.

## Terms

| Term | Meaning |
| --- | --- |
| Watch | One agent waits for events of one target from one source. |
| Source | The adapter that detects events: `mcp-sign-in` today. |
| Target | What the source names an event by: an MCP server address, a pull request, a T3 thread. |
| Wake condition | The events that start a turn: checks finished, a new comment, a failed sign-in. |
| End condition | The event that also closes the watch: a sign-in that connects, a merged pull request. |
| Wake | The turn that an event starts, with a text that states the outcome and the next action. |

## Which flows need a watch

Only a flow that ends the agent's turn needs a watch. These flows block the tool call in the live
turn, and the user's answer is the tool result, so the agent continues in the same turn:
approvals, `ask_user`, `ask_ui`, `request_api_key`, `request_takeover` and `submit_secret`
(`AttentionRegistry`). The end of the turn cancels or expires them.

The MCP sign-in is different. `save_mcp_server` and `test_mcp_server` return `needs_sign_in` at
once, put a Sign in card in the chat and tell the agent to end its turn. Before this change, only
the card's Continue button or a new user message started the next turn.

## Data model

The first slice keeps watches in memory, in `AgentWatches`:

```ts
interface AgentWatch {
  agentId: string;
  source: "mcp-sign-in";
  target: string; // the normalized server address, as the sign-ins key it
}
```

There is one watch for each agent, source and target, so a repeated card replaces the watch. Only
a card from `save_mcp_server` or `test_mcp_server` in the agent's own chat opens one: a card from a
tool search was not asked for, and a channel, messaging or task thread keeps the old guidance. A
restart forgets the watches; the card's Continue button stays for that case.

A source with outside events needs a watch that survives a restart. That watch is an open wait
(`agent_waits`) with more columns:

| Column | Use |
| --- | --- |
| `source` | The adapter. Null for a wait that only a routine run wakes, as today. |
| `target` | The target key, such as `github:owner/repo#12`. Indexed with `source`. |
| `conditions_json` | The wake conditions that the agent chose, checked by the adapter. |
| `cursor_json` | What the agent was last told: a fingerprint, a time mark, the ids it saw. |
| `failures` | Reads that failed in a row. |

The migration that adds these columns is irreversible. It must keep every row of every released
schema, with fixtures, as [src/backend/AGENTS.md](../../src/backend/AGENTS.md) requires.

## How a watch maps onto a wait

A persisted watch is an open wait, so it gets what a wait already has:

- The user sees it in the chat and can cancel it. `list_waits` and `close_wait` show and close it.
- It counts toward the limit of 20 open waits of an agent (`INPUT_LIMITS.agentWaits`).
- It keeps a copy of the request, and the wake repeats the request and the note
  (`wokenWaitsPromptText`), so the agent can continue after its context was compacted.

Today only a routine run wakes a wait, and `await_event` refuses an agent with no routine. A watch
wake needs a delivery that is not a routine run. The first slice sends a message in the agent's own
chat through `AgentService.sendMessage`, the same path as the card's Continue button. Its text starts
with `OpenBot note:`. A persisted watch should get its own sender kind, so the chat shows the wake as
an event and not as the user's message. That changes the mailbox, its projection and the queue
contract, so it is not in the first slice.

A wake that arrives while the agent works queues behind the turn, or steers it in the "steer"
busy-message mode, as every message does.

## Source adapters

Each adapter owns its detection. The agent never polls.

```ts
interface WatchSource {
  source: string;
  /** Checks the target and the conditions when the agent opens the watch. */
  validate(target: string, conditions: unknown): WatchTarget;
  /** Push: called with each event. Poll: called by the sweep with the watches of one target. */
  deliver(event: unknown): WatchEvent[];
}

interface WatchEvent {
  target: string;
  text: string;   // the outcome, bounded and redacted
  final: boolean; // true ends the watches of the target
}
```

1. **OpenBot events (push).** The source calls `AgentWatches.notify` when the event occurs.
   `mcp-sign-in` is the first one. `AgentService.signInMcpServer` notifies on every exit:
   - A sign-in that connects: the agent calls `test_mcp_server` and reports the tools. Final.
   - A sign-in that fails or that the user cancels: the agent gets the reason and tells the user.
     Not final: the user can sign in again on the same card.
2. **Inbound webhooks (push).** GitHub, Linear, Vercel and T3 Code webhook automations already reach
   the agent through webhook routines (`create_webhook_routine`, [webhooks](../webhooks.md)). The
   adapter reads the target from the payload, such as the repository and the pull request number,
   and wakes only the watches of that target. The routine run carries the payload, as it does now.
3. **Outside systems with no push (server-side sweep).** For example a T3 Code thread that finishes:
   the T3 MCP server has no resource subscription and no outbound hook. One sweep for each source,
   in the host, never in the agent. It follows T3 Code's pull request watch
   (`PullRequestWatchReactor.ts`):
   - One read for each target, shared by every watch of the target.
   - A cheap fingerprint first (state, update time, check state); a full read only when it changes,
     when something is in flight, or after a forced interval.
   - The cursor moves only after a complete read, so an event wakes the agent one time.
   - Rate limits pause the sweep and do not count as failures.

## Limits

- 20 open waits for each agent. A persisted watch counts as one. The first slice does not count,
  because it holds at most one watch for each agent and server.
- One wake text is bounded: at most 10 items, short excerpts, secrets redacted. The MCP sign-in
  reason is redacted with `McpGateway.redact` and cut at 1,000 characters.
- Outside text in a wake is data, not instructions. Frame it as the local-script event is framed.
- A watch that wakes the agent many times with no final event stops after a limit, as T3 Code stops
  after 10 comment-only wakes in a row.

## How a watch ends

| Cause | First slice | Persisted watch |
| --- | --- | --- |
| Final event | A sign-in that connects. | Merged or closed pull request, finished thread. |
| Agent | — | `close_wait`, or an `unwatch` tool. |
| User | — | Cancel in the chat. |
| Reads fail | — | 8 failed reads in a row; the last wake says why. |
| Wake limit | — | Too many non-final wakes in a row. |
| Agent removed | The wake fails, is reported (`agent_watch_wake_failed`) and ends the watch. | The wait rows of the agent are deleted. |
| Restart | Forgets every watch. | Keeps the watch; the sweep reads it again. |

## Why the first slice is in memory

A persisted watch needs a migration and a new sender kind. Both are large and irreversible for one
source whose card is already persisted in the chat. The in-memory registry is about the same size
as a direct fix, and the MCP sign-in is its first user. The persisted model above is the plan for
the sources that need it.

## Follow-ups

1. Persist watches on `agent_waits` with a `watch` sender kind for the wake.
2. Webhook source: match webhook routine runs to watches by target.
3. GitHub pull request source: webhook first, sweep when no webhook is set.
4. T3 Code thread source: sweep with a fingerprint of the thread state.
