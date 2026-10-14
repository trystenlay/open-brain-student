// ============================================================================
// BACKFILL-CHUNKS
// ============================================================================
// One-time catch-up job: finds long thoughts that have no chunks yet, cuts each
// into overlapping pieces, embeds every piece, and saves them. Run it in a loop
// from a command window until `remaining` reaches 0.
//
// Request:  POST { batch_size?: number, offset?: number, dry_run?: boolean, repair?: boolean }
// Response: { processed, chunked, failed, offset_next, remaining }
//           dry_run: true returns { needs_chunks } and writes nothing.
//           repair:  true fills in chunks that were saved WITHOUT an embedding
//                    (an embedding call failed at the time). Returns
//                    { processed, embedded, failed, offset_next, remaining }.
//
// Biggest documents first, since they gain the most if a run is interrupted.
//
// HOW `offset` WORKS HERE: a thought that gets chunks drops out of the
// "needs chunks" list on its own, so the next batch starts at the top again.
// Only thoughts that FAILED stay in that list, so offset_next skips past them.
// Otherwise one stubborn failure would be retried forever.
//
// Batches are small on purpose: one long transcript can mean dozens of
// embedding calls, and a large batch can hit the platform's time limit.
//
// Only your own tools may call this. Send the service-role key as the Bearer
// token.
// ============================================================================

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { isServiceRoleRequest } from "../_shared/auth.ts";
import { saveThoughtChunksSafe } from "../_shared/thought-chunks.ts";

const DEFAULT_BATCH = 2;
const MAX_BATCH = 5;

// One embedding through our own generate-embedding function. Retries once, since
// the usual cause of a miss is a brief rate limit or timeout.
async function embedOne(text: string, serviceKey: string): Promise<number[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-embedding`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const { embedding } = await res.json();
        if (Array.isArray(embedding)) return embedding;
      }
    } catch { /* fall through and retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || !isServiceRoleRequest(req)) {
    return jsonResponse({ error: "Not allowed" }, 401);
  }

  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batch_size) || DEFAULT_BATCH, 1), MAX_BATCH);
    const offset = Math.max(Number(body?.offset) || 0, 0);

    // Dry run: just count, write nothing.
    if (body?.dry_run === true) {
      const { count, error } = await db
        .from("thoughts_needing_chunks")
        .select("id", { count: "exact", head: true });
      if (error) return jsonResponse({ error: "Could not count: " + error.message }, 500);
      return jsonResponse({ needs_chunks: count ?? 0 });
    }

    // Repair mode: chunks that were saved but never got an embedding. They are
    // still found by keyword search, but invisible to search by meaning.
    if (body?.repair === true) {
      const repairBatch = Math.min(Math.max(Number(body?.batch_size) || 10, 1), 20);
      const { data: rows, error: repairError } = await db
        .from("thought_chunks")
        .select("id, content")
        .is("embedding", null)
        .order("created_at", { ascending: true })
        .range(offset, offset + repairBatch - 1);
      if (repairError) return jsonResponse({ error: "Could not read chunks: " + repairError.message }, 500);

      let embedded = 0;
      let repairFailed = 0;
      for (const c of rows ?? []) {
        const embedding = await embedOne(c.content, serviceKey);
        if (!embedding) {
          repairFailed++;
          continue;
        }
        const { error: updError } = await db.from("thought_chunks").update({ embedding }).eq("id", c.id);
        if (updError) repairFailed++;
        else embedded++;
      }

      const { count: stillMissing } = await db
        .from("thought_chunks")
        .select("id", { count: "exact", head: true })
        .is("embedding", null);

      const repairOffsetNext = offset + repairFailed;
      return jsonResponse({
        processed: (rows ?? []).length,
        embedded,
        failed: repairFailed,
        offset_next: repairOffsetNext,
        remaining: Math.max((stillMissing ?? 0) - repairOffsetNext, 0),
      });
    }

    // The next batch: biggest documents first, skipping any that already failed.
    const { data: batch, error: listError } = await db
      .from("thoughts_needing_chunks")
      .select("id, chars")
      .order("chars", { ascending: false })
      .range(offset, offset + batchSize - 1);
    if (listError) return jsonResponse({ error: "Could not read the list: " + listError.message }, 500);

    let chunked = 0;
    let failed = 0;

    for (const row of batch ?? []) {
      // Full content and owner, fetched one at a time so a batch stays light.
      const { data: thought, error } = await db
        .from("thoughts")
        .select("id, content, user_id")
        .eq("id", row.id)
        .maybeSingle();
      if (error || !thought) {
        failed++;
        continue;
      }

      const made = await saveThoughtChunksSafe(
        db,
        thought.id,
        thought.content,
        "backfill-chunks",
        "summary",
        thought.user_id,
      );
      if (made > 0) chunked++;
      else failed++;
    }

    // How many still need chunks, counted after this batch.
    const { count: stillNeeding } = await db
      .from("thoughts_needing_chunks")
      .select("id", { count: "exact", head: true });

    const offsetNext = offset + failed;
    return jsonResponse({
      processed: (batch ?? []).length,
      chunked,
      failed,
      offset_next: offsetNext,
      remaining: Math.max((stillNeeding ?? 0) - offsetNext, 0),
    });
  } catch (err) {
    console.error("backfill-chunks failed", err);
    return jsonResponse({ error: "Something went wrong" }, 500);
  }
});
