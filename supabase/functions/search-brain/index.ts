// ============================================================================
// SEARCH-BRAIN  (your own app's Search tab calls this)
// ============================================================================
// The browser cannot run hybrid search itself: it needs an embedding of the
// search phrase, and generating one needs a secret key that can never sit
// inside a web page. So the app asks this function, and this function does it.
//
//   1. WHO IS ASKING comes from their login token, never from the request
//      body. A browser could put any user id in a body.
//   2. The query is embedded (meaning) and sent along with the raw words
//      (keywords). search_thoughts fuses the two and also looks inside chunks.
//   3. If the embedding fails for any reason, the search still runs on keywords
//      alone. A failed embedding is a weaker search, not an error.
//
// The database call uses the service key, because thought_chunks has row-level
// security with no policies on purpose. Safety comes from p_user_id, set here to
// the verified caller's own id.
// ============================================================================

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, corsHeaders, jsonResponse } from "../_shared/http.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "POST only" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // 1. Who is asking? Read from their login token.
    const { data: { user }, error: authError } = await admin.auth.getUser(bearerToken(req));
    if (authError || !user) return jsonResponse({ ok: false, error: "Not signed in" }, 401);

    const { query, limit } = await req.json();
    const q = typeof query === "string" ? query.trim() : "";
    if (!q) return jsonResponse({ ok: false, error: "A query is required" }, 400);
    const n = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);

    // 2. The meaning half. Failure just means keyword-only.
    let embedding: number[] | null = null;
    try {
      const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ text: q }),
      });
      if (embRes.ok) embedding = (await embRes.json()).embedding ?? null;
    } catch (err) {
      console.error("[search-brain] embedding failed, keyword-only", err);
    }

    const { data, error } = await admin.rpc("search_thoughts", {
      query_text: q,
      p_user_id: user.id,
      ...(embedding ? { query_embedding: embedding } : {}),
      match_threshold: 0.3,
      match_count: n,
    });

    if (!error) {
      return jsonResponse({ ok: true, mode: embedding ? "hybrid" : "keyword", results: data ?? [] });
    }

    // Last resort: the plain keyword match the app used before this level.
    console.error("[search-brain] hybrid failed, plain keyword fallback", error.message);
    const pattern = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const { data: plain, error: plainError } = await admin
      .from("thoughts")
      .select("id, content, created_at")
      .eq("user_id", user.id)
      .ilike("content", pattern)
      .order("created_at", { ascending: false })
      .limit(n);
    if (plainError) return jsonResponse({ ok: false, error: "Search failed: " + plainError.message }, 500);
    return jsonResponse({ ok: true, mode: "plain", results: plain ?? [] });
  } catch (err) {
    console.error("[search-brain] failed", err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
