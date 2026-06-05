// iscodexup.com - pure client-side, no backend.
// Reads the official Statuspage API live (CORS is open: Access-Control-Allow-Origin: *).
// Product-specific values (status URL, copy, art, quotes) live in config.js -> window.SITE.

const STATUS_URL = SITE.statusUrl;

const els = {
  body: document.body,
  verdict: document.getElementById("verdict"),
  subline: document.getElementById("subline"),
  components: document.getElementById("components"),
  updated: document.getElementById("updated"),
  smash: document.getElementById("smash"),
  quote: document.getElementById("quote"),
  count: document.getElementById("count"),
  mascot: document.getElementById("mascot-img"),
  smashImg: document.getElementById("smash-img"),
};

const ROBOTS = SITE.robots;
const DEFAULT_BUTTON = SITE.buttons.default;
const BUTTONS = {
  up: SITE.buttons.up,
  degraded: DEFAULT_BUTTON,
  down: SITE.buttons.down,
};

[...Object.values(ROBOTS), ...Object.values(BUTTONS), DEFAULT_BUTTON].forEach((src) => {
  const i = new Image();
  i.src = src;
});

// ---------- THE VERDICT ----------
function filteredComponents(data) {
  let comps = (data.components || []).filter((c) => !c.group);
  const compCfg = SITE.components || {};

  if (Array.isArray(compCfg.include) && compCfg.include.length) {
    const want = compCfg.include.map((s) => s.toLowerCase());
    comps = comps.filter((c) => want.includes((c.name || "").toLowerCase()));
  }

  return comps;
}

function stateFromComponentStatus(status) {
  const s = String(status || "operational").toLowerCase();
  if (s === "major_outage" || s === "partial_outage") return "down";
  if (s === "degraded_performance" || s === "under_maintenance") return "degraded";
  return "up";
}

function stateFromComponents(comps) {
  if (!comps.length) return null;
  const states = comps.map((c) => stateFromComponentStatus(c.status));
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  return "up";
}

function stateFromPageIndicator(indicator) {
  if (indicator === "none") return "up";
  if (indicator === "minor") return "degraded";
  return "down";
}

