// ============================================================================
// BACKFILL-EMBEDDINGS
// ============================================================================
// One-time catch-up job: finds thoughts that have no embedding yet, generates
// one for each, and saves it. Run it in a loop from a command window, a few
// thoughts at a time, until `remaining` reaches 0.
//
// Request:  POST { batch_size?: number, offset?: number }
// Response: { processed, embedded, failed, offset_next, remaining }
//
// HOW `offset` WORKS HERE: every thought that gets an embedding drops out of the
// "no embedding yet" list on its own, so the next batch naturally starts at the
// top again. Only thoughts that FAILED stay in that list, so offset_next skips
// past them. Otherwise one stubborn failure would be retried forever.
//
// Only your own tools may call this (it spends money). Send the service-role
// key as the Bearer token.
// ============================================================================

import { bearerToken, corsHeaders, jsonResponse } from "../_shared/http.ts";
import { isServiceRoleRequest } from "../_shared/auth.ts";

const DEFAULT_BATCH = 5;
const MAX_BATCH = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || !isServiceRoleRequest(req)) {
    return jsonResponse({ error: "Not allowed" }, 401);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batch_size) || DEFAULT_BATCH, 1), MAX_BATCH);
    const offset = Math.max(Number(body?.offset) || 0, 0);

    // The next batch of thoughts with no embedding, oldest first.
    const listRes = await fetch(
      `${supabaseUrl}/rest/v1/thoughts?select=id,content&embedding=is.null` +
        `&order=created_at.asc&limit=${batchSize}&offset=${offset}`,
      { headers: restHeaders },
    );
    if (!listRes.ok) {
      return jsonResponse({ error: "Could not read thoughts", detail: await listRes.text() }, 500);
    }
    const batch: Array<{ id: string; content: string }> = await listRes.json();

    let embedded = 0;
    let failed = 0;

    for (const t of batch) {
      try {
        const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ text: t.content }),
        });
        const { embedding } = embRes.ok ? await embRes.json() : { embedding: null };

        if (!embedding) {
          failed++;
          continue;
        }

        const saveRes = await fetch(`${supabaseUrl}/rest/v1/thoughts?id=eq.${t.id}`, {
          method: "PATCH",
          headers: { ...restHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ embedding }),
        });
        if (saveRes.ok) embedded++;
        else failed++;
      } catch (err) {
        console.error("backfill-embeddings: one thought failed", t.id, err);
        failed++;
      }
    }

    // How many thoughts still have no embedding, counted after this batch.
    const countRes = await fetch(
      `${supabaseUrl}/rest/v1/thoughts?select=id&embedding=is.null&limit=1`,
      { headers: { ...restHeaders, Prefer: "count=exact" } },
    );
    const total = Number((countRes.headers.get("content-range") ?? "").split("/")[1]) || 0;

    const offsetNext = offset + failed;
    const remaining = Math.max(total - offsetNext, 0);

    return jsonResponse({
      processed: batch.length,
      embedded,
      failed,
      offset_next: offsetNext,
      remaining,
    });
  } catch (err) {
    console.error("backfill-embeddings failed", err);
    return jsonResponse({ error: "Something went wrong" }, 500);
  }
});
