// ============================================================================
// GENERATE-EMBEDDING
// ============================================================================
// Turns a piece of text into an embedding: a list of 1,536 numbers that
// describes what the text MEANS. Two texts with similar meaning get similar
// numbers, even when they use completely different words.
//
// To switch embedding providers, change the model string. The vector dimension
// must stay 1536 or you need a new migration.
//
// Like call-llm, this spends money, so only your own functions may call it.
// They prove it by sending the service-role key as their Bearer token.
// On any failure it returns { embedding: null } with a 200, so a caller can
// carry on without crashing. The thought still saves; it just has no embedding
// yet and can be backfilled later.
// ============================================================================

import { bearerToken, corsHeaders, jsonResponse } from "../_shared/http.ts";
import { isServiceRoleRequest } from "../_shared/auth.ts";

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 24_000; // keeps one very long capture from blowing past the model's input limit

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || !isServiceRoleRequest(req)) {
    return jsonResponse({ error: "Not allowed" }, 401);
  }

  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string" || !text.trim()) {
      return jsonResponse({ embedding: null });
    }

    const apiKey = (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim();
    if (!apiKey) {
      console.error("generate-embedding: OPENROUTER_API_KEY is not set");
      return jsonResponse({ embedding: null });
    }

    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, MAX_CHARS),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error("generate-embedding: provider error", res.status, await res.text());
      return jsonResponse({ embedding: null });
    }

    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      console.error("generate-embedding: unexpected shape, length =", embedding?.length);
      return jsonResponse({ embedding: null });
    }

    return jsonResponse({ embedding });
  } catch (err) {
    console.error("generate-embedding failed", err);
    return jsonResponse({ embedding: null });
  }
});
