# Open waits and their sources

An open wait is work that an agent stopped because it waits for something outside its turn. The
agent ends its turn; it does not poll. When the event comes, the host starts the agent's next turn
with the event and the request that the wait continues. The user does not send a message.

There is one concept: a wait. Each wait has a **source**, which is what wakes it. There is no
separate "watch" object.

| Source | Opened by | Wakes on | Ends on | Status |
| --- | --- | --- | --- | --- |
| `routine` | The agent, with `openbot.await_event` | A routine run of the agent, or a local script event that names the wait | The agent's `close_wait`, or the user's cancel | Shipped |
| `mcp-sign-in` | The host, for a Sign in card from `save_mcp_server` or `test_mcp_server` | The end of a sign-in to the server's address: success, failure or cancel | A sign-in that connects | This stack, layer 1 |
| `webhook` | The agent, with `await_event` and `webhook: { routineId, eventType?, filters? }` | A webhook event of that routine that matches | `close_wait` or cancel | This stack, layer 2 |
| `github-pull-request` | The agent, with `await_event` and a pull request | Checks failed or passed, a new comment by someone else, a conflict | Merged or closed; 8 failed reads in a row | This stack, layer 3 |
| T3 Code thread | — | — | — | Design only; see below |

## Which flows need a wait

Only a flow that ends the agent's turn needs a wait. These flows block the tool call in the live
turn, and the user's answer is the tool result, so the agent continues in the same turn:
approvals, `ask_user`, `ask_ui`, `request_api_key`, `request_takeover` and `submit_secret`
(`AttentionRegistry`). The end of the turn cancels or expires them.

