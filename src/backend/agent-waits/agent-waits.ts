import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentEvent, AgentWait, AgentWaitSource, AgentWaitsSnapshot } from "@openbot/contracts/ipc";
import { type EventFilter, type EventJsonValue, isEventFilter } from "@openbot/contracts/ipc-events";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Cause, Effect } from "effect";
import { z } from "zod";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "../agent/routine-tools";
import type { MailboxStore } from "../mailbox-store";
import type { DynamicToolCallParams } from "../protocol";
import { webhookEventTypeZodSchema, webhookFiltersZodSchema } from "../routine-tool-schema";
import { webhookMismatch } from "../webhook-trigger";
import { AgentWaitError, AgentWaitLimitError, type AgentWaitStore } from "./agent-wait-store";
import {
  type PullRequestReader,
  pullRequestSubject,
  pullRequestTarget,
  sweepPullRequestWaits,
} from "./pull-request-waits";

export const AWAIT_EVENT_TOOL = "await_event";
export const CLOSE_WAIT_TOOL = "close_wait";
export const LIST_WAITS_TOOL = "list_waits";

/** Close to the limit, a new wait reminds the agent to close the waits it finished. */
const NEAR_LIMIT_MARGIN = 3;

const waitOwnerSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_LIMITS.identifier)
  .describe("Stable id from list_agents. Omit it for your own waits.");

export const awaitEventToolSchema = z.strictObject({
  note: z.string().trim().min(1).max(INPUT_LIMITS.agentWaitNote),
  routineId: z.string().trim().min(1).max(INPUT_LIMITS.identifier).optional(),
  webhook: z
    .strictObject({
      routineId: z.string().trim().min(1).max(INPUT_LIMITS.identifier).describe("One of your webhook routines."),
      eventType: webhookEventTypeZodSchema.optional().describe('The event "type".'),
      filters: webhookFiltersZodSchema.optional().describe("Every filter must match."),
    })
    .optional()
    .describe("Only a run with a matching event wakes the wait. Not with routineId."),
  pullRequest: z
    .strictObject({
      repository: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u)
        .describe("owner/name, such as nightly-labs/openbot."),
      number: z.number().int().positive(),
    })
    .optional()
    .describe(
      "News wakes the wait: checks failed or passed, a comment by someone else, a conflict. Merged or closed ends it. OpenBot reads it every 2 minutes; do not poll.",
    ),
});

export const closeWaitToolSchema = z.strictObject({
  waitId: z.string().trim().min(1).max(INPUT_LIMITS.identifier),
  agentId: waitOwnerSchema.optional(),
});

export const listWaitsToolSchema = z.strictObject({ agentId: waitOwnerSchema.optional() });

export interface AgentWaitsHooks {
  emit(event: AgentEvent): void;
  /** Whether this agent owns this routine. */
  ownsRoutine(agentId: string, routineId: string): boolean;
  /** Whether this agent has a routine: only a routine run wakes a wait. */
  hasRoutine(agentId: string): boolean;
  /** The name of this agent's webhook routine, or null when it has no such routine. */
  webhookRoutineName(agentId: string, routineId: string): string | null;
  /** Whether the GitHub connection is on, so the host can read pull requests. */
  pullRequestsAvailable(): boolean;
  /** Throws when no local agent has this id. */
  requireKnownAgent(agentId: string): void;
  /** Queues the turn that a source event starts, as a line in the agent's own chat. Answers its delivery id. */
  enqueueWake(agentId: string, wake: AgentWake): Effect.Effect<string, { readonly cause: unknown }>;
  reportError(cause: unknown, agentId: string): void;
}

/**
 * The turn that a wait's source starts: `line` is what the chat shows, `prompt` what the agent reads.
 * `request` is the request the wait continues, so a wait that this turn opens serves it too.
 */
export interface AgentWake {
  waitId: string;
  source: AgentWaitSource;
  line: string;
  prompt: string;
  request: { deliveryId: string; text: string };
}

/** An event of a source other than a routine run, for the waits of its target. */
export interface AgentWaitEvent {
  source: Exclude<AgentWaitSource, "routine">;
  target: string;
  /** The `status.agent.waitWoke*` sentence that the chat shows. */
  line: string;
  /** What happened, for the agent. Text from outside OpenBot is framed as data. */
  text: string;
  /** The event ends the waits: no later event of the target is needed. */
  final: boolean;
  /** Only these waits of the target, when the source tells each wait its own news. */
  waitIds?: readonly string[];
}

