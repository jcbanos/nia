import {
  Annotation,
  messagesStateReducer,
} from "@langchain/langgraph";
import type { BaseMessage, BaseMessageLike } from "@langchain/core/messages";

// Last-write-wins reducer used for scalar fields. Identity on the new value;
// keeps the most recently written value across node updates.
function lastWriteWins<T>(_prev: T | undefined, next: T): T {
  return next;
}

/**
 * Root annotation describing the agent's graph state.
 *
 * Channels:
 * - `messages`: conversation buffer reduced with `messagesStateReducer` so the
 *   graph supports `RemoveMessage` and replacement-by-id semantics.
 * - `sessionId`, `userId`, `systemPrompt`: scalar identifiers / config injected
 *   by `runAgent`/`resumeAgent`. Last-write-wins, no default (must be supplied
 *   on the first invocation).
 * - `bypassConfirmation`: whether to skip HITL interrupts. Defaults to `false`;
 *   the cron path can flip it to `true` in a future iteration.
 * - `compactionCount`: number of consecutive failures of the LLM compactor.
 *   Used by `compaction_node` as a circuit breaker. Defaults to `0`.
 */
export const GraphStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], BaseMessageLike | BaseMessageLike[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionId: Annotation<string>({
    reducer: lastWriteWins,
  }),
  userId: Annotation<string>({
    reducer: lastWriteWins,
  }),
  systemPrompt: Annotation<string>({
    reducer: lastWriteWins,
  }),
  bypassConfirmation: Annotation<boolean>({
    reducer: lastWriteWins,
    default: () => false,
  }),
  compactionCount: Annotation<number>({
    reducer: lastWriteWins,
    default: () => 0,
  }),
});

export type GraphState = typeof GraphStateAnnotation.State;
export type GraphStateUpdate = typeof GraphStateAnnotation.Update;
