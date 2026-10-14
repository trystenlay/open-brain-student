// open-brain-mcp — lets any MCP-compatible AI (Claude Desktop today) read and
// write your brain.
//
// MCP (Model Context Protocol) is an open standard. The AI sends small JSON
// messages in a format called JSON-RPC 2.0 — { jsonrpc, id, method, params } —
// and this function answers them. The AI never touches your database directly;
// it asks this function, and this function decides what to hand back.
//
// The checks run in a deliberate order:
//   1. Access key — the Authorization header must be "Bearer <MCP_ACCESS_KEY>".
//   2. Owner      — every query is limited to OWNER_USER_ID.
//   3. Only then is the database touched.
//
// Tools the AI gets:
//   search_thoughts  — find thoughts by MEANING (falls back to matching words)
//   list_recent      — your newest thoughts
//   get_thought      — one thought, full length
//   add_thought      — save a new thought
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MCP_ACCESS_KEY, OWNER_USER_ID
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

// Whole YouTube transcripts and articles live in `content`. Ten of those at full
// length could be hundreds of thousands of characters and drown the AI's memory
// for the conversation, so lists show a preview and get_thought shows the rest.
const PREVIEW_CHARS = 500;
const SEARCH_LIMIT = 10;
const RECENT_DEFAULT = 10;
const RECENT_MAX = 50;

// CORS headers — the browser's permission slip. Claude Desktop does not need
// them, but browser-based MCP clients do, and they cost nothing.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
};

// ---------------------------------------------------------------------------
// The tool menu. tools/list sends this to the AI so it knows what it can ask
// for. The descriptions matter: the AI reads them to decide when to use each.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's personal knowledge base (their 'brain': notes, YouTube transcripts, articles, " +
      "Telegram messages) by meaning AND exact words together, so related ideas are found even when the words " +
      "differ, and exact names or numbers are found too. Searches inside long captures. Returns up to 10 " +
      "matches, best first, each followed by the thoughts it is connected to, with long content shortened — " +
      "call get_thought with an id to read one in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in your own words, e.g. 'how to get new clients' or 'new york open'." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the user's most recently saved thoughts, newest first, with long content shortened.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: `How many to return (default ${RECENT_DEFAULT}, max ${RECENT_MAX}).` },
      },
    },
  },
  {
    name: "get_thought",
    description: "Get one thought's full, untruncated content by its id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The thought's id, as shown by search_thoughts or list_recent." },
      },
      required: ["id"],
    },
  },
  {
    name: "add_thought",
    description: "Save a new thought to the user's brain. Only do this when the user asks you to save something.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text to save." },
      },
      required: ["content"],
    },
  },
];

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type Thought = { id: string; content: string; created_at: string };

Deno.serve(async (req) => {
  // Browsers ask "may I?" with an OPTIONS request before the real one.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 1. ACCESS KEY — before anything else. If the secret was never set, refuse
  //    everything rather than letting anyone in ("fail closed", never open).
  const accessKey = (Deno.env.get("MCP_ACCESS_KEY") ?? "").trim();
  if (!accessKey) {
    console.error("open-brain-mcp: MCP_ACCESS_KEY secret is not set");
    return new Response("Server not configured", { status: 500, headers: corsHeaders });
  }
  const sent = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!sameSecret(sent, accessKey)) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  // MCP messages always arrive as POST. Anything else (for example a GET from a
  // client checking for a live event stream) gets a polite "not here".
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { ...corsHeaders, Allow: "POST, OPTIONS" } });
  }

  let message: JsonRpcRequest;
  try {
    message = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error: body is not valid JSON");
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
    return rpcError(null, -32600, "Invalid request");
  }

  const id = message.id ?? null;
  const method = message.method;

  // ---------------------------------------------------------------------------
  // The MCP handshake. Claude Desktop (through mcp-remote) sends these in order:
  //   initialize → notifications/initialized → tools/list → tools/call …
  // Skip any one of them and the connection fails, even if tools/list works.
  // ---------------------------------------------------------------------------

  // "Hello — who are you and what can you do?"
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "open-brain", version: "1.0.0" },
    });
  }

  // Notifications are one-way announcements: no id, no answer expected.
  if (method.startsWith("notifications/")) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // "Are you still there?"
  if (method === "ping") {
    return rpcResult(id, {});
  }

  // "What tools do you have?"
  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  // "Run this tool with these arguments."
  if (method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await callTool(name, args);
      return rpcResult(id, { content: [{ type: "text", text }] });
    } catch (err) {
      // Tool problems go back to the AI as a readable message (isError), so it
      // can tell you what went wrong instead of the connection breaking.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`open-brain-mcp: ${name} failed`, err);
      return rpcResult(id, { content: [{ type: "text", text: msg }], isError: true });
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
});

