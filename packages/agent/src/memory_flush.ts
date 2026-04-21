import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import {
  type DbClient,
  getRecentSessionMessages,
  saveMemory,
  type MemoryType,
} from "@agents/db";
import { createMemoryExtractionModel } from "./model";
import { generateEmbedding } from "./embeddings";

const DELTA_MESSAGE_COUNT = 4;

interface FlushOptions {
  db: DbClient;
  userId: string;
  sessionId: string;
}

interface ExtractedMemory {
  type: MemoryType;
  content: string;
}

const VALID_TYPES: ReadonlySet<MemoryType> = new Set([
  "episodic",
  "semantic",
  "procedural",
]);

const EXTRACTION_PROMPT = `You extract long-term memories from the LAST EXCHANGE of a conversation. Older turns are shown only as context to help you understand the latest message — do NOT extract memories from them.

Be CONSERVATIVE. Only extract facts that will still be true in the next session. Skip:
- Trivial chit-chat, greetings, acknowledgements ("ok", "thanks", "perfect").
- Tool inputs/outputs that are not durable knowledge.
- Anything tied to the current request that will not matter later.

Classify each memory as ONE of:
- "episodic": something the user did and roughly when (e.g. "Created repo X on 2026-04-18").
- "semantic": durable facts, preferences, or knowledge about the user (e.g. "Prefers TypeScript over Python").
- "procedural": how the user wants the agent to operate, recurring routines (e.g. "Always confirm before sending emails").

Return STRICT JSON in exactly this shape, with no prose, no code fences:
{"memories": [{"type": "episodic|semantic|procedural", "content": "concise factual sentence"}]}

If nothing in the LAST EXCHANGE is worth remembering, return: {"memories": []}`;

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function buildTranscript(
  messages: { role: string; content: string }[]
): string {
  const filtered = messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  if (filtered.length === 0) return "";

  // Mark the most recent user/assistant pair so the model knows what to extract.
  const lines: string[] = [];
  let lastUserIdx = -1;
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  filtered.forEach((m, i) => {
    const tag =
      i >= lastUserIdx && lastUserIdx !== -1
        ? `[${m.role} | LAST EXCHANGE]`
        : `[${m.role} | context]`;
    lines.push(`${tag}\n${m.content}`);
  });
  return lines.join("\n\n");
}

function parseMemories(raw: string): ExtractedMemory[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { memories?: unknown }).memories)
  ) {
    return [];
  }

  const items = (parsed as { memories: unknown[] }).memories;
  const out: ExtractedMemory[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const t = (item as { type?: unknown }).type;
    const c = (item as { content?: unknown }).content;
    if (typeof t !== "string" || typeof c !== "string") continue;
    if (!VALID_TYPES.has(t as MemoryType)) continue;
    const content = c.trim();
    if (content.length === 0) continue;
    out.push({ type: t as MemoryType, content });
  }
  return out;
}

/**
 * Post-session memory extraction. Loads the recent transcript, asks Haiku for
 * a structured list of durable memories, embeds each, and persists to the
 * `memories` table. Designed to be called fire-and-forget after a turn
 * completes: every failure mode is swallowed and logged so the user-facing
 * response is never affected.
 */
export async function flushSessionMemory({
  db,
  userId,
  sessionId,
}: FlushOptions): Promise<void> {
  console.log(`[memory_flush] start session=${sessionId} user=${userId}`);

  let transcript: string;
  try {
    const messages = await getRecentSessionMessages(
      db,
      sessionId,
      DELTA_MESSAGE_COUNT
    );
    if (messages.length < 2) {
      console.log(
        `[memory_flush] skip: only ${messages.length} recent message(s) in session`
      );
      return;
    }
    transcript = buildTranscript(messages);
    if (transcript.length === 0) {
      console.log("[memory_flush] skip: empty transcript after filtering");
      return;
    }
  } catch (error) {
    console.error("[memory_flush] failed to load messages", error);
    return;
  }

  let rawContent: string;
  try {
    const model = createMemoryExtractionModel();
    const response = await model.invoke([
      new SystemMessage(EXTRACTION_PROMPT),
      new HumanMessage(`Conversation transcript:\n\n${transcript}`),
    ]);
    rawContent = messageContentToString(response.content);
  } catch (error) {
    console.error("[memory_flush] extraction model failed", error);
    return;
  }

  const memories = parseMemories(rawContent);
  if (memories.length === 0) {
    console.log(
      `[memory_flush] no memories extracted (raw=${rawContent.slice(0, 200)})`
    );
    return;
  }

  console.log(`[memory_flush] extracted ${memories.length} memory item(s)`);

  const results = await Promise.allSettled(
    memories.map(async (mem) => {
      const embedding = await generateEmbedding(mem.content);
      await saveMemory(db, {
        userId,
        type: mem.type,
        content: mem.content,
        embedding,
      });
    })
  );

  let saved = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      saved++;
    } else {
      console.error("[memory_flush] save failed", r.reason);
    }
  }

  console.log(`[memory_flush] saved ${saved}/${memories.length} memories`);
}