The MCP sign-in is different. `save_mcp_server` and `test_mcp_server` return `needs_sign_in` at
once and put a Sign in card in the chat. In the agent's own chat, the card also opens a
`mcp-sign-in` wait, and the tool result tells the agent that OpenBot starts its next turn. A card
from a tool search opens no wait: the user did not ask for that server. A channel, messaging or
task thread opens no wait either, and the result keeps the old text ("test again when the user says
it is done").

## Data model

`agent_waits` (`src/backend/agent-waits/agent-wait-schema.ts`, columns added by migration 48):

| Column | Use |
| --- | --- |
| `wait_id`, `agent_id`, `note`, `created_at` | As before. |
| `request_delivery_id`, `request_text` | The request the wait continues, copied when it opens. The wake repeats it. |
| `routine_id` | A `routine` wait that only this routine wakes. |
| `woken_at`, `wake_delivery_id` | The last wake. A wake is not repeated while that turn is queued or runs. |
| `source` | What wakes the wait. `routine` for every older row. No CHECK constraint, so a new source needs no migration. |
| `target` | The key the source finds its waits by: an MCP address, `github:owner/repo#12`. Null for `routine`. Indexed with `source`. |
| `conditions_json` | What the wait waits for, set when it opens. Always has `subject`, the text the UI shows. |
| `cursor_json` | What the agent was last told, for a poll source: a fingerprint, time marks, ids. |
| `failures` | Reads that failed in a row, for a poll source. |

A source that a newer build wrote reads as a `routine` wait in an older build. It is listed and can
be closed, and only a routine run wakes it there.

`AgentWait` (`packages/contracts/src/ipc-agent-waits.ts`) adds `source` and `subject`. Waits are
local only (`agent:list-waits`, `agent:cancel-wait`); no Team API protocol carries them.

## How a wake reaches the agent

`AgentWaits.wake(event)` is the one entry point for every source except `routine`:

```ts
interface AgentWaitEvent {
  source: "mcp-sign-in" | …;
  target: string;
  line: string;   // the status.agent.waitWoke* sentence that the chat shows
  text: string;   // what happened, for the agent; text from outside is framed as data
  final: boolean; // ends the waits of the target
}
```

For each open wait of the target whose last wake is not pending, it queues one turn in the agent's
own chat, through the same path as a message (`AgentService.#sendUserMessage`): it steers a running
turn in the "steer" busy-message mode, or waits in the queue. Then it marks the wait woken, or
closes it on a final event. A wake that fails, such as for an agent that is gone, closes the wait
and is reported as `agent_wait_wake_failed`.

The queued mailbox message has a `wake` marker (`StoredMessage.wake`: wait id, source, prompt):

- Its text is the line, so the queue row and the chat read as a host note.
- The conversation shows it as a system line, `itemType` `wait-wake:<source>`
  (`waitWakeItemType`), not as a message from the user. It does not make the chat unread.
- The agent reads the prompt: an "OpenBot note, not a message from the user" with the event, the
  wait id, the note, the request, and whether the wait stays open.

The sender stays `user`. A new sender kind is not possible: the released Team API v1–v9 queue codecs
accept only the user, agent and routine senders, and drop or refuse anything else. An older build
that reads the database shows the line as a plain message.

A `routine` wait keeps its old path: the routine run is the delivery, and `wokenWaitsPromptText`
adds the woken waits to its input.

## UI

- **Open waits card** (`packages/ui/src/features/conversation/OpenWaits.tsx`, above the composer):
  one row for each wait. A host-opened wait shows its source, such as "Sign-in to Linear", in place
  of the note. The state is Waiting, Continuing the request, or Woke, not closed. The menu shows the
  request and cancels the wait.
- **Chat line**: each wake shows "The sign-in to Linear is done. The agent continues." as a marker
  (`ChatActionMarker`, kind `wait-wake`).
- **Sign in card**: Continue is hidden after the card's wake line. It stays when no wait opened, such
  as in a channel thread or at the limit of open waits.
- Not shown: the web client and mobile have no open-waits card today. Mobile does not draw system
  markers, so it does not show the wake line.

## Limits

- 20 open waits for each agent, for all sources together (`INPUT_LIMITS.agentWaits`). A Sign in
  card at the limit opens no wait, and the result tells the agent to wait for the user.
- One wait for each agent, source and target: a second card for the same server reuses it.
- The wake text is bounded and redacted. The MCP sign-in reason is redacted with
  `McpGateway.redact` and cut at 1,000 characters.
- Outside text in a wake is data, not instructions, framed as the local-script event is framed.

## How a wait ends

| Cause | Effect |
| --- | --- |
| A final event of its source | The wake closes the wait. |
| The agent's `close_wait` | The wait closes. |
| The user's cancel in the open-waits card | The wait closes. A queued wake turn still runs. |
| A wake that fails | The wait closes, and the error is reported. |
| The agent is deleted | `hardDeleteAgent` removes its rows. |
| A restart | Nothing: the waits are rows in `openbot.db`. |

## Sources from outside OpenBot

### Webhook

A webhook routine accepts only OpenBot's own signed body, `{ type, occurredAt?, data? }` with the
`X-OpenBot-*` headers ([webhooks](../webhooks.md)). GitHub, Linear and Vercel cannot send to it
directly: a small relay, such as a GitHub Action or a T3 Code webhook automation, reshapes and signs
the event. A webhook wait names the routine and, as the routine editor does, an event type and JSON
Pointer filters on `data`; `target` is the routine id and `conditions_json` holds the type and the
filters. `RoutineScheduler.receiveWebhook` passes the event to `AgentWaits.wakeForRun`, which wakes
the webhook waits of that routine that `webhookMismatch` (`src/backend/webhook-trigger.ts`) accepts.
The routine run carries the event and the woken waits, as a routine run does. An event that does
not match still runs the routine, without the wait. A run that a restart resumes has no event, so it
wakes no webhook wait.

### GitHub pull request

GitHub does not push to OpenBot: the OpenBot GitHub App has webhooks off. The host sweeps instead,
as T3 Code's pull request watch does (`PullRequestWatchReactor.ts`), in
`src/backend/agent-waits/pull-request-waits.ts`:

- `await_event` with `pullRequest: { repository, number }` opens the wait. `target` is
  `github:owner/repo#12`; it needs the GitHub connection (Server settings, Connectors), not a routine.
- Every 2 minutes (`PULL_REQUEST_SWEEP_MS`), one GraphQL read for each pull request, shared by its
  waits, with the connection's user token (`GitHubConnectorSource.accessToken`). The token goes in
  the request header only. The agent never polls.
- A fingerprint of state, mergeability, head commit, checks and remark ids skips a wait whose pull
  request did not change. A wait whose last wake is still queued or running is read at a later sweep.
- News: a newly failed check, all checks passed, a merge conflict, and a comment or review by an
  account other than the token's, after the wait opened. New commits are not news by themselves
  (they are often the agent's own push); they reset the checks. The token is the user's, so the
  user's own comments do not wake the agent. The first read reports checks that had already failed
  or passed, so an agent that waits for checks that are done wakes once. At most 10 items, with
  200-character excerpts, framed as data from GitHub.
- The cursor in `cursor_json` holds what the agent was last told; it moves only after a complete
  read, so one piece of news wakes the agent once. A rerun that passes drops a failed check, so a
  second failure is news again.
- Merged or closed is final. 8 failed reads in a row (`failures`) end the wait with a last wake that
  gives the error. A rate limit (429, `x-ratelimit-remaining: 0`, `retry-after`, or a `RATE_LIMITED`
  GraphQL error) and no answer within 30 seconds pause the sweep and are not failures. With GitHub
  disconnected, each read fails, so the wait ends after 8 sweeps. `AgentService.stop` interrupts a
  sweep that runs.

Not done: one batched query for many pull requests, and a cheap fingerprint query before the full
read, as T3 Code does. One read costs about one GraphQL point, 30 an hour for each pull request.

### T3 Code thread (design only)

T3 Code has no outbound "turn finished" hook, and its MCP server has no subscriptions. A source
would read T3's MCP server over HTTP with T3's OAuth sign-in (the user adds T3 Code as an MCP
server once), with `t3_thread_list` for one project, and a fingerprint of `status`,
`latestRunId`, `updatedAt` and `itemCount`. "Finished" means the latest run reached a terminal
status. `t3_thread_read` is not read-only (it can acknowledge a child's completion), so the sweep
must not use it. OpenBot's backend MCP client lists tools only today; this source needs a tool call
with the stored OAuth token.