// ---------------------------------------------------------------------------
// The tools themselves.
// ---------------------------------------------------------------------------
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!TOOLS.some((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);

  // 2. OWNER. Without it there is no safe way to answer, so stop here.
  const ownerUserId = (Deno.env.get("OWNER_USER_ID") ?? "").trim();
  if (!ownerUserId) {
    throw new Error("This brain is not finished setting up: OWNER_USER_ID is missing");
  }

  // 3. DATABASE. The service role key skips Row Level Security entirely, so
  //    every query below filters by your user id by hand, and the insert sets
  //    it — otherwise rows would save with no owner and vanish from your app.
  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  if (name === "search_thoughts") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("search_thoughts needs a query, e.g. { \"query\": \"trading\" }");
    // 1. BY MEANING. Turn the question into an embedding, then ask the database for
    //    the thoughts whose embeddings sit closest to it. The service key is the
    //    proof generate-embedding needs that one of our own functions is asking.
    try {
      const embRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-embedding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ text: query }),
      });
      const { embedding } = embRes.ok ? await embRes.json() : { embedding: null };

      {
        // HYBRID: send the words AND the embedding. The database ranks by meaning
        // and by exact keywords, fuses the two lists, and also checks each
        // document's chunks. p_user_id is required: this server uses the service
        // key, which skips row-level security, so it must filter by owner itself.
        const { data: matches, error: rpcError } = await db.rpc("search_thoughts", {
          query_text: query,
          p_user_id: ownerUserId,
          ...(embedding ? { query_embedding: embedding } : {}),
          match_threshold: 0.3,
          match_count: SEARCH_LIMIT,
        });
        if (rpcError) {
          console.error("hybrid search failed, using plain keyword search", rpcError.message);
        } else if (matches && matches.length) {
          // Pull in what each result is connected to. Never let this break search.
          let linkMap = new Map<string, LinkedThought[]>();
          try {
            linkMap = await fetchLinked(db, ownerUserId, matches.map((m: { id: string }) => m.id));
          } catch (err) {
            console.error("could not load linked thoughts", err);
          }
          return formatSemantic(`Best matches for "${query}" (by meaning and exact words):`, matches, linkMap);
        }
      }
    } catch (err) {
      console.error("semantic search unavailable, using keyword search", err);
    }

    // 2. BY WORDS. The fallback: the original keyword match. Treat % and _ as
    //    ordinary characters, not wildcards (same as the app).
    const pattern = "%" + query.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const { data, error } = await db
      .from("thoughts")
      .select("id, content, created_at")
      .eq("user_id", ownerUserId)
      .ilike("content", pattern)
      .order("created_at", { ascending: false })
      .limit(SEARCH_LIMIT);
    if (error) throw new Error("Search failed: " + error.message);
    return data.length ? formatList(`Thoughts matching "${query}":`, data) : `Nothing in the brain matched "${query}".`;
  }

  if (name === "list_recent") {
    const asked = Number(args.limit ?? RECENT_DEFAULT);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), RECENT_MAX) : RECENT_DEFAULT;
    const { data, error } = await db
      .from("thoughts")
      .select("id, content, created_at")
      .eq("user_id", ownerUserId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error("Could not load recent thoughts: " + error.message);
    return data.length ? formatList(`The ${data.length} most recent thoughts:`, data) : "The brain is empty so far.";
  }

  if (name === "get_thought") {
    const thoughtId = typeof args.id === "string" ? args.id.trim() : "";
    // Ids are UUIDs. Checking the shape first turns a garbled id into a clean
    // "not found" instead of a database error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thoughtId)) {
      return `No thought found with id "${thoughtId}".`;
    }
    const { data, error } = await db
      .from("thoughts")
      .select("id, content, created_at")
      .eq("user_id", ownerUserId) // someone else's id → "not found"
      .eq("id", thoughtId)
      .maybeSingle();
    if (error) throw new Error("Could not load thought: " + error.message);
    if (!data) return `No thought found with id "${thoughtId}".`;
    return `id: ${data.id}\nsaved: ${data.created_at}\n\n${data.content}`;
  }

  // add_thought
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) throw new Error("add_thought needs some content to save.");
  const { data, error } = await db
    .from("thoughts")
    .upsert({ content, user_id: ownerUserId, source: "mcp" }, { onConflict: "dedup_key,user_id", ignoreDuplicates: false })
    .select("id, content, created_at")
    .single();
  if (error) throw new Error("Could not save: " + error.message);
  return `Saved to the brain.\nid: ${data.id}\nsaved: ${data.created_at}\n\n${data.content}`;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
