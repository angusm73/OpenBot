import { Effect } from "effect";

/** What can wake a watch. Only OpenBot's own events for now: the end of an MCP sign-in. */
export type AgentWatchSource = "mcp-sign-in";

export interface AgentWatch {
  agentId: string;
  source: AgentWatchSource;
  /** What the source names its event by, such as the address of an MCP server. */
  target: string;
}

export interface AgentWatchesOptions {
  /** Starts a new turn of the agent with this text, as a message in its own chat. */
  wake(agentId: string, text: string): Effect.Effect<unknown, { readonly cause: unknown }>;
  reportError(cause: unknown, agentId: string): void;
}

/**
 * Watches: an agent that ended its turn to wait for an event gets a new turn when the event comes,
 * so neither the agent nor the user has to ask again. A source sends its events to `notify`; a final
 * event ends the watches of its target. One watch for each agent, source and target.
 * The watches are in memory: a restart forgets them. See docs/architecture/agent-watches.md.
 *
 * It never imports the agent service facade.
 */
export class AgentWatches {
  readonly #watches = new Map<string, AgentWatch>();
  readonly #options: AgentWatchesOptions;

  constructor(options: AgentWatchesOptions) {
    this.#options = options;
  }

  watch(watch: AgentWatch): void {
    this.#watches.set(watchKey(watch), watch);
  }

  /**
   * Wakes the agent of each watch of this target with `text`. A final event also ends the watches,
   * and so does a wake that fails, such as for an agent that is gone.
   */
  readonly notify = Effect.fn("AgentWatches.notify")(function* (
    this: AgentWatches,
    event: { source: AgentWatchSource; target: string; text: string; final: boolean },
  ) {
    const { source, target, text } = event;
    const woken = [...this.#watches.values()].filter((watch) => watch.source === source && watch.target === target);
    if (event.final) for (const watch of woken) this.#watches.delete(watchKey(watch));
    yield* Effect.forEach(woken, (watch) =>
      this.#options.wake(watch.agentId, text).pipe(
        Effect.catch((failure) =>
          Effect.sync(() => {
            this.#watches.delete(watchKey(watch));
            this.#options.reportError(failure.cause, watch.agentId);
          }),
        ),
      ),
    );
  });
}

function watchKey(watch: AgentWatch): string {
  return JSON.stringify([watch.agentId, watch.source, watch.target]);
}
