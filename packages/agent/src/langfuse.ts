import { CallbackHandler } from "@langfuse/langchain";

interface LangfuseTraceContext {
  userId: string;
  sessionId: string;
  operation: "run" | "resume";
  enabledToolNames: string[];
}

function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
      process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/**
 * Build a Langfuse CallbackHandler for a single LangGraph invocation.
 *
 * Returns `undefined` when Langfuse credentials are not configured so callers
 * can pass it straight into `compiled.invoke({ callbacks: handler ? [handler] : undefined })`
 * without branching.
 *
 * Span export to the Langfuse server is wired up in
 * `apps/web/src/instrumentation.ts` via `LangfuseSpanProcessor`; this module
 * only attaches the LangChain-side observation emitter.
 */
export function createLangfuseCallbackHandler({
  userId,
  sessionId,
  operation,
  enabledToolNames,
}: LangfuseTraceContext): CallbackHandler | undefined {
  if (!isLangfuseConfigured()) return undefined;

  return new CallbackHandler({
    userId,
    sessionId,
    tags: ["langgraph", "agent", operation],
    traceMetadata: {
      thread_id: sessionId,
      operation,
      enabled_tools: enabledToolNames,
    },
  });
}
