// Dynamic XML sitemap for crawlers and AI search engines.
// Why: no sitemap existed — crawlers couldn't discover /feeds/ pages or specs.

import type { Env } from "./_shared/types";
import { getFeedIndex } from "./_shared/feeds/store";

const STATIC_URLS: { loc: string; priority: string; changefreq: string }[] = [
  { loc: "https://diffdelta.io/", priority: "1.0", changefreq: "weekly" },
  { loc: "https://diffdelta.io/feeds/", priority: "0.8", changefreq: "daily" },
  { loc: "https://diffdelta.io/docs/spec/diffdelta-feed-spec", priority: "0.7", changefreq: "monthly" },
  { loc: "https://diffdelta.io/docs/spec/self-capsule-v0", priority: "0.7", changefreq: "monthly" },
  { loc: "https://diffdelta.io/self", priority: "0.6", changefreq: "monthly" },
  { loc: "https://diffdelta.io/llms.txt", priority: "0.5", changefreq: "monthly" },
];

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env } = context;

  let feedEntries: { loc: string; lastmod?: string; priority: string }[] = [];
  try {
    const feeds = await getFeedIndex(env, undefined, 500);
    feedEntries = feeds.map((f) => ({
      loc: `https://diffdelta.io/feeds/${escXml(f.source_id)}/`,
      lastmod: f.updated_at ? f.updated_at.slice(0, 10) : undefined,
      priority: "0.6",
    }));
  } catch {
    // KV unavailable — serve static-only sitemap
  }

  const urls = [
    ...STATIC_URLS.map((u) => `  <url>
    <loc>${escXml(u.loc)}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`),
    ...feedEntries.map((u) => `  <url>
    <loc>${escXml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${escXml(u.lastmod)}</lastmod>` : ""}
    <changefreq>daily</changefreq>
    <priority>${u.priority}</priority>
  </url>`),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
};