function render(data) {
  const pageIndicator = data?.status?.indicator || "none";
  const compCfg = SITE.components || {};
  const scopedComps = filteredComponents(data);
  const scopedState = compCfg.statusSource === "components" ? stateFromComponents(scopedComps) : null;
  const state = scopedState || stateFromPageIndicator(pageIndicator);
  let verdict, subline;

  if (state === "up") {
    verdict = SITE.copy.up.verdict;
    subline = SITE.copy.up.subline;
  } else if (state === "degraded") {
    const affected = scopedComps.filter((c) => stateFromComponentStatus(c.status) !== "up").map((c) => c.name);
    verdict = SITE.copy.degraded.verdict;
    subline = affected.length
      ? `Some Codex components are degraded: ${affected.join(", ")}.`
      : data.status.description || SITE.copy.degraded.subline;
  } else {
    const affected = scopedComps.filter((c) => stateFromComponentStatus(c.status) !== "up").map((c) => c.name);
    verdict = SITE.copy.down.verdict;
    subline = affected.length
      ? `Codex components reporting issues: ${affected.join(", ")}.`
      : data.status.description || SITE.copy.down.subline;
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

  counter.setStatus(state, data);

  els.components.innerHTML = "";
  let comps = scopedComps;
  if (compCfg.limit > 0) comps = comps.slice(0, compCfg.limit);
  comps.forEach((c) => {
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

async function checkStatus() {
  try {
    const res = await fetch(STATUS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("bad response " + res.status);
    render(await res.json());
  } catch (err) {
    els.body.dataset.state = "down";
    els.verdict.textContent = "?";
    els.subline.textContent = SITE.copy.unreachable;
    els.updated.textContent = new Date().toLocaleTimeString();
  }
}

// ---------- SMASH BUTTON + QUOTES ----------
const quotes = SITE.quotes;

// ---------- PANIC COUNTER (split-flap odometer) ----------
// Fully faked for now (no backend). Represents "panic-checks in the last 24h".
// - Calm days: a LOW number (0-5000) that resets at UTC midnight and creeps
//   up slowly through the day.
// - Outages: a MUCH higher number, scaled by how long the outage has lasted,
//   climbing fast.
// The number never drops mid-day; it only resets at UTC midnight.

const CLICK_RATE = {
  up: 0,
  degraded: 1.2,
  down: 4.5,
};

function daySeed() {
  const d = new Date();
  const n = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

function utcDayStart() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

const counter = (() => {
  let value = 0;
  let shown = 0;
  let bonus = 0;
  let state = "up";
  let curDay = dayKey();
  let outageSeenAt = Number(localStorage.getItem("outageSeenAt")) || 0;
  let lastChars = [];

  function calmBase(now) {
    const target = 2500 + Math.floor(daySeed() * 2500);
    const frac = Math.min(1, (now - utcDayStart()) / 86400000);
    return Math.floor(target * frac);
  }

  function outageBase(now) {
    const ind = state === "down" ? "major" : state === "degraded" ? "minor" : "none";
    if (ind === "none") {
      outageSeenAt = 0;
      localStorage.removeItem("outageSeenAt");
      return 0;
    }

    if (!outageSeenAt) {
      outageSeenAt = now;
      localStorage.setItem("outageSeenAt", String(now));
    }

    const severe = ind !== "minor";
    const minutes = Math.max(0, (now - outageSeenAt) / 60000);
    const perMin = severe ? 320 : 80;
    const jump = severe ? 4000 : 1200;
    const wobble = 0.85 + daySeed() * 0.4;
    return Math.floor((jump + minutes * perMin) * wobble);
  }

  function floorNow(now) {
    return calmBase(now) + outageBase(now);
  }

  function paint(n) {
    const str = Math.floor(n).toLocaleString("en-US");
    const chars = str.split("");

    if (chars.length !== lastChars.length) {
      els.count.innerHTML = "";
      chars.forEach((ch) => {
        const cell = document.createElement("span");
        cell.className = ch === "," ? "cell comma" : "cell";
        cell.textContent = ch;
        els.count.appendChild(cell);
      });
      lastChars = chars;
      return;
    }

    const cells = els.count.children;
    chars.forEach((ch, i) => {
      if (lastChars[i] !== ch) {
        const cell = cells[i];
        cell.classList.remove("flipping");
        void cell.offsetWidth;
        cell.classList.add("flipping");
        setTimeout(() => { cell.textContent = ch; }, 120);
      }
    });
    lastChars = chars;
  }

  function ease() {
    if (shown === value) return;
    const diff = value - shown;
    shown = diff > 0 ? Math.min(value, shown + Math.max(1, Math.round(diff / 12))) : value;
    paint(shown);
  }
  setInterval(ease, 90);

  setInterval(() => {
    const now = Date.now();
    if (dayKey() !== curDay) {
      curDay = dayKey();
      value = calmBase(now);
      shown = value;
      paint(shown);
    }
    const floor = floorNow(now);
    if (floor > value) value = floor;
    const rate = CLICK_RATE[state] || 0;
    if (rate > 0) {
      value += Math.random() < (rate % 1) ? Math.ceil(rate) : Math.floor(rate);
    }
    value += bonus;
    bonus = 0;
  }, 1000);

  value = shown = calmBase(Date.now());
  paint(shown);

  return {
    setStatus(s) { state = s; },
    bump(n = 1) { bonus += n; },
  };
})();

let lastQuote = -1;
function smash() {
  let i;
  do { i = Math.floor(Math.random() * quotes.length); } while (i === lastQuote);
  lastQuote = i;

  els.quote.classList.remove("show");
  void els.quote.offsetWidth;
  els.quote.textContent = quotes[i];
  els.quote.classList.add("show");

  els.smash.classList.remove("pop");
  void els.smash.offsetWidth;
  els.smash.classList.add("pop");

  counter.bump(1);
  checkStatus();
}

els.smash.addEventListener("click", smash);

checkStatus();
setInterval(() => {
  if (!document.hidden) checkStatus();
}, 30000);
