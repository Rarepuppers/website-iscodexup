// iscodexup recovery notifier - Cloudflare Worker (cron-triggered).
//
// Runs every minute (see wrangler.toml [triggers]). It polls the official
// Statuspage summary, scopes the result to configured Codex-related components,
// remembers the previous state in KV, and sends one Brevo campaign when a real
// outage recovers. Flap protection stops blips from spamming people.

const STATE_KEY = "notifier:state";

function cfg(env) {
  return {
    statusUrl: env.STATUS_URL,
    listId: Number(env.BREVO_LIST_ID),
    senderName: env.SENDER_NAME,
    senderEmail: env.SENDER_EMAIL,
    product: env.PRODUCT || "the service",
    siteUrl: env.SITE_URL || "",
    componentInclude: (env.COMPONENT_INCLUDE || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    outageIndicators: (env.OUTAGE_INDICATORS || "major,critical")
      .split(",").map((s) => s.trim()).filter(Boolean),
    minOutageMs: Number(env.MIN_OUTAGE_MINUTES || "3") * 60000,
    upConfirmTicks: Number(env.UP_CONFIRM_TICKS || "2"),
    cooldownMs: Number(env.NOTIFY_COOLDOWN_MINUTES || "30") * 60000,
  };
}

async function loadState(env) {
  const raw = await env.STATE.get(STATE_KEY);
  return raw ? JSON.parse(raw) : {
    inOutage: false,
    outageStart: null,
    upStreak: 0,
    lastIndicator: null,
    lastNotifiedAt: 0,
    lastNotifiedIncidentId: null,
  };
}

function saveState(env, state) {
  return env.STATE.put(STATE_KEY, JSON.stringify(state));
}

// Narrow the feed to the components we actually notify on.
//
// COMPONENT_INCLUDE names must match OpenAI's published component names exactly.
// A stale list is invisible in normal operation — it just quietly stops matching —
// so log loudly on every mismatch. A previous list matched no Codex component at
// all, which meant a real Codex outage could never trigger a recovery email.
function filteredComponents(data, c) {
  const all = (data.components || []).filter((component) => !component.group);
  if (!c.componentInclude.length) return all;

  const want = c.componentInclude.map((s) => s.toLowerCase());
  const have = new Set(all.map((component) => (component.name || "").toLowerCase()));
  const missing = c.componentInclude.filter((n) => !have.has(n.toLowerCase()));
  if (missing.length) {
    console.warn(
      `COMPONENT_INCLUDE names absent from the live feed: ${missing.join(", ")}. ` +
        `Published names: ${all.map((component) => component.name).join(", ")}`
    );
  }

  const matched = all.filter((component) => want.includes((component.name || "").toLowerCase()));
  if (!matched.length) {
    console.error(
      "COMPONENT_INCLUDE matched NOTHING — falling back to the page-level indicator. Fix wrangler.toml."
    );
  }
  return matched;
}

function indicatorFromComponentStatus(status) {
  const s = String(status || "operational").toLowerCase();
  if (s === "major_outage" || s === "partial_outage") return "major";
  if (s === "degraded_performance" || s === "under_maintenance") return "minor";
  return "none";
}

function scopedIndicator(data, c) {
  const comps = filteredComponents(data, c);
  if (!comps.length) return (data.status && data.status.indicator) || "none";

  const indicators = comps.map((component) => indicatorFromComponentStatus(component.status));
  if (indicators.includes("major")) return "major";
  if (indicators.includes("minor")) return "minor";
  return "none";
}

function activeIncidentId(data) {
  const inc = (data.incidents || [])[0];
  return inc ? inc.id : null;
}

async function tick(env, { force = false } = {}) {
  const c = cfg(env);
  const now = Date.now();
  const state = await loadState(env);
  const before = JSON.stringify(state);

  const res = await fetch(c.statusUrl, { cf: { cacheTtl: 0 }, headers: { "cache-control": "no-store" } });
  if (!res.ok) {
    console.log(`status fetch failed: ${res.status}`);
    return { action: "fetch-error", status: res.status };
  }

  const data = await res.json();
  const indicator = scopedIndicator(data, c);
  const isOutageNow = c.outageIndicators.includes(indicator);
  const isFullyUp = indicator === "none";
  let action = "noop";

  if (isOutageNow) {
    if (!state.inOutage) {
      state.inOutage = true;
      state.outageStart = now;
      state.lastNotifiedIncidentId = activeIncidentId(data);
      action = "outage-detected";
    }
    state.upStreak = 0;
  } else {
    state.upStreak = isFullyUp ? Math.min(state.upStreak + 1, c.upConfirmTicks) : 0;

    const confirmed = force || state.upStreak >= c.upConfirmTicks;
    const lastedLongEnough = state.outageStart && (now - state.outageStart) >= c.minOutageMs;
    const outOfCooldown = (now - (state.lastNotifiedAt || 0)) >= c.cooldownMs;

    if (state.inOutage && confirmed) {
      if (lastedLongEnough && outOfCooldown) {
        await sendRecoveryCampaign(env, c, { outageStart: state.outageStart, now });
        state.lastNotifiedAt = now;
        action = "recovery-sent";
      } else {
        action = lastedLongEnough ? "recovery-skipped-cooldown" : "recovery-skipped-too-brief";
      }
      state.inOutage = false;
      state.outageStart = null;
      state.lastNotifiedIncidentId = null;
    }
  }

  state.lastIndicator = indicator;
  if (JSON.stringify(state) !== before) await saveState(env, state);
  console.log(`tick: scopedIndicator=${indicator} action=${action} upStreak=${state.upStreak}`);
  return { action, indicator, state };
}

// "34 minutes" / "1 hour 12 minutes". Returns null when there is no usable span
// (the /test-send route has no outage start) and the duration line is then omitted.
function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (!Number.isFinite(totalMinutes) || totalMinutes < 1) return null;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

// HH:MM in UTC. The feed is UTC and subscribers span time zones, so name the zone
// rather than guessing a local one.
function utcClock(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

// No image here carries information: most clients block images by default, so the
// email must read correctly without them. The wordmark falls back to the domain as
// alt text; the glyph is purely decorative and simply disappears.
function recoveryEmailHtml(c, { outageStart, now } = {}) {
  const link = c.siteUrl
    ? `<p style="margin:24px 0 0"><a href="${c.siteUrl}" style="color:#7c5cff">${c.siteUrl.replace(/^https?:\/\//, "")}</a></p>`
    : "";

  // The single thing this email can tell a reader that they don't already know.
  const duration = outageStart && now ? formatDuration(now - outageStart) : null;
  const outage = duration
    ? `<p style="color:#8a8a9a;font-size:15px;line-height:1.5;margin:0 0 12px">${c.product} was down for ${duration} &mdash; ${utcClock(outageStart)} to ${utcClock(now)} UTC.</p>`
    : "";

  // Absolute https URLs are required in email; skip the art entirely without a site.
  const wordmark = c.siteUrl
    ? `<img src="${c.siteUrl}/assets/email-wordmark-codex@2x.png" width="240" height="48" alt="${c.siteUrl.replace(/^https?:\/\//, "")}" style="display:block;margin:0 auto 20px;border:0;outline:none;text-decoration:none">`
    : "";
  const glyph = c.siteUrl
    ? `<img src="${c.siteUrl}/assets/email-glyph-recovered@2x.png" width="64" height="64" alt="" style="display:block;margin:0 auto 12px;border:0;outline:none;text-decoration:none">`
    : "";

  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0f12;color:#eaeaf0;padding:32px">
    <div style="max-width:480px;margin:0 auto;text-align:center">
      ${wordmark}
      ${glyph}
      <h1 style="font-size:32px;margin:0 0 12px">${c.product} is back up</h1>
      <p style="color:#a8a8b8;font-size:16px;line-height:1.5;margin:0 0 12px">The Codex-related components on the official status page are operational again.</p>
      ${outage}
      <p style="color:#a8a8b8;font-size:16px;line-height:1.5;margin:0">Back to work.</p>
      ${link}
      <p style="color:#6a6a78;font-size:12px;margin-top:32px">You're getting this because you asked to be notified when ${c.product} recovered.</p>
    </div></body></html>`;
}

async function sendRecoveryCampaign(env, c, { outageStart, now }) {
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  const body = {
    name: `${c.product} recovered ${stamp} UTC`,
    subject: `${c.product} is back up`,
    sender: { name: c.senderName, email: c.senderEmail },
    htmlContent: recoveryEmailHtml(c, { outageStart, now }),
    recipients: { listIds: [c.listId] },
  };

  const create = await fetch("https://api.brevo.com/v3/emailCampaigns", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!create.ok) {
    const txt = await create.text();
    console.log(`brevo create campaign failed: ${create.status} ${txt}`);
    throw new Error(`brevo create ${create.status}`);
  }
  const { id } = await create.json();

  const send = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/sendNow`, {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, accept: "application/json" },
  });
  if (!send.ok) {
    const txt = await send.text();
    console.log(`brevo sendNow failed: ${send.status} ${txt}`);
    throw new Error(`brevo sendNow ${send.status}`);
  }
  console.log(`recovery campaign ${id} sent to list ${c.listId}`);
}

