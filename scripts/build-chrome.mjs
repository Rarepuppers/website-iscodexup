import fs from "node:fs/promises";
import path from "node:path";

/*
 * Injects the shared page chrome into every page of a status site:
 *
 *   1. the <head> theme snippet (sets data-theme before first paint)
 *   2. the deferred theme.js
 *   3. the top nav, with aria-current on the page you are on
 *
 * Idempotent — re-running replaces the generated blocks rather than stacking.
 * Same shape as the snackpackuniverse.com build-* scripts.
 *
 * Why the theme snippet is inline rather than inside theme.js: theme.js is
 * deferred, so it runs after first paint. If it owned the initial choice, a
 * visitor on the light theme would get a full dark flash on every navigation.
 * The snippet is synchronous, tiny, and fails open — any exception (private
 * mode blocking localStorage) leaves the default theme rather than throwing.
 *
 * SHARED FILE — keep byte-identical with the sibling site (see FORK.md).
 * Run: node scripts/build-chrome.mjs
 */

const root = path.resolve(".");

const THEME_OPEN = "<!-- theme:generated -->";
const THEME_CLOSE = "<!-- /theme:generated -->";
const NAV_OPEN = "<!-- nav:generated -->";
const NAV_CLOSE = "<!-- /nav:generated -->";

// Status pages default to dark: that is the design the site was built in, and
// it is what an outage-panicked developer at 2am is expecting to see.
const DEFAULT_THEME = "dark";

const HEAD_BLOCK = [
  THEME_OPEN,
  "<script>",
  "  (function () {",
  "    var d = document.documentElement, t = null;",
  '    try { t = localStorage.getItem("snackpack.theme.v1"); } catch (e) {}',
  '    if (t !== "dark" && t !== "light" && t !== "cream") {',
  `      t = matchMedia("(prefers-color-scheme: light)").matches ? "cream" : "${DEFAULT_THEME}";`,
  "    }",
  '    d.setAttribute("data-theme", t);',
  `    d.setAttribute("data-theme-default", "${DEFAULT_THEME}");`,
  "  })();",
  "</script>",
  '<script defer src="theme.js"></script>',
  THEME_CLOSE,
].join("\n");

// href → label. Kept short: this bar sits above a one-word verdict and must not
// out-shout it.
const LINKS = [
  ["index.html", "Status"],
  ["history.html", "History"],
  ["badge.html", "Badge"],
  ["sponsor.html", "Sponsor"],
];

function navFor(file) {
  const items = LINKS.map(([href, label]) => {
    const current = href === file ? ' aria-current="page"' : "";
    return `        <li><a href="${href}"${current}>${label}</a></li>`;
  }).join("\n");
  return [
    NAV_OPEN,
    '    <nav aria-label="Primary">',
    '      <ul class="nav-links">',
    items,
    "      </ul>",
    "    </nav>",
    NAV_CLOSE,
  ].join("\n");
}

/**
 * Index just past the closing tag of the `.brand` element, counting nested
 * same-name tags so an inner <span class="dot"> cannot end the match early.
 * Returns -1 when there is no brand.
 */
function brandEnd(html) {
  const open = /<(span|a)\s[^>]*class="brand"[^>]*>/.exec(html);
  if (!open) return -1;
  const tag = open[1];
  const scan = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "g");
  scan.lastIndex = open.index + open[0].length;

  let depth = 1;
  let m;
  while ((m = scan.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1; // unbalanced markup — better to skip than to corrupt the page
}

const files = (await fs.readdir(root)).filter((f) => f.endsWith(".html"));

let changed = 0;

for (const file of files) {
  const full = path.join(root, file);
  let html = await fs.readFile(full, "utf8");
  const before = html;

  // --- theme block ---
  const themeRe = new RegExp(`${THEME_OPEN}[\\s\\S]*?${THEME_CLOSE}\\n?`, "g");
  if (themeRe.test(html)) {
    html = html.replace(themeRe, HEAD_BLOCK + "\n");
  } else if (html.includes("</head>")) {
    html = html.replace("</head>", HEAD_BLOCK + "\n</head>");
  } else {
    console.warn("  no </head>, theme skipped:", file);
  }

  // --- nav block ---
  const navBlock = navFor(file);
  const navRe = new RegExp(`${NAV_OPEN}[\\s\\S]*?${NAV_CLOSE}\\n?`, "g");
  if (navRe.test(html)) {
    html = html.replace(navRe, navBlock + "\n");
  } else {
    // Insert immediately after the brand, inside the existing topbar, so the
    // nav shares the header's flex row rather than creating a second bar.
    //
    // The brand is a <span> on the home page and an <a href="/"> elsewhere, and
    // BOTH contain a nested <span class="dot">. A regex cannot be used here: a
    // lazy `[\s\S]*?</span>` stops at the inner .dot's closing tag, which put
    // the whole nav *inside* the brand element and dropped it onto its own row.
    // That is exactly what happened on iscodexup's home page. Balance the tags
    // instead.
    const end = brandEnd(html);
    if (end === -1) {
      console.warn("  no .brand found, nav skipped:", file);
    } else {
      html = html.slice(0, end) + "\n" + navBlock + html.slice(end);
    }
  }

  if (html !== before) {
    await fs.writeFile(full, html);
    changed++;
  }
}

console.log(`Chrome: ${changed} of ${files.length} page(s) written.`);
