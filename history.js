// Shared outage-history renderer — identical file on isclaudeup.com and iscodexup.com.
// Reads the official Statuspage incidents feed (the same public API the live verdict
// uses) and turns it into evergreen, indexable content: how often the product actually
// goes down, how long incidents last, and what broke.
//
// KEEP THE TWO COPIES IN SYNC (see FORK.md).

// Statuspage publishes incidents at the sibling path of summary.json.
const INCIDENTS_URL = SITE.statusUrl.replace(/summary\.json$/, "incidents.json");

const DAY = 86400000;

const el = {
  stats: document.getElementById("stats"),
  list: document.getElementById("incident-list"),
  empty: document.getElementById("incident-empty"),
  updated: document.getElementById("updated"),
  scope: document.getElementById("scope-note"),
};

// Only count incidents that touched a component this site actually reports on.
// (iscodexup scopes to the Codex components; isclaudeup reports the full list.)
function incidentTouchesUs(inc) {
  const want = (SITE.components && Array.isArray(SITE.components.include) ? SITE.components.include : [])
    .map((s) => s.toLowerCase());
  if (!want.length) return true;

  const names = new Set();
  (inc.incident_updates || []).forEach((u) => {
    (u.affected_components || []).forEach((c) => names.add((c.name || "").toLowerCase()));
  });
  // No component data at all → keep it rather than silently dropping a real outage.
  if (!names.size) return true;
  return want.some((n) => names.has(n));
}

function durationMs(inc) {
  const start = Date.parse(inc.started_at || inc.created_at || "");
  const end = Date.parse(inc.resolved_at || inc.updated_at || "");
  if (isNaN(start) || isNaN(end) || end < start) return null;
  return end - start;
}

function humanDuration(ms) {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function monthKey(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "Unknown" : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Statuspage impact: none | maintenance | minor | major | critical
function impactLabel(impact) {
  const map = { critical: "Critical", major: "Major", minor: "Minor", maintenance: "Maintenance", none: "Info" };
  return map[impact] || "Incident";
}

function statCard(value, label, hint) {
  const li = document.createElement("li");
  const v = document.createElement("span");
  v.className = "stat-value";
  v.textContent = value;
  const l = document.createElement("span");
  l.className = "stat-label";
  l.textContent = label;
  li.append(v, l);
  if (hint) {
    const h = document.createElement("span");
    h.className = "stat-hint";
    h.textContent = hint;
    li.appendChild(h);
  }
  return li;
}

// Statuspage's incidents.json returns only the ~50 most recent incidents. During a
// busy stretch those 50 can all fall inside a single month, which makes any fixed
// "last 90 days" count silently wrong — it would just report the page size again.
//
// So we don't pick the window; the feed does. We measure how far back it actually
// reaches and report over exactly that span, flagging the count as a floor ("50+")
// whenever the feed is truncated.
function renderStats(incidents) {
  const now = Date.now();
  const startedAt = (i) => Date.parse(i.started_at || i.created_at || "");
  const times = incidents.map(startedAt).filter((t) => !isNaN(t));

  if (!times.length) {
    el.stats.innerHTML = "";
    return { days: 0, truncated: false, count: 0 };
  }

  const oldest = Math.min(...times);
  const spanDays = Math.max(1, Math.round((now - oldest) / DAY));

  // The feed is capped; if we got a full page, older incidents exist that we can't see.
  const truncated = incidents.length >= 50;

  const durations = incidents.map(durationMs).filter((d) => d != null);
  const longest = durations.length ? Math.max(...durations) : null;
  const perWeek = (incidents.length / spanDays) * 7;

  const windowLabel = spanDays >= 90
    ? `last ${Math.round(spanDays / 30)} months`
    : `last ${spanDays} days`;

  el.stats.innerHTML = "";
  el.stats.append(
    statCard(truncated ? `${incidents.length}+` : String(incidents.length), "incidents", windowLabel),
    statCard(perWeek >= 1 ? perWeek.toFixed(1) : perWeek.toFixed(2), "per week", "average over that span"),
    statCard(humanDuration(median(durations)), "median length", "when one happens"),
    statCard(humanDuration(longest), "longest", windowLabel)
  );

  return { days: spanDays, truncated, count: incidents.length };
}

// Say plainly what the numbers above do and don't cover.
function renderCoverage({ days, truncated, count }) {
  const node = document.getElementById("coverage-note");
  if (!node) return;
  if (!count) { node.textContent = ""; return; }
  const vendor = SITE.vendor || "the vendor";
  node.textContent = truncated
    ? `${vendor}'s feed publishes only the ${count} most recent incidents, which reach back ${days} days. ` +
      `Older incidents exist but aren't in the feed, so these are minimums, not lifetime totals.`
    : `Covering the ${count} incidents ${vendor} has published, going back ${days} days.`;
}

function renderList(incidents) {
  el.list.innerHTML = "";
  if (!incidents.length) {
    el.empty.hidden = false;
    return;
  }
  el.empty.hidden = true;

  let currentMonth = null;
  incidents.forEach((inc) => {
    const started = inc.started_at || inc.created_at;
    const m = monthKey(started);
    if (m !== currentMonth) {
      currentMonth = m;
      const h = document.createElement("h3");
      h.className = "incident-month";
      h.textContent = m;
      el.list.appendChild(h);
    }

    const item = document.createElement("article");
    item.className = "incident impact-" + (inc.impact || "none");

    const head = document.createElement("div");
    head.className = "incident-head";

    const badge = document.createElement("span");
    badge.className = "pill impact-" + (inc.impact || "none");
    badge.textContent = impactLabel(inc.impact);

    const title = document.createElement("h4");
    title.className = "incident-name";
    // Statuspage incident names are vendor-authored text — set as text, never HTML.
    title.textContent = inc.name || "Incident";

    head.append(badge, title);

    const meta = document.createElement("p");
    meta.className = "incident-meta";
    const d = durationMs(inc);
    meta.textContent =
      fmtDate(started) +
      (d != null ? ` · lasted ${humanDuration(d)}` : "") +
      (inc.resolved_at ? "" : " · ongoing");

    item.append(head, meta);

    if (inc.shortlink) {
      const link = document.createElement("a");
      link.className = "incident-link";
      link.href = inc.shortlink;
      link.target = "_blank";
      link.rel = "noopener nofollow";
      link.textContent = "Official incident report";
      item.appendChild(link);
    }

    el.list.appendChild(item);
  });
}

async function load() {
  try {
    const res = await fetch(INCIDENTS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("bad response " + res.status);
    const data = await res.json();

    const incidents = (data.incidents || [])
      .filter(incidentTouchesUs)
      .sort((a, b) => Date.parse(b.started_at || b.created_at) - Date.parse(a.started_at || a.created_at));

    renderCoverage(renderStats(incidents));
    renderList(incidents);
    el.updated.textContent = new Date().toLocaleString();
  } catch (err) {
    el.stats.innerHTML = "";
    el.empty.hidden = false;
    el.empty.textContent =
      "Couldn't reach the official status feed just now. Refresh in a moment, or read it directly at " +
      INCIDENTS_URL.replace("/api/v2/incidents.json", "") + ".";
  }
}

if (el.scope) {
  const inc = SITE.components && SITE.components.include;
  el.scope.textContent = inc && inc.length
    ? `Scoped to the components this site tracks: ${inc.join(", ")}.`
    : `Covers every component ${SITE.vendor || "the vendor"} publishes for ${SITE.product}.`;
}

load();