export interface AgentWaitsOptions {
  store: AgentWaitStore;
  mailbox: MailboxStore;
  hooks: AgentWaitsHooks;
}

/** Where a wait was opened, as the tool router knows it. */
export interface AgentWaitCaller {
  agentId: string;
  /** A channel or messaging turn: its messages are not in the agent's own chat. */
  inExecutionThread: boolean;
}

/**
 * Open waits: work an agent stopped because it waits for something outside the turn. The agent
 * opens, lists and closes them with three tools, and another local agent can list and close them
 * with `agentId`; the user cancels them from the chat. Each wait has a source that wakes it: a
 * routine run of the agent, or an event of another source, such as the end of an MCP sign-in, which
 * the host opens the wait for. The input of the turn that wakes a wait repeats the request and the
 * note, so the agent can continue the request after its context lost it.
 *
 * It never imports the agent service facade.
 */
export class AgentWaits {
  readonly #store: AgentWaitStore;
  readonly #mailbox: MailboxStore;
  readonly #hooks: AgentWaitsHooks;

  constructor(options: AgentWaitsOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
  }

  list(agentId: string): AgentWaitsSnapshot {
    return { agentId, waits: this.#store.list(agentId) };
  }

  /** The user cancels a wait. A run that it woke and that has not started no longer names it. */
  cancel(agentId: string, waitId: string): void {
    if (!this.#store.delete(agentId, waitId)) throw new AgentWaitError(sourceText("error.backend.agentWaitGone"));
    this.#changed(agentId);
  }

  /**
   * Marks the waits that a routine run wakes, after its delivery is queued. A script event that
   * names a wait wakes only that wait. Any other run wakes every routine wait of its agent that has
   * no routine or has this routine. A webhook run with its `event` also wakes the webhook waits of
   * its routine whose conditions match it. A wait whose last wake has not ended yet stays with that run.
   */
  wakeForRun(
    run: { agentId: string; routineId: string },
    deliveryId: string,
    waitId: string | null,
    event: { type: string; data: EventJsonValue } | null = null,
  ): void {
    // A script event names only a wait that a routine run wakes.
    const named = waitId ? this.#store.get(run.agentId, waitId) : null;
    if (named && named.source !== "routine") return;
    const webhookWaits = event
      ? this.#store
          .forSourceWithConditions("webhook", run.routineId, run.agentId)
          .filter(({ conditions }) => webhookMismatch(webhookConditions(conditions), event) === null)
          .map(({ wait }) => wait)
      : [];
    const candidates = waitId
      ? named
        ? [named]
        : []
      : [...this.#store.forRoutineRun(run.agentId, run.routineId), ...webhookWaits];
    const woken = candidates
      .filter((wait) => !wait.wakeDeliveryId || !this.#isPending(wait.wakeDeliveryId))
      .map((wait) => wait.id);
    if (woken.length === 0) return;
    this.#store.markWoken(run.agentId, woken, deliveryId);
    this.#changed(run.agentId);
  }

  /** The number of open waits of each agent that has one. */
  countByAgent(): Map<string, number> {
    return this.#store.countByAgent();
  }

  /** The waits that the run of this delivery continues, read when the run starts. */
  wokenBy(deliveryId: string): AgentWait[] {
    return this.#store.wokenBy(deliveryId);
  }

  /**
   * Opens the wait of a source for the request of this turn, such as for a Sign in card. An open wait
   * of the same agent, source, target and request stays the one wait; one for an earlier request is
   * replaced. Null when the turn has no request or the agent has the most open waits: then nothing
   * wakes the agent.
   */
  openForSource(
    caller: { agentId: string; turnId: string },
    input: { source: Exclude<AgentWaitSource, "routine">; target: string; subject: string; note: string },
  ): AgentWait | null {
    const request = this.#requestOf(caller.agentId, caller.turnId);
    if (!request) return null;
    const existing = this.#store.forSource(input.source, input.target, caller.agentId)[0];
    if (existing?.requestMessageId === request.id) return existing;
    if (existing) this.#store.delete(caller.agentId, existing.id);
    try {
      const wait = this.#store.open({
        agentId: caller.agentId,
        requestMessageId: request.id,
        requestText: request.text,
        note: input.note,
        routineId: null,
        source: { source: input.source, target: input.target, subject: input.subject },
      });
      this.#changed(caller.agentId);
      return wait;
    } catch (error) {
      if (error instanceof AgentWaitLimitError) return null;
      throw error;
    }
  }

  /**
   * Starts a turn of each agent whose wait watches this target, with the event and the request that
   * the wait continues. A wait whose last wake has not ended yet stays with that turn, unless the
   * event is final: then it closes the waits and always wakes them. A wake that fails, such as for an
   * agent that is gone, closes the wait. A failure never reaches the caller, so the source's own
   * result, such as a sign-in, stands.
   */
  readonly wake = Effect.fn("AgentWaits.wake")(function* (this: AgentWaits, event: AgentWaitEvent) {
    const waits = this.#store
      .forSource(event.source, event.target)
      .filter((wait) => !event.waitIds || event.waitIds.includes(wait.id))
      .filter((wait) => event.final || !wait.wakeDeliveryId || !this.#isPending(wait.wakeDeliveryId));
    yield* Effect.forEach(waits, (wait) =>
      this.#hooks
        .enqueueWake(wait.agentId, {
          waitId: wait.id,
          source: event.source,
          line: event.line,
          prompt: wakePromptText(wait, event),
          request: { deliveryId: wait.requestMessageId, text: wait.requestText },
        })
        .pipe(
          Effect.tap((deliveryId) =>
            Effect.sync(() =>
              event.final
                ? this.#store.delete(wait.agentId, wait.id)
                : this.#store.markWoken(wait.agentId, [wait.id], deliveryId),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              this.#store.delete(wait.agentId, wait.id);
              this.#hooks.reportError(Cause.squash(cause), wait.agentId);
            }),
          ),
          Effect.ensuring(Effect.sync(() => this.#changed(wait.agentId))),
        ),
    );
  });

  /** Answers `await_event`, `close_wait` and `list_waits`; null for every other tool. */
  handleTool(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse | null {
    try {
      if (params.tool === AWAIT_EVENT_TOOL) return this.#awaitEvent(params, caller);
      if (params.tool === CLOSE_WAIT_TOOL) return this.#closeWait(params, caller);
      if (params.tool === LIST_WAITS_TOOL) return this.#listWaits(params, caller);
      return null;
    } catch (error) {
      if (error instanceof AgentWaitError) return openBotToolFailure(error.message);
      throw error;
    }
  }

  #awaitEvent(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse {
    const parsed = awaitEventToolSchema.safeParse(params.arguments);
    if (!parsed.success)
      return openBotToolFailure(
        parsed.error.issues.some((issue) => issue.path[0] === "note")
          ? sourceText("error.backend.agentWaitNoteRequired")
          : z.prettifyError(parsed.error),
      );
    const { note, routineId, webhook, pullRequest } = parsed.data;
    if (caller.inExecutionThread) return openBotToolFailure(sourceText("error.backend.agentWaitOwnChatOnly"));
    const deliveries = this.#mailbox.findDeliveriesByTurn(caller.agentId, params.turnId);
    // A run that continues waits keeps them: leaving a wait open waits for the next run again.
    const continued = deliveries.flatMap((context) => this.#store.wokenBy(context.delivery.id));
    if (continued.length > 0)
      return openBotToolResult({
        waitIds: continued.map((wait) => wait.id),
        note: "This run continues these open waits. To wait again, leave them open and end your turn. Open a new wait only for a different request.",
      });
    const request = this.#requestOf(caller.agentId, params.turnId);
    if (!request) return openBotToolFailure(sourceText("error.backend.agentWaitNoRequest"));
    if (pullRequest && (routineId || webhook))
      return openBotToolFailure(sourceText("error.backend.agentWaitOneSource"));
    if (pullRequest && !this.#hooks.pullRequestsAvailable())
      return openBotToolFailure(sourceText("error.backend.agentWaitGitHubDisconnected"));
    if (routineId && !this.#hooks.ownsRoutine(caller.agentId, routineId))
      return openBotToolFailure(sourceText("error.backend.agentWaitRoutineGone"));
    // A pull request wait needs no routine: the host's own sweep wakes it.
    if (!pullRequest && !this.#hooks.hasRoutine(caller.agentId))
      return openBotToolFailure(sourceText("error.backend.agentWaitNoRoutine"));
    const webhookName = webhook ? this.#hooks.webhookRoutineName(caller.agentId, webhook.routineId) : null;
    if (webhook && (routineId || webhookName === null || !(webhook.filters ?? []).every(isEventFilter)))
      return openBotToolFailure(sourceText("error.backend.agentWaitWebhookInvalid"));
    let wait: AgentWait;
    try {
      wait = this.#store.open({
        agentId: caller.agentId,
        requestMessageId: request.id,
        requestText: request.text,
        note,
        routineId: webhook?.routineId ?? routineId ?? null,
        ...(pullRequest
          ? {
              source: {
                source: "github-pull-request",
                target: pullRequestTarget(pullRequest),
                subject: pullRequestSubject(pullRequest),
                conditions: { repository: pullRequest.repository, number: pullRequest.number },
              },
            }
          : {}),
        ...(webhook && webhookName !== null
          ? {
              source: {
                source: "webhook",
                target: webhook.routineId,
                subject: webhookName,
                conditions: { eventType: webhook.eventType?.trim() || null, filters: webhook.filters ?? [] },
              },
            }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof AgentWaitLimitError)) throw error;
      // The open waits come with the refusal, so the agent can close the finished ones at once.
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              error: error.message,
              waits: this.#store.list(caller.agentId).map(waitSummary),
            }),
          },
        ],
      };
    }
    this.#changed(caller.agentId);
    const openWaits = this.#store.count(caller.agentId);
    return openBotToolResult({
      waitId: wait.id,
      openWaits,
      limit: INPUT_LIMITS.agentWaits,
      ...(openWaits >= INPUT_LIMITS.agentWaits - NEAR_LIMIT_MARGIN
        ? {
            nearLimit: `You are close to the limit of open waits. Call openbot.${LIST_WAITS_TOOL} and close the waits whose request is done.`,
          }
        : {}),
      ...(wait.source === "github-pull-request"
        ? {
            wakes: `News of pull request ${wait.subject} wakes this wait: OpenBot reads it every 2 minutes. Merged or closed ends the wait.`,
          }
        : wait.source === "webhook"
          ? {
              wakes: `The next event of webhook routine ${wait.routineId} that matches the event type and the filters wakes this wait. Other events of the routine still run it, without the wait.`,
            }
          : {
              wakes: wait.routineId
                ? `The next run of routine ${wait.routineId} wakes this wait, or a script event that names it.`
                : "The next run of any of your routines wakes this wait, or a script event that names it.",
              scriptEvent: `A local script names the wait with "waitId": "${wait.id}" next to "payload" in the body of its routine run request.`,
            }),
      next: "End your turn now. The run that wakes the wait repeats the request and your note. Close the wait with openbot.close_wait when the request is done.",
    });
  }

  #closeWait(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse {
    const parsed = closeWaitToolSchema.safeParse(params.arguments);
    if (!parsed.success) return openBotToolFailure(z.prettifyError(parsed.error));
    const agentId = this.#waitOwner(parsed.data.agentId, caller);
    if (!this.#store.delete(agentId, parsed.data.waitId))
      return openBotToolFailure(sourceText("error.backend.agentWaitGone"));
    this.#changed(agentId);
    return openBotToolResult({ closed: parsed.data.waitId });
  }

  #listWaits(params: DynamicToolCallParams, caller: AgentWaitCaller): OpenBotToolResponse {
    const parsed = listWaitsToolSchema.safeParse(params.arguments ?? {});
    if (!parsed.success) return openBotToolFailure(z.prettifyError(parsed.error));
    const agentId = this.#waitOwner(parsed.data.agentId, caller);
    return openBotToolResult({
      agentId,
      limit: INPUT_LIMITS.agentWaits,
      waits: this.#store.list(agentId).map(waitSummary),
    });
  }

  /**
   * The request a wait opened in this turn serves. The user's message comes first; a routine run that
   * waits serves its own instruction; a wake serves the request of the wait it woke.
   */
  #requestOf(agentId: string, turnId: string): { id: string; text: string } | null {
    const deliveries = this.#mailbox.findDeliveriesByTurn(agentId, turnId);
    const context =
      deliveries.findLast((candidate) => candidate.delivery.sender.kind === "user") ?? deliveries.at(0) ?? null;
    if (!context) return null;
    if (context.wake) return { id: context.wake.request.deliveryId, text: context.wake.request.text };
    return { id: context.delivery.id, text: context.delivery.text };
  }

