import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * What can wake a wait. `routine`: a routine run of the agent, or a script event that names the wait.
 * `mcp-sign-in`: the end of the sign-in that a Sign in card in the agent's chat asks for.
 * `webhook`: a run of one webhook routine whose event matches the wait's event type and filters.
 */
export const AGENT_WAIT_SOURCES = ["routine", "mcp-sign-in", "webhook"] as const;
export type AgentWaitSource = (typeof AGENT_WAIT_SOURCES)[number];

/**
 * Work an agent stopped before it was done, because it waits for something outside the turn. The
 * agent opens the wait with `openbot.await_event`, lists it with `openbot.list_waits` and closes it
 * with `openbot.close_wait`; another local agent can list and close it with `agentId`. The user
 * can cancel it. Its source wakes it, and the agent continues the request in the turn that the
 * wake starts. The host opens a wait too, such as for a Sign in card.
 */
export interface AgentWait {
  id: string;
  agentId: string;
  /** What the agent waits for, in its own words. */
  note: string;
  source: AgentWaitSource;
  /** What the source watches, as the user reads it, such as an MCP server name. Null for a routine wait. */
  subject: string | null;
  /** The message the wait serves. Its id is the transcript message id. */
  requestMessageId: string;
  requestText: string;
  /** The one routine whose runs wake the wait. Null: every routine run of the agent wakes it. */
  routineId: string | null;
  createdAt: string;
  /** The last wake. The wait stays open until the agent closes it, or until an event of its source ends it. */
  wokenAt: string | null;
  wakeDeliveryId: string | null;
}

export interface AgentWaitsSnapshot {
  agentId: string;
  waits: AgentWait[];
}

export interface CancelAgentWaitInput {
  agentId: string;
  waitId: string;
}

function isAgentWait(value: unknown): value is AgentWait {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.agentId) &&
    isBoundedString(value.note, INPUT_LIMITS.agentWaitNote) &&
    isOneOf(AGENT_WAIT_SOURCES, value.source) &&
    (value.subject === null || isBoundedString(value.subject, INPUT_LIMITS.agentWaitNote)) &&
    isIdentifier(value.requestMessageId) &&
    isBoundedString(value.requestText, INPUT_LIMITS.messageText) &&
    (value.routineId === null || isIdentifier(value.routineId)) &&
    isBoundedString(value.createdAt, 160) &&
    (value.wokenAt === null || isBoundedString(value.wokenAt, 160)) &&
    (value.wakeDeliveryId === null || isIdentifier(value.wakeDeliveryId))
  );
}

export function isAgentWaitsSnapshot(value: unknown): value is AgentWaitsSnapshot {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    Array.isArray(value.waits) &&
    value.waits.length <= INPUT_LIMITS.agentWaits &&
    value.waits.every(isAgentWait)
  );
}
