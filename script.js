// Shared status script — identical file on isclaudeup.com and iscodexup.com.
// Reads the official Statuspage API live (CORS is open: Access-Control-Allow-Origin: *).
// Product-specific values (status URL, copy, art, quotes) live in config.js → window.SITE.
//
// KEEP THE TWO COPIES IN SYNC. These files previously drifted apart and the older
// copy shipped a silently-broken component filter for months — see FORK.md.

const STATUS_URL = SITE.statusUrl;

const els = {
  body: document.body,
  verdict: document.getElementById("verdict"),
  subline: document.getElementById("subline"),
  components: document.getElementById("components"),
  updated: document.getElementById("updated"),
  smash: document.getElementById("smash"),
  quote: document.getElementById("quote"),
  mascot: document.getElementById("mascot-img"),
  smashImg: document.getElementById("smash-img"),
};

const ROBOTS = SITE.robots;
// Button: default (resting) until status is known, then green (up) / red (down).
const DEFAULT_BUTTON = SITE.buttons.default;
const BUTTONS = {
  up: SITE.buttons.up,
  degraded: DEFAULT_BUTTON, // intermittent: keep the neutral button
  down: SITE.buttons.down,
};
// Warm the cache for the other states so swaps are instant
[...Object.values(ROBOTS), ...Object.values(BUTTONS), DEFAULT_BUTTON].forEach((src) => {
  const i = new Image();
  i.src = src;
});

// ---------- THE VERDICT ----------
// Two signals feed the verdict, and we surface the WORST of them:
//   1. Page-level indicator: "none" | "minor" | "major" | "critical"
//   2. Per-component status:  "operational" | "degraded_performance" |
//      "partial_outage" | "major_outage" | "under_maintenance"
// Vendors sometimes flag a single component (e.g. degraded/partial) while the
// page-level indicator still reads "none" during an intermittent blip — reading
// only the indicator would miss it, so we also scan the components themselves.
const STATE_RANK = { up: 0, degraded: 1, down: 2 };

function stateFromComponentStatus(status) {
  const s = String(status || "operational").toLowerCase();
  if (s === "major_outage" || s === "partial_outage") return "down";
  if (s === "degraded_performance" || s === "under_maintenance") return "degraded";
  return "up";
}

function stateFromPageIndicator(indicator) {
  if (indicator === "none") return "up";
  if (indicator === "minor") return "degraded";
  return "down"; // major | critical
}

function worstState(a, b) {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

// Never escalate past `cap` (used so a vendor-wide incident that misses our
// scoped components reads KINDA rather than a flat NO).
function capState(state, cap) {
  return STATE_RANK[state] > STATE_RANK[cap] ? cap : state;
}

function worstOf(comps) {
  return comps.reduce((worst, c) => worstState(worst, stateFromComponentStatus(c.status)), "up");
}

// Some feeds list the same component name under two different groups (OpenAI ships
// two separate "Login" rows). Collapse by name, keeping the worst status of each.
function dedupeByName(comps) {
  const seen = new Map();
  comps.forEach((c) => {
    const key = (c.name || "").toLowerCase();
    const prev = seen.get(key);
    if (!prev || STATE_RANK[stateFromComponentStatus(c.status)] > STATE_RANK[stateFromComponentStatus(prev.status)]) {
      seen.set(key, c);
    }
  });
  return [...seen.values()];
}

// Narrow the feed to the components this site actually cares about.
//
// FAIL LOUD, NOT SILENT: if `include` is set but matches nothing (a vendor renamed
// or retired a component — this HAS happened), fall back to the full list rather
// than rendering an empty breakdown and a verdict computed from nothing.
function scopeComponents(data) {
  const all = dedupeByName((data.components || []).filter((c) => !c.group));
  const cfg = SITE.components || {};
  const want = (Array.isArray(cfg.include) ? cfg.include : []).map((s) => s.toLowerCase());
  if (!want.length) return { list: all, scoped: false };

  const matched = all.filter((c) => want.includes((c.name || "").toLowerCase()));
  if (!matched.length) {
    console.warn(
      "[status] SITE.components.include matched NOTHING in the live feed — falling back to the full list. " +
        "Update config.js. Names currently published:",
      all.map((c) => c.name)
    );
    return { list: all, scoped: false };
  }
  // Warn about individual names that no longer exist, even when some still match.
  const have = new Set(all.map((c) => (c.name || "").toLowerCase()));
  const missing = want.filter((n) => !have.has(n));
  if (missing.length) {
    console.warn("[status] SITE.components.include names not present in the feed:", missing);
  }
  return { list: matched, scoped: true };
}

function render(data) {
  const { list: comps, scoped } = scopeComponents(data);

  const componentState = worstOf(comps);
  let indicatorState = stateFromPageIndicator(data?.status?.indicator || "none");

  // When we're scoped to a subset, a vendor-wide incident that doesn't touch any of
  // OUR components shouldn't slam the verdict to NO — but it shouldn't be hidden
  // either. Cap it at "degraded" so the page says KINDA and explains why.
  const broadOnly = scoped && indicatorState === "down" && componentState === "up";
  if (scoped) indicatorState = capState(indicatorState, "degraded");

  const state = worstState(componentState, indicatorState);

  // Components not fully operational — used to name names in the subline.
  const affected = comps
    .filter((c) => stateFromComponentStatus(c.status) !== "up")
    .map((c) => c.name);

  let verdict, subline;
  if (state === "up") {
    verdict = SITE.copy.up.verdict;
    subline = pickSubline(SITE.copy.up);
  } else if (state === "degraded") {
    verdict = SITE.copy.degraded.verdict;
    subline = broadOnly
      ? `${SITE.product} components look fine, but ${SITE.vendor || "the vendor"} is reporting a wider incident.`
      : affected.length
      ? `Some services are degraded: ${affected.join(", ")}.`
      : data.status.description || pickSubline(SITE.copy.degraded);
  } else {
    verdict = SITE.copy.down.verdict;
    subline = affected.length
      ? `Services reporting problems: ${affected.join(", ")}.`
      : data.status.description || pickSubline(SITE.copy.down);
  }

  els.body.dataset.state = state;
  els.verdict.textContent = verdict;
  els.subline.textContent = subline;
  if (els.mascot && els.mascot.getAttribute("src") !== ROBOTS[state]) {
    els.mascot.src = ROBOTS[state];
  }
  if (els.smashImg && els.smashImg.getAttribute("src") !== BUTTONS[state]) {
    els.smashImg.src = BUTTONS[state];
  }

  // Component breakdown
  els.components.innerHTML = "";
  const cfg = SITE.components || {};
  const list = cfg.limit > 0 ? comps.slice(0, cfg.limit) : comps;
  list.forEach((c) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = c.name;
    const pill = document.createElement("span");
    pill.className = "pill " + c.status;
    pill.textContent = (c.status || "unknown").replace(/_/g, " ");
    li.append(name, pill);
    els.components.appendChild(li);
  });

  els.updated.textContent = new Date().toLocaleTimeString();
}