  /** The agent whose waits a tool call reads or closes. An unknown agent is a request the model can correct. */
  #waitOwner(agentId: string | undefined, caller: AgentWaitCaller): string {
    if (agentId === undefined || agentId === caller.agentId) return caller.agentId;
    try {
      this.#hooks.requireKnownAgent(agentId);
    } catch (error) {
      throw new AgentWaitError(error instanceof Error ? error.message : String(error));
    }
    return agentId;
  }

  /** One sweep of the `github-pull-request` waits with this reader. The owner runs it on a timer. */
  sweepPullRequests(reader: PullRequestReader) {
    return sweepPullRequestWaits({
      waits: () => this.#store.allForSource("github-pull-request"),
      setCursor: (wait, cursor, failures) => this.#store.setCursor(wait.agentId, wait.id, cursor, failures),
      wakePending: (wait) => this.wakePending(wait),
      wake: (event) => this.wake(event),
      reader,
    });
  }

  /** True while the turn of the wait's last wake is queued or runs. */
  wakePending(wait: AgentWait): boolean {
    return wait.wakeDeliveryId !== null && this.#isPending(wait.wakeDeliveryId);
  }

  #isPending(deliveryId: string): boolean {
    const status = this.#mailbox.getDelivery(deliveryId)?.delivery.status;
    return status === "queued" || status === "starting" || status === "running";
  }

  #changed(agentId: string): void {
    this.#hooks.emit({ type: "waits-changed", snapshot: this.list(agentId) });
  }
}

