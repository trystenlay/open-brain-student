// ============================================================================
// CALL-LLM  (the LLM gateway)
// ============================================================================
// Every AI call in this brain goes through this one function. Agents never talk
// to a provider directly.
//
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// WHY ONLY THE SERVICE-ROLE KEY CAN CALL THIS: this function spends your money.
// Only your own functions (enrich-thought, weekly-digest) should be able to
// reach it. They prove it by sending the service-role key as their Bearer token.
// ============================================================================

import { bearerToken, corsHeaders, jsonResponse } from "../_shared/http.ts";

// Published list prices, in US dollars per million tokens.
// Check your provider's pricing page if these change.
// Keyed by model ID. Unknown models log a cost of 0 instead of guessing.
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50 },
  "claude-sonnet-5-5": { input: 2.00, output: 10.00 },
  "claude-opus-5-5": { input: 4.00, output: 20.00 },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  // Only our own functions may call this. The service-role key is the proof.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || bearerToken(req) !== serviceKey) {
    return jsonResponse({ error: "Not allowed" }, 401);
  }

  try {
    const body = await req.json();
    const {
      prompt,
      systemPrompt,
      model: requestedModel,
      maxTokens,
      userId,   // who to bill this call to (optional)
      source,   // which function spent it, e.g. "enrich-thought" (optional)
    } = body ?? {};

    if (!prompt || typeof prompt !== "string") {
      return jsonResponse({ error: "A prompt is required" }, 400);
    }

    // .trim() strips stray spaces and line breaks that can sneak in when a secret is pasted.
    const provider = (Deno.env.get("LLM_PROVIDER") ?? "anthropic").trim().toLowerCase();
    if (provider !== "anthropic") {
      return jsonResponse({ error: `Provider "${provider}" is not set up yet` }, 500);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return jsonResponse({ error: "ANTHROPIC_API_KEY is not set" }, 500);

    const model = (requestedModel || Deno.env.get("LLM_MODEL") || "claude-haiku-5-5").trim();

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens ?? 1024,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Anthropic error", res.status, JSON.stringify(data));
      return jsonResponse({ error: "AI provider call failed", status: res.status }, 502);
    }

    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");

    // Write the receipt. We don't wait for it before answering, and every error is
    // swallowed. A failed log must never fail the call that triggered it. The AI
    // already answered. keepAlive stops Supabase from cutting the write short.
    keepAlive(logUsage({
      userId,
      model,
      source,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    }));

    return jsonResponse({ text });
  } catch (err) {
    console.error("call-llm failed", err);
    return jsonResponse({ error: "Something went wrong" }, 500);
  }
});

// Tell the Supabase runtime to finish this work even after the response is sent.
// Without it, a background write can be cut off before it lands.
function keepAlive(work: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(work);
}

async function logUsage(u: {
  userId?: string;
  model: string;
  source?: string;
  inputTokens: number;
  outputTokens: number;
}) {
  try {
    if (!u.userId) return;
    const price = PRICES_PER_MTOK[u.model];
    const cost = price
      ? (u.inputTokens * price.input + u.outputTokens * price.output) / 1_000_000
      : 0;

    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/llm_usage`, {
      method: "POST",
      headers: {
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        user_id: u.userId,
        kind: "chat",
        model: u.model,
        source: u.source ?? null,
        prompt_tokens: u.inputTokens,
        completion_tokens: u.outputTokens,
        cost_usd: cost,
      }),
    });
    if (!r.ok) console.error("llm_usage insert failed", r.status, await r.text());
  } catch {
    // Swallow everything. See the note above.
  }
}
