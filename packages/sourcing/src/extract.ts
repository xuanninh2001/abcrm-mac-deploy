import * as cheerio from "cheerio";

export type ExtractedPage = {
  title: string;
  text: string;                                   // normalized visible text, capped
  links: { url: string; text: string }[];         // same-site links only
  scripts: string[];                              // script src URLs (for tech signals)
  inline: string;                                 // concatenated inline scripts + form actions + iframes (capped)
};

const MAX_TEXT = 200_000;
/** Inline styles that hide text from visitors (display/visibility, zero size, zero opacity, off-screen). */
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d])|(?:left|top|text-indent)\s*:\s*-\d{4,}px/i;

export function extractHtml(html: string, pageUrl: URL, sameSite: (u: URL) => boolean): ExtractedPage {
  const $ = cheerio.load(html);
  const scripts = $("script[src]").map((_, el) => $(el).attr("src") ?? "").get().filter(Boolean)
    .map((src) => { try { return new URL(src, pageUrl).toString(); } catch { return src; } });
  const inline = [
    $("script:not([src])").map((_, el) => $(el).html() ?? "").get().join("\n"),
    $("form[action]").map((_, el) => $(el).attr("action")).get().join("\n"),
    $("iframe[src]").map((_, el) => $(el).attr("src")).get().join("\n"),
  ].join("\n").slice(0, MAX_TEXT);

  const links: ExtractedPage["links"] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    try {
      const u = new URL($(el).attr("href")!, pageUrl);
      u.hash = "";
      if (!/^https?:$/.test(u.protocol) || !sameSite(u) || seen.has(u.toString())) return;
      seen.add(u.toString());
      links.push({ url: u.toString(), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 120) });
    } catch { /* ignore malformed hrefs */ }
  });

  $("script, style, noscript, svg, template, iframe").remove();
  // Text a visitor cannot see is a common place for prompt injection ("ignore previous instructions…") and is not
  // evidence a rep could check on the page: drop it before the text reaches S1/Q1 or becomes a quotable snippet.
  $("[hidden], [aria-hidden='true'], input[type='hidden']").remove();
  $("[style]").filter((_, el) => HIDDEN_STYLE.test($(el).attr("style") ?? "")).remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 300);
  // Block elements become line breaks so sentences from different blocks don't merge.
  $("p, div, li, h1, h2, h3, h4, h5, h6, br, tr, section, article").each((_, el) => { $(el).append("\n"); });
  const text = $("body").text().replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, MAX_TEXT);
  return { title, text, links: links.slice(0, 300), scripts: scripts.slice(0, 200), inline };
}