/** A wait as the list tools show it. The request text stays out: it can be long, and it is the user's. */
function waitSummary(wait: AgentWait) {
  return {
    waitId: wait.id,
    note: wait.note,
    source: wait.source,
    subject: wait.subject,
    openedAt: wait.createdAt,
    routineId: wait.routineId,
    wokenAt: wait.wokenAt,
  };
}

/** The part of a run's input that continues its woken waits. */
export function wokenWaitsPromptText(waits: readonly AgentWait[]): string | null {
  if (waits.length === 0) return null;
  return [
    "--- open waits that this run wakes ---",
    `You opened these waits with openbot.${AWAIT_EVENT_TOOL}. Continue each request with what this run brings. When a request is done, or can no longer be done, tell the user and call openbot.${CLOSE_WAIT_TOOL} with its wait id. To wait for the next run again, leave the wait open.`,
    ...waits.flatMap((wait) => [
      "",
      `Wait ID: ${wait.id}`,
      `Opened: ${wait.createdAt}`,
      `Your note: ${wait.note}`,
      "The request it continues:",
      wait.requestText,
    ]),
    "--- end of open waits ---",
  ].join("\n");
}

/** The input of the turn that a source event starts: the event, then the wait and the request it continues. */
function wakePromptText(wait: AgentWait, event: AgentWaitEvent): string {
  return [
    "OpenBot note, not a message from the user: an event that one of your open waits waits for happened.",
    "--- event ---",
    event.text,
    "--- the wait it wakes ---",
    `Wait ID: ${wait.id}`,
    `Opened: ${wait.createdAt}`,
    `Your note: ${wait.note}`,
    "The request it continues:",
    wait.requestText,
    "--- end of the wait ---",
    event.final
      ? "This event ends the wait: OpenBot closed it."
      : `The wait stays open, and the next event of its source wakes you again. Call openbot.${CLOSE_WAIT_TOOL} with its wait id when the request is done or no longer needed.`,
  ].join("\n");
}

/** The trigger fields that a webhook wait opened with. */
function webhookConditions(conditions: DynamicRecord | null): { eventType: string | null; filters: EventFilter[] } {
  const eventType = typeof conditions?.eventType === "string" ? conditions.eventType : null;
  const filters = Array.isArray(conditions?.filters) ? conditions.filters.filter(isEventFilter) : [];
  return { eventType, filters };
}