// Pick a random subline from a copy state's `sublines` array, falling back to its
// single `subline` string. Used for up/degraded/down so every verdict gets variety.
function pickSubline(copyState) {
  const arr = copyState && copyState.sublines;
  return arr && arr.length
    ? arr[Math.floor(Math.random() * arr.length)]
    : (copyState && copyState.subline) || "";
}

async function checkStatus() {
  try {
    const res = await fetch(STATUS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("bad response " + res.status);
    render(await res.json());
  } catch (err) {
    // If the official page is itself unreachable, that's usually... a sign.
    els.body.dataset.state = "down";
    els.verdict.textContent = "?";
    els.subline.textContent = SITE.copy.unreachable;
    els.updated.textContent = new Date().toLocaleTimeString();
  }
}

// ---------- SMASH BUTTON + QUOTES ----------
const quotes = SITE.quotes;

let lastQuote = -1;
function smash() {
  // never repeat the same quote twice in a row
  let i;
  do { i = Math.floor(Math.random() * quotes.length); } while (i === lastQuote);
  lastQuote = i;

  els.quote.classList.remove("show");
  // force reflow so the fade re-triggers
  void els.quote.offsetWidth;
  els.quote.textContent = quotes[i];
  els.quote.classList.add("show");

  els.smash.classList.remove("pop");
  void els.smash.offsetWidth;
  els.smash.classList.add("pop");

  checkStatus();   // every smash re-checks for real
}

els.smash.addEventListener("click", smash);

// ---------- SHARE ----------
// The growth loop for this site is someone pasting the link into Slack/X during an
// outage. Make that one tap. Uses the native share sheet on mobile, clipboard on desktop.
(() => {
  const btn = document.getElementById("share");
  if (!btn) return;
  const label = btn.querySelector(".share-label");
  const original = label ? label.textContent : "";

  function shareText() {
    const state = els.body.dataset.state;
    const name = SITE.product;
    if (state === "down") return `${name} is down right now — live status:`;
    if (state === "degraded") return `${name} is having a moment — live status:`;
    return `${name} status, at a glance:`;
  }

  function flash(msg) {
    if (!label) return;
    label.textContent = msg;
    setTimeout(() => { label.textContent = original; }, 1800);
  }

  btn.addEventListener("click", async () => {
    const url = location.origin + "/";
    const text = shareText();
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, text, url });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // user dismissed the sheet
      }
    }
    // navigator.clipboard needs a secure context AND transient user activation, and
    // still refuses in some embedded/permission-restricted views. Fall back to the
    // old execCommand trick so the button is never a dead end.
    const payload = `${text} ${url}`;
    try {
      await navigator.clipboard.writeText(payload);
      flash("Link copied");
      return;
    } catch (e) {
      /* fall through */
    }
    flash(legacyCopy(payload) ? "Link copied" : "Press Ctrl+C to copy");
  });

  function legacyCopy(value) {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, value.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
})();

// ---------- INIT ----------
checkStatus();
// auto-refresh every 30s while the tab is open
setInterval(() => {
  if (!document.hidden) checkStatus();
}, 30000);
