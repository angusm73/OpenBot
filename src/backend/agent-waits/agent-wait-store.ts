/**
 * The open waits of every agent. Rows are written directly, not through `database.dispatch`: a wait
 * holds a copy of the user's request, and the event log is never deleted from. A closed or cancelled
 * wait is deleted. It owns no events: the runtime says when something changed.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { AGENT_WAIT_SOURCES, type AgentWait, type AgentWaitSource } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

/** A refusal the agent reads: the text is already a sentence for it. */
export class AgentWaitError extends Error {}

/** The agent already has the most open waits it may have. */
export class AgentWaitLimitError extends AgentWaitError {}

export interface AgentWaitStoreOptions {
  database: OpenBotDatabase;
  createId?: () => string;
  now?: () => Date;
}

export interface OpenAgentWaitInput {
  agentId: string;
  requestMessageId: string;
  requestText: string;
  note: string;
  routineId: string | null;
  /** Absent for a routine wait. `conditions` is what the source matches its events against. */
  source?: { source: Exclude<AgentWaitSource, "routine">; target: string; subject: string; conditions?: DynamicRecord };
}

export class AgentWaitStore {
  readonly #database: OpenBotDatabase;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(options: AgentWaitStoreOptions) {
    this.#database = options.database;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  list(agentId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare("SELECT * FROM agent_waits WHERE agent_id = ? ORDER BY created_at, wait_id")
        .all(agentId),
    ).map(toWait);
  }

  get(agentId: string, waitId: string): AgentWait | null {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT * FROM agent_waits WHERE agent_id = ? AND wait_id = ?")
        .get(agentId, waitId),
    );
    return row ? toWait(row) : null;
  }

  /** One statement, so two tool calls at once cannot both pass the limit. */
  open(input: OpenAgentWaitInput): AgentWait {
    const waitId = this.#createId();
    const inserted = this.#database.connection
      .prepare(
        `INSERT INTO agent_waits
           (wait_id, agent_id, request_delivery_id, request_text, note, routine_id, created_at, source, target, conditions_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM agent_waits WHERE agent_id = ?) < ?`,
      )
      .run(
        waitId,
        input.agentId,
        input.requestMessageId,
        input.requestText,
        input.note,
        input.routineId,
        this.#now().toISOString(),
        input.source?.source ?? "routine",
        input.source?.target ?? null,
        input.source ? JSON.stringify({ ...input.source.conditions, subject: input.source.subject }) : null,
        input.agentId,
        INPUT_LIMITS.agentWaits,
      );
    if (inserted.changes === 0)
      throw new AgentWaitLimitError(sourceText("error.backend.agentWaitLimit", { count: INPUT_LIMITS.agentWaits }));
    const wait = this.get(input.agentId, waitId);
    if (!wait) throw new Error("The new wait is missing.");
    return wait;
  }

  count(agentId: string): number {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT COUNT(*) AS waits FROM agent_waits WHERE agent_id = ?").get(agentId),
    );
    return row ? requiredNumberColumn(row, "waits") : 0;
  }

  /** The number of open waits of each agent that has one. */
  countByAgent(): Map<string, number> {
    const rows = databaseRows(
      this.#database.connection.prepare("SELECT agent_id, COUNT(*) AS waits FROM agent_waits GROUP BY agent_id").all(),
    );
    return new Map(rows.map((row) => [requiredStringColumn(row, "agent_id"), requiredNumberColumn(row, "waits")]));
  }

  /** Closes or cancels a wait. False when it was not open. */
  delete(agentId: string, waitId: string): boolean {
    return (
      this.#database.connection
        .prepare("DELETE FROM agent_waits WHERE agent_id = ? AND wait_id = ?")
        .run(agentId, waitId).changes > 0
    );
  }

  /** The waits a run of this routine wakes, when no event names one wait. */
  forRoutineRun(agentId: string, routineId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare(
          `SELECT * FROM agent_waits WHERE agent_id = ? AND source = 'routine' AND (routine_id IS NULL OR routine_id = ?)
           ORDER BY created_at, wait_id`,
        )
        .all(agentId, routineId),
    ).map(toWait);
  }

  /** The open waits of every agent that this source watches at this target. */
  forSource(source: AgentWaitSource, target: string, agentId?: string): AgentWait[] {
    const agent = agentId === undefined ? "" : " AND agent_id = ?";
    return databaseRows(
      this.#database.connection
        .prepare(`SELECT * FROM agent_waits WHERE source = ? AND target = ?${agent} ORDER BY created_at, wait_id`)
        .all(source, target, ...(agentId === undefined ? [] : [agentId])),
    ).map(toWait);
  }

  /** `forSource` with the conditions each wait opened with. */
  forSourceWithConditions(source: AgentWaitSource, target: string, agentId: string) {
    return databaseRows(
      this.#database.connection
        .prepare(
          "SELECT * FROM agent_waits WHERE source = ? AND target = ? AND agent_id = ? ORDER BY created_at, wait_id",
        )
        .all(source, target, agentId),
    ).map((row) => ({ wait: toWait(row), conditions: parseConditions(optionalStringColumn(row, "conditions_json")) }));
  }

  markWoken(agentId: string, waitIds: readonly string[], deliveryId: string): void {
    if (waitIds.length === 0) return;
    this.#database.connection
      .prepare(
        `UPDATE agent_waits SET woken_at = ?, wake_delivery_id = ?
         WHERE agent_id = ? AND wait_id IN (${waitIds.map(() => "?").join(", ")})`,
      )
      .run(this.#now().toISOString(), deliveryId, agentId, ...waitIds);
  }

  /** The open waits that this delivery woke. A wait cancelled since then is not in the list. */
  wokenBy(deliveryId: string): AgentWait[] {
    return databaseRows(
      this.#database.connection
        .prepare("SELECT * FROM agent_waits WHERE wake_delivery_id = ? ORDER BY created_at, wait_id")
        .all(deliveryId),
    ).map(toWait);
  }
}

function toWait(row: DynamicRecord): AgentWait {
  return {
    id: requiredStringColumn(row, "wait_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    note: requiredStringColumn(row, "note"),
    source: waitSource(requiredStringColumn(row, "source")),
    subject: conditionsSubject(parseConditions(optionalStringColumn(row, "conditions_json"))),
    requestMessageId: requiredStringColumn(row, "request_delivery_id"),
    requestText: requiredStringColumn(row, "request_text"),
    routineId: optionalStringColumn(row, "routine_id"),
    createdAt: requiredStringColumn(row, "created_at"),
    wokenAt: optionalStringColumn(row, "woken_at"),
    wakeDeliveryId: optionalStringColumn(row, "wake_delivery_id"),
  };
}

/**
 * A source that a newer build wrote reads as a routine wait, so it lists and closes. Nothing wakes it
 * here: `forRoutineRun` reads only the rows whose stored source is `routine`.
 */
function waitSource(value: string): AgentWaitSource {
  return isOneOf(AGENT_WAIT_SOURCES, value) ? value : "routine";
}

/** A row that holds no readable conditions has none: one bad row must not break every list. */
function parseConditions(json: string | null): DynamicRecord | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    return isDynamicRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function conditionsSubject(conditions: DynamicRecord | null): string | null {
  return typeof conditions?.subject === "string" ? conditions.subject : null;
}
