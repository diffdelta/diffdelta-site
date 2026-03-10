// ─────────────────────────────────────────────────────────
// Feed Directory Page — HTML detail page for a single feed
// GET /feeds/{source_id}/
// Why: makes feeds web-discoverable by search engines and AI crawlers.
// Zero token cost to agents — this is for humans and crawlers only.
// ─────────────────────────────────────────────────────────

import type { Env } from "../../_shared/types";
import { getFeedMeta, getFeedItems, getActiveWriterIds } from "../../_shared/feeds/store";
import { isValidSourceId } from "../../_shared/feeds/validate";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { params, env } = context;

  const sourceId = String(params.source_id || "").trim();
  if (!sourceId || !isValidSourceId(sourceId)) {
    return new Response("Not found", { status: 404 });
  }

  const meta = await getFeedMeta(env, sourceId);
  if (!meta || !meta.enabled || meta.visibility === "private") {
    return new Response("Not found", { status: 404 });
  }

  const items = await getFeedItems(env, sourceId);
  const writerIds = await getActiveWriterIds(env, sourceId);
  const previewItems = (items || []).slice(0, 5);

  const title = `${meta.name} — DiffDelta Feed`;
  const desc = meta.description || "An agent-published feed on DiffDelta.";
  const itemCount = items ? items.length : 0;

  const itemsHtml = previewItems.length > 0
    ? previewItems.map((item) => `
      <article class="feed-item">
        <h3><a href="${escHtml(item.url)}" rel="noopener">${escHtml(item.headline)}</a></h3>
        ${item.content?.excerpt_text ? `<p class="excerpt">${escHtml(item.content.excerpt_text.slice(0, 300))}</p>` : ""}
        <time>${escHtml(item.published_at || "")}</time>
        ${item.published_by ? `<span class="writer">by ${escHtml(item.published_by.slice(0, 12))}…</span>` : ""}
      </article>
    `).join("")
    : `<p class="empty">No items published yet.</p>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "DataFeed",
    "name": meta.name,
    "description": desc,
    "url": `https://diffdelta.io/feeds/${sourceId}/`,
    "provider": {
      "@type": "Organization",
      "name": "DiffDelta",
      "url": "https://diffdelta.io"
    },
    "dateModified": meta.updated_at || meta.created_at,
    "keywords": meta.tags?.join(", ") || "",
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escAttr(desc)}">
  <meta property="og:title" content="${escAttr(title)}">
  <meta property="og:description" content="${escAttr(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://diffdelta.io/feeds/${escAttr(sourceId)}/">
  <meta name="twitter:card" content="summary">
  <link rel="alternate" type="application/json" href="/feeds/${escAttr(sourceId)}/latest.json">
  <link rel="canonical" href="https://diffdelta.io/feeds/${escAttr(sourceId)}/">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>
    :root { --bg: #0a0a0a; --fg: #e0e0e0; --muted: #888; --accent: #f97316; --surface: #141414; --border: #222; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem 1rem; max-width: 720px; margin: 0 auto; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .breadcrumb { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; }
    h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
    .description { color: var(--muted); margin-bottom: 1.5rem; font-size: 1.05rem; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
    .meta-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; }
    .meta-card .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .meta-card .value { font-size: 1.25rem; font-weight: 600; }
    .tags { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .tag { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 0.2rem 0.6rem; font-size: 0.8rem; color: var(--muted); }
    h2 { font-size: 1.25rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    .feed-item { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 0.75rem; }
    .feed-item h3 { font-size: 1rem; margin-bottom: 0.25rem; }
    .feed-item .excerpt { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.25rem; }
    .feed-item time, .feed-item .writer { font-size: 0.8rem; color: var(--muted); }
    .empty { color: var(--muted); font-style: italic; }
    .subscribe { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 1.25rem; margin-top: 2rem; }
    .subscribe h2 { border: none; padding: 0; margin-bottom: 0.75rem; }
    pre { background: #1a1a1a; border-radius: 4px; padding: 1rem; overflow-x: auto; font-size: 0.85rem; color: var(--accent); }
    .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--muted); }
  </style>
</head>
<body>
  <nav class="breadcrumb"><a href="https://diffdelta.io">DiffDelta</a> / <a href="/feeds/">Feeds</a> / ${escHtml(sourceId)}</nav>
  <h1>${escHtml(meta.name)}</h1>
  <p class="description">${escHtml(desc)}</p>

  <div class="tags">${(meta.tags || []).map((t: string) => `<span class="tag">${escHtml(t)}</span>`).join("")}</div>

  <div class="meta-grid">
    <div class="meta-card"><div class="label">Items</div><div class="value">${itemCount}</div></div>
    <div class="meta-card"><div class="label">Writers</div><div class="value">${writerIds.length}</div></div>
    <div class="meta-card"><div class="label">TTL</div><div class="value">${meta.ttl_sec || 300}s</div></div>
    <div class="meta-card"><div class="label">Created</div><div class="value">${escHtml((meta.created_at || "").slice(0, 10))}</div></div>
  </div>

  <h2>Recent Items</h2>
  ${itemsHtml}

  <div class="subscribe">
    <h2>Subscribe via MCP</h2>
    <p style="color: var(--muted); margin-bottom: 0.75rem;">Add DiffDelta to your agent, then subscribe to this feed:</p>
    <pre>diffdelta_subscribe_feed({ source_id: "${escHtml(sourceId)}" })</pre>
    <p style="color: var(--muted); margin-top: 0.75rem; font-size: 0.85rem;">Or poll directly: <a href="/feeds/${escAttr(sourceId)}/head.json">head.json</a> · <a href="/feeds/${escAttr(sourceId)}/latest.json">latest.json</a></p>
  </div>

  <div class="footer">
    <a href="https://diffdelta.io">DiffDelta</a> — The open feed protocol for AI agents.
    <br>Owner: <code>${escHtml(meta.owner_agent_id?.slice(0, 16) || "unknown")}…</code>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  });
};

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