// ─── Embeddable status badge ─────────────────────────────────────────────
// A live SVG badge other people can drop into a README or docs page. Every
// embed is a permanent contextual link back, placed because it is useful to
// the embedder — which is the whole point.
//
// The status feed is fetched through the Cloudflare edge cache with a 60s TTL,
// so badge traffic cannot amplify load on the upstream status page no matter
// how many READMEs embed it.

const BADGE_STATES = {
  none:     { text: "operational", color: "#3fa66a" },
  minor:    { text: "degraded",    color: "#d68a1e" },
  major:    { text: "major outage", color: "#c8443a" },
  critical: { text: "outage",      color: "#c8443a" },
  unknown:  { text: "unknown",     color: "#7a7a86" },
};

async function currentIndicator(env) {
  try {
    const res = await fetch(env.STATUS_URL, {
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) return "unknown";
    const data = await res.json();
    // Scoped to the Codex components, same as tick(). OpenAI's page-level
    // indicator covers all of ChatGPT, so using it would let the badge read
    // "operational" during a Codex-only incident the site reports as down.
    return scopedIndicator(data, cfg(env));
  } catch (_) {
    return "unknown";
  }
}

// Rough advance width for 11px DejaVu/Verdana-ish text. Shields does the same
// thing; exactness doesn't matter, consistent padding does.
function textWidth(s) {
  return Math.ceil(s.length * 6.2) + 2;
}

function badgeSvg(label, status) {
  const s = BADGE_STATES[status] || BADGE_STATES.unknown;
  const lw = textWidth(label) + 10;
  const rw = textWidth(s.text) + 10;
  const w = lw + rw;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const alt = `${label}: ${s.text}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(alt)}">
  <title>${esc(alt)}</title>
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-color="#000" stop-opacity=".3"/>
    <stop offset="1" stop-color="#000" stop-opacity=".5"/>
  </linearGradient>
  <clipPath id="c"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${lw}" height="20" fill="#40404a"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${s.color}"/>
    <rect width="${w}" height="20" fill="url(#g)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11">
    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(s.text)}</text>
    <text x="${lw + rw / 2}" y="14">${esc(s.text)}</text>
  </g>
</svg>`;
}

// Embeds are cross-origin by definition, and a stale badge is worse than a
// slightly expensive one — 60s keeps it honest during an incident.
const BADGE_HEADERS = {
  "cache-control": "public, max-age=60, s-maxage=60",
  "access-control-allow-origin": "*",
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const authed = env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;

    // Public, embeddable. ?label= lets an embedder retitle it (default "claude").
    if (url.pathname === "/badge.svg") {
      const label = (url.searchParams.get("label") || env.PRODUCT || "status").slice(0, 24);
      const svg = badgeSvg(label.toLowerCase(), await currentIndicator(env));
      return new Response(svg, {
        headers: { "content-type": "image/svg+xml; charset=utf-8", ...BADGE_HEADERS },
      });
    }
    // Shields.io endpoint format, so people already using shields can render it
    // in their own style: https://img.shields.io/endpoint?url=<this>
    if (url.pathname === "/badge.json") {
      const s = BADGE_STATES[await currentIndicator(env)] || BADGE_STATES.unknown;
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          label: (env.PRODUCT || "status").toLowerCase(),
          message: s.text,
          color: s.color,
        }),
        { headers: { "content-type": "application/json; charset=utf-8", ...BADGE_HEADERS } },
      );
    }

    if (url.pathname === "/state") {
      const state = await loadState(env);
      return Response.json(state);
    }
    if (url.pathname === "/test-tick") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      return Response.json(await tick(env));
    }
    if (url.pathname === "/test-send") {
      if (!authed) return new Response("unauthorized", { status: 401 });
      await sendRecoveryCampaign(env, cfg(env), { now: Date.now() });
      return new Response("sent");
    }
    return new Response("iscodexup notifier: ok", { status: 200 });
  },
};
