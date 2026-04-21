const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

interface EmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter embeddings request failed: ${res.status} ${res.statusText} ${body}`
    );
  }

  const json = (await res.json()) as EmbeddingResponse;
  const embedding = json.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("OpenRouter embeddings response missing data[0].embedding");
  }
  return embedding;
}
