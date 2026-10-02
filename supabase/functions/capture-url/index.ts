// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste an article link in the app; this function fetches the page, pulls out
// the readable text, and saves it to your brain.
//
// WHY THIS RUNS ON THE SERVER: a web browser is not allowed to fetch pages from
// other websites (that rule is called CORS). A server has no such limit. So the
// app hands the link to this function, and this function does the fetching.
//
// No AI summary yet — that needs an AI key, which arrives in Level 5. Until
// then the full text is saved, so it is still searchable.
// ============================================================================

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decodeEntities } from "../_shared/text.ts";

const MAX_BYTES = 3_000_000; // don't try to swallow a 50MB page

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Who is asking? Read from their login token — never from the request
    // body, or anyone could write into anyone else's brain.
    const { data: { user }, error: authError } = await admin.auth.getUser(bearerToken(req));
    if (authError || !user) return jsonResponse({ ok: false, error: "Not signed in" }, 401);

    const { url } = await req.json();
    if (!url || typeof url !== "string") return jsonResponse({ ok: false, error: "A url is required" }, 400);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return jsonResponse({ ok: false, error: "That is not a valid web address" }, 400);
    }
    // Only public http(s) pages — stops the server being pointed at internal addresses.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return jsonResponse({ ok: false, error: "Only http and https links are supported" }, 400);
    }
    if (isPrivateHost(parsed.hostname)) {
      return jsonResponse({ ok: false, error: "That address is not a public web page" }, 400);
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
      }, 422);
    }

    const contentType = pageRes.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(";")[0] || "file"}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415);
    }
    if (Number(pageRes.headers.get("content-length") ?? 0) > MAX_BYTES) {
      return jsonResponse({ ok: false, error: "That page is too large to process" }, 413);
    }

    const raw = await pageRes.text();
    if (raw.length > MAX_BYTES) return jsonResponse({ ok: false, error: "That page is too large to process" }, 413);

    const { title, text } = htmlToText(raw);
    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          "Almost no readable text was found. The page probably builds itself with JavaScript " +
          "after loading, which a server cannot see. Use \"paste the text yourself\" instead.",
      }, 422);
    }

    // Same format the app's own URL tab has always used.
    const content = `🔗 URL: ${title}\n${parsed.toString()}\n\n${text}`;

    const { data: thought, error: saveErr } = await admin.from("thoughts").insert({
      user_id: user.id,
      content,
      source: "url",
      metadata: { title, url: parsed.toString() },
    }).select("id").single();
    if (saveErr || !thought) {
      console.error("[url] save failed", saveErr);
      return jsonResponse({ ok: false, error: "Could not save: " + (saveErr?.message ?? "unknown") }, 500);
    }

    // The full text, kept separately. Non-fatal: the thought is already saved.
    const { error: srcErr } = await admin.from("thought_sources").insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: "web",
      char_count: text.length,
      truncated: false,
    });
    if (srcErr) console.error("[url] source text not saved (thought is saved)", srcErr);

    return jsonResponse({ ok: true, title, hostname: parsed.hostname, chars: text.length });
  } catch (err) {
    console.error("[url] Failed:", err);
    const msg = String(err).includes("timeout") ? "That page took too long to respond." : String(err);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80"); // IPv6
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// ---------------------------------------------------------------------------
// HTML -> readable text. Deliberately simple, no library: strip the machinery
// (scripts, styles, navigation, footers), then remove the remaining tags.
// ---------------------------------------------------------------------------
function htmlToText(html: string): { title: string; text: string } {
  // Title first, before we destroy the markup
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() || "Untitled page" : "Untitled page";

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const body = articleMatch ? articleMatch[1] : html;

  const text = body
    // Remove entire elements that never contain article content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    // Keep paragraph and heading breaks as newlines so structure survives
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Everything else goes
    .replace(/<[^>]+>/g, " ");

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return { title, text: cleaned };
}
