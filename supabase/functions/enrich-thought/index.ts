// ============================================================================
// ENRICH-THOUGHT  (the enrichment agent)
// ============================================================================
// Runs automatically every time a new thought is saved. A Supabase Database
// Webhook calls this function with the new row. It asks the AI (through the
// call-llm gateway) for tags, a category, and a one-sentence summary, then
// writes them back onto that same thought.
//
// It ALWAYS returns 200. A webhook that fails just gets retried or ignored, and
// the thought itself is already saved, so enrichment is a bonus, never a gate.
// ============================================================================

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];
const MIN_LENGTH = 20; // very short notes aren't worth a call

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const thought = payload?.record;
    if (!thought?.id || !thought?.content || !thought?.user_id) {
      console.log("enrich-thought: no usable record in payload");
      return new Response("ok", { status: 200 });
    }

    // Already categorized (for example, a weekly digest): leave it alone.
    if (thought.category) {
      return new Response("ok", { status: 200 });
    }

    const content: string = thought.content;
    if (content.trim().length < MIN_LENGTH) {
      console.log("enrich-thought: too short, skipping", thought.id);
      return new Response("ok", { status: 200 });
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    // Ask the gateway. Every call between our own functions needs the service key.
    const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        systemPrompt:
          "You tag notes for a personal knowledge base. Reply with JSON only. No prose, no code fences.",
        prompt:
          `Read this note and reply with exactly this JSON shape:\n` +
          `{"tags": ["3 to 5 short lowercase tags"], "category": "one of: ${CATEGORIES.join(", ")}", "summary": "one sentence"}\n\n` +
          `Note:\n${content}`,
        maxTokens: 300,
        userId: thought.user_id,
        source: "enrich-thought",
      }),
    });

    if (!llmRes.ok) {
      console.error("enrich-thought: call-llm failed", llmRes.status, await llmRes.text());
      return new Response("ok", { status: 200 });
    }

    const { text } = await llmRes.json();
    const enrichment = parseEnrichment(text);
    if (!enrichment) {
      console.error("enrich-thought: could not read AI reply", text);
      return new Response("ok", { status: 200 });
    }

    // Write the enrichment back onto the same row.
    const updateRes = await fetch(`${supabaseUrl}/rest/v1/thoughts?id=eq.${thought.id}`, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        tags: enrichment.tags,
        category: enrichment.category,
        summary: enrichment.summary,
        enriched_at: new Date().toISOString(),
      }),
    });

    if (!updateRes.ok) {
      console.error("enrich-thought: save failed", updateRes.status, await updateRes.text());
    }
  } catch (err) {
    console.error("enrich-thought crashed", err);
  }

  return new Response("ok", { status: 200 });
});

function parseEnrichment(raw: string) {
  try {
    // The AI sometimes wraps JSON in a code fence even when told not to.
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const data = JSON.parse(cleaned);

    const tags = Array.isArray(data.tags)
      ? data.tags.map((t: unknown) => String(t).toLowerCase()).slice(0, 5)
      : [];
    const category = CATEGORIES.includes(data.category) ? data.category : null;
    const summary = typeof data.summary === "string" ? data.summary : null;

    return { tags, category, summary };
  } catch {
    return null;
  }
}
