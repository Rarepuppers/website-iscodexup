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

function filteredComponents(data, c) {
  let comps = (data.components || []).filter((component) => !component.group);
  if (c.componentInclude.length) {
    const want = c.componentInclude.map((s) => s.toLowerCase());
    comps = comps.filter((component) => want.includes((component.name || "").toLowerCase()));
  }
  return comps;
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
        await sendRecoveryCampaign(env, c, { now });
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

function recoveryEmailHtml(c) {
  const link = c.siteUrl
    ? `<p style="margin:24px 0 0"><a href="${c.siteUrl}" style="color:#7c5cff">${c.siteUrl.replace(/^https?:\/\//, "")}</a></p>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0f12;color:#eaeaf0;padding:32px">
    <div style="max-width:480px;margin:0 auto;text-align:center">
      <h1 style="font-size:32px;margin:0 0 8px">${c.product} is back up</h1>
      <p style="color:#a8a8b8;font-size:16px;line-height:1.5">The Codex-related components on the official status page are operational again. Back to work.</p>
      ${link}
      <p style="color:#6a6a78;font-size:12px;margin-top:32px">You're getting this because you asked to be notified when ${c.product} recovered.
      {{ unsubscribe }}</p>
    </div></body></html>`;
}

async function sendRecoveryCampaign(env, c, { now }) {
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  const body = {
    name: `${c.product} recovered ${stamp} UTC`,
    subject: `${c.product} is back up`,
    sender: { name: c.senderName, email: c.senderEmail },
    htmlContent: recoveryEmailHtml(c),
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const authed = env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;

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