type LinkedThought = { id: string; content: string; similarity: number };
const LINKED_PER_RESULT = 3;
const LINKED_PREVIEW_CHARS = 160;

// For each thought id, the thoughts it is linked to: strongest first, never
// repeating something that is already a top-level result.
async function fetchLinked(
  db: ReturnType<typeof createClient>,
  ownerUserId: string,
  ids: string[],
): Promise<Map<string, LinkedThought[]>> {
  const out = new Map<string, LinkedThought[]>();
  if (!ids.length) return out;

  const list = ids.join(",");
  const { data: links, error } = await db
    .from("thought_links")
    .select("source_thought_id, target_thought_id, similarity_score")
    .eq("user_id", ownerUserId)
    .or(`source_thought_id.in.(${list}),target_thought_id.in.(${list})`);
  if (error || !links?.length) return out;

  const inResults = new Set(ids);
  const pairs: { from: string; to: string; similarity: number }[] = [];
  for (const l of links) {
    if (inResults.has(l.source_thought_id) && !inResults.has(l.target_thought_id)) {
      pairs.push({ from: l.source_thought_id, to: l.target_thought_id, similarity: l.similarity_score });
    }
    if (inResults.has(l.target_thought_id) && !inResults.has(l.source_thought_id)) {
      pairs.push({ from: l.target_thought_id, to: l.source_thought_id, similarity: l.similarity_score });
    }
  }
  if (!pairs.length) return out;

  const neighborIds = [...new Set(pairs.map((p) => p.to))];
  const { data: neighbors } = await db
    .from("thoughts")
    .select("id, content")
    .eq("user_id", ownerUserId)
    .in("id", neighborIds);
  const byId = new Map((neighbors ?? []).map((n: { id: string; content: string }) => [n.id, n.content]));

  pairs.sort((a, b) => b.similarity - a.similarity);
  for (const p of pairs) {
    const content = byId.get(p.to);
    if (!content) continue;
    const arr = out.get(p.from) ?? [];
    if (arr.length < LINKED_PER_RESULT && !arr.some((x) => x.id === p.to)) {
      arr.push({ id: p.to, content, similarity: p.similarity });
      out.set(p.from, arr);
    }
  }
  return out;
}

function formatSemantic(
  heading: string,
  rows: {
    id: string;
    content: string;
    created_at: string;
    similarity: number;
    matched_chunk?: string | null;
  }[],
  linkMap: Map<string, LinkedThought[]> = new Map(),
) {
  const items = rows.map((row, i) => {
    // When the match came from INSIDE a long capture, show the passage that
    // matched, since the opening of a transcript is usually not why it matched.
    const fromChunk = typeof row.matched_chunk === "string" && row.matched_chunk.length > 0;
    const source = fromChunk ? (row.matched_chunk as string) : row.content;
    const body = source.length > PREVIEW_CHARS
      ? source.slice(0, PREVIEW_CHARS) + "… [truncated — use get_thought for the full text]"
      : source;
    const content = fromChunk ? `(from partway through a longer capture)\n   ${body}` : body;
    const pct = row.similarity > 0 ? `${Math.round(row.similarity * 100)}%` : "keyword match";
    const linked = (linkMap.get(row.id) ?? []).map((l) => {
      const preview = l.content.length > LINKED_PREVIEW_CHARS
        ? l.content.slice(0, LINKED_PREVIEW_CHARS) + "…"
        : l.content;
      return `      ↳ linked (${Math.round(l.similarity * 100)}%) id: ${l.id}\n        ${preview}`;
    });
    const linkedBlock = linked.length ? `\n   Connected to:\n${linked.join("\n")}` : "";
    return `${i + 1}. id: ${row.id}\n   match: ${pct}   saved: ${row.created_at}\n   ${content}${linkedBlock}`;
  });
  return heading + "\n\n" + items.join("\n\n");
}

function formatList(heading: string, rows: Thought[]) {
  const items = rows.map((row, i) => {
    const content = row.content.length > PREVIEW_CHARS
      ? row.content.slice(0, PREVIEW_CHARS) + "… [truncated — use get_thought for the full text]"
      : row.content;
    return `${i + 1}. id: ${row.id}\n   saved: ${row.created_at}\n   ${content}`;
  });
  return heading + "\n\n" + items.join("\n\n");
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Compares every character, even after a mismatch, so an attacker cannot learn
// how much of a guessed key was right from how long the answer took.
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
