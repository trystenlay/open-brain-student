// ============================================================================
// ENRICH-THOUGHT  (the enrichment agent)
// ============================================================================
// Runs automatically every time a new thought is saved. A database trigger
// calls this function with the new row. It does two independent jobs:
//
//   1. ENRICH: asks the AI (through the call-llm gateway) for tags, a category,
//      and a one-sentence summary, and writes them onto the thought.
//   2. EMBED:  asks generate-embedding for the thought's meaning, as a list of
//      1,536 numbers, and writes that onto the thought too.
//
//   3. LINK:   once the thought has an embedding, finds its nearest neighbors
//      (the thoughts closest in meaning) and saves a link to each.
//
// Each job can fail without stopping the others. A thought that fails to embed
// still saves, and can be backfilled later.
//
// It ALWAYS returns 200. The thought itself is already saved, so enrichment
// is a bonus, never a gate.
// ============================================================================

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];
const MIN_LENGTH = 20; // very short notes aren't worth an AI summary

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const thought = payload?.record;
    if (!thought?.id || !thought?.content || !thought?.user_id) {
      console.log("enrich-thought: no usable record in payload");
      return new Response("ok", { status: 200 });
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    // Job 1: tags, category, summary. Skipped for things already categorized
    // (for example a weekly digest) and for very short notes.
    try {
      const content: string = thought.content;
      if (!thought.category && content.trim().length >= MIN_LENGTH) {
        await enrich(thought, serviceKey, supabaseUrl);
      }
    } catch (err) {
      console.error("enrich-thought: enrichment crashed", err);
    }

    // Job 2: the embedding. Done for every thought, digests included.
    try {
      await embed(thought, serviceKey, supabaseUrl);
    } catch (err) {
      console.error("enrich-thought: embedding crashed", err);
    }
  } catch (err) {
    console.error("enrich-thought crashed", err);
  }

  return new Response("ok", { status: 200 });
});

async function enrich(
  thought: { id: string; content: string; user_id: string },
  serviceKey: string,
  supabaseUrl: string,
) {
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
        `Note:\n${thought.content}`,
      maxTokens: 300,
      userId: thought.user_id,
      source: "enrich-thought",
    }),
  });

  if (!llmRes.ok) {
    console.error("enrich-thought: call-llm failed", llmRes.status, await llmRes.text());
    return;
  }

  const { text } = await llmRes.json();
  const enrichment = parseEnrichment(text);
  if (!enrichment) {
    console.error("enrich-thought: could not read AI reply", text);
    return;
  }

  await patchThought(thought.id, {
    tags: enrichment.tags,
    category: enrichment.category,
    summary: enrichment.summary,
    enriched_at: new Date().toISOString(),
  }, serviceKey, supabaseUrl);
}

async function embed(
  thought: { id: string; content: string; user_id: string },
  serviceKey: string,
  supabaseUrl: string,
) {
  // NOTE the Authorization header. It is not optional. One edge function calling
  // another must prove who it is, or Supabase rejects the call with a 401 before
  // generate-embedding even runs. The symptom is that embeddings silently never
  // appear and the generate-embedding logs are empty, because it never ran.
  const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ text: thought.content }),
  });

  if (!embRes.ok) {
    console.error("enrich-thought: generate-embedding failed", embRes.status, await embRes.text());
    return;
  }

  const { embedding } = await embRes.json();
  if (!embedding) {
    console.error("enrich-thought: no embedding came back for", thought.id);
    return;
  }

  await patchThought(thought.id, { embedding }, serviceKey, supabaseUrl);

  // Job 3: only worth doing once there is an embedding to compare.
  try {
    await linkNeighbors(thought, embedding, serviceKey, supabaseUrl);
  } catch (err) {
    console.error("enrich-thought: linking crashed", err);
  }
}

// Find the thoughts closest in meaning and save a link to each. Scoped to the
// same user as the new thought, because the service key skips row-level
// security and would otherwise see everyone's thoughts.
async function linkNeighbors(
  thought: { id: string; user_id: string },
  embedding: number[],
  serviceKey: string,
  supabaseUrl: string,
) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/find_links_for_thought`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source_id: thought.id,
      source_embedding: embedding,
      p_user_id: thought.user_id,
      match_threshold: 0.5,
      match_count: 5,
    }),
  });
  if (!rpcRes.ok) {
    console.error("enrich-thought: neighbor lookup failed", rpcRes.status, await rpcRes.text());
    return;
  }

  const neighbors: Array<{ target_id: string; similarity: number }> = await rpcRes.json();
  if (!neighbors.length) return;

  const links = neighbors.map((n) => ({
    source_thought_id: thought.id,
    target_thought_id: n.target_id,
    user_id: thought.user_id,
    similarity_score: n.similarity,
    link_type: "semantic",
  }));

  // ignore-duplicates with no conflict target means: skip any link that would
  // break a uniqueness rule, in either direction. No errors, no overwrites.
  const saveRes = await fetch(`${supabaseUrl}/rest/v1/thought_links`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(links),
  });
  if (!saveRes.ok) {
    console.error("enrich-thought: saving links failed", saveRes.status, await saveRes.text());
  }
}

async function patchThought(
  id: string,
  fields: Record<string, unknown>,
  serviceKey: string,
  supabaseUrl: string,
) {
  const res = await fetch(`${supabaseUrl}/rest/v1/thoughts?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    console.error("enrich-thought: save failed", res.status, await res.text());
  }
}

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
