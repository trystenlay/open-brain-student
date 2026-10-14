// ============================================================================
// BACKFILL-LINKS
// ============================================================================
// One-time catch-up job: for every thought that already has an embedding but no
// links yet, finds its nearest neighbors and saves the links. Run it in a loop
// from a command window until `remaining` reaches 0.
//
// Request:  POST { batch_size?: number, offset?: number }
// Response: { processed, linked, already_done, offset_next, remaining }
//
// Batches are small on purpose. Each thought needs a database lookup, and large
// batches can hit the platform's worker time limit and fail with a 546.
//
// Only your own tools may call this. Send the service-role key as the Bearer
// token.
// ============================================================================

import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { isServiceRoleRequest } from "../_shared/auth.ts";

const DEFAULT_BATCH = 3;
const MAX_BATCH = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || !isServiceRoleRequest(req)) {
    return jsonResponse({ error: "Not allowed" }, 401);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batch_size) || DEFAULT_BATCH, 1), MAX_BATCH);
    const offset = Math.max(Number(body?.offset) || 0, 0);

    // Thoughts that have an embedding, oldest first. They stay in this list after
    // they are linked, so ordinary offset paging is correct here.
    const listRes = await fetch(
      `${supabaseUrl}/rest/v1/thoughts?select=id,user_id,embedding&embedding=not.is.null` +
        `&order=created_at.asc&limit=${batchSize}&offset=${offset}`,
      { headers: { ...headers, Prefer: "count=exact" } },
    );
    if (!listRes.ok) {
      return jsonResponse({ error: "Could not read thoughts", detail: await listRes.text() }, 500);
    }
    const total = Number((listRes.headers.get("content-range") ?? "").split("/")[1]) || 0;
    const batch: Array<{ id: string; user_id: string; embedding: string }> = await listRes.json();

    let linked = 0;
    let alreadyDone = 0;

    for (const t of batch) {
      try {
        // Already has a link in either direction? Then it was handled.
        const haveRes = await fetch(
          `${supabaseUrl}/rest/v1/thought_links?select=id` +
            `&or=(source_thought_id.eq.${t.id},target_thought_id.eq.${t.id})&limit=1`,
          { headers },
        );
        const have = haveRes.ok ? await haveRes.json() : [];
        if (have.length) {
          alreadyDone++;
          continue;
        }

        const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/find_links_for_thought`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            source_id: t.id,
            source_embedding: t.embedding,
            p_user_id: t.user_id,
            match_threshold: 0.5,
            match_count: 5,
          }),
        });
        if (!rpcRes.ok) {
          console.error("backfill-links: lookup failed", t.id, rpcRes.status, await rpcRes.text());
          continue;
        }

        const neighbors: Array<{ target_id: string; similarity: number }> = await rpcRes.json();
        if (!neighbors.length) continue;

        const links = neighbors.map((n) => ({
          source_thought_id: t.id,
          target_thought_id: n.target_id,
          user_id: t.user_id,
          similarity_score: n.similarity,
          link_type: "semantic",
        }));

        const saveRes = await fetch(`${supabaseUrl}/rest/v1/thought_links`, {
          method: "POST",
          headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify(links),
        });
        if (saveRes.ok) linked += links.length;
        else console.error("backfill-links: save failed", t.id, saveRes.status, await saveRes.text());
      } catch (err) {
        console.error("backfill-links: one thought failed", t.id, err);
      }
    }

    const offsetNext = offset + batch.length;
    return jsonResponse({
      processed: batch.length,
      linked,
      already_done: alreadyDone,
      offset_next: offsetNext,
      remaining: Math.max(total - offsetNext, 0),
    });
  } catch (err) {
    console.error("backfill-links failed", err);
    return jsonResponse({ error: "Something went wrong" }, 500);
  }
});
