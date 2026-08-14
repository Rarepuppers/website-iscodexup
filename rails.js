// ---------------------------------------------------------------------------
// Sponsor rails — shared file, identical on isclaudeup.com and iscodexup.com.
// KEEP THE TWO COPIES IN SYNC (see FORK.md).
//
// Renders the two fixed corner rails from `window.SITE.sponsors`. Per-site data
// lives in config.js, because the two sites will not necessarily sell the same
// placements.
//
// The right rail always ends with the "space available" card, so the offer is
// visible whether or not anyone has bought a slot. With no sponsors configured
// that card is the only thing on screen, which is the honest state: one quiet
// offer, not a wall of empty boxes pretending to be an ad network.
//
// To add a sponsor, put an entry in config.js:
//
//   sponsors: [
//     { name: "Acme", blurb: "Ship faster.", url: "https://acme.dev",
//       logo: "assets/acme.png" }   // logo optional; falls back to the initial
//   ]
//
// Anything with a `url` is rendered rel="sponsored noopener" per Google's
// guidance for paid links, so a placement can never pass PageRank and put the
// site's own search standing at risk.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  var OFFER_URL = "sponsor.html";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function card(data, isOffer) {
    // A real placement is a link; the offer is a link too (to sponsor.html), so
    // both are keyboard-reachable and open predictably.
    var node = el("a", "rail-card" + (isOffer ? " rail-card--offer" : ""));
    node.href = isOffer ? OFFER_URL : data.url;

    if (isOffer) {
      node.setAttribute("data-rail", "offer");
    } else {
      // Paid placements: never pass ranking signal, always open in a new tab.
      node.rel = "sponsored noopener noreferrer";
      node.target = "_blank";
      node.appendChild(el("span", "rail-label", "Sponsor"));
    }

    var mark = el("span", "rail-mark");
    if (isOffer) {
      mark.textContent = "+";
    } else if (data.logo) {
      var img = el("img");
      img.src = data.logo;
      img.alt = "";              // decorative; the name is right beside it
      img.loading = "lazy";
      img.decoding = "async";
      mark.appendChild(img);
    } else {
      mark.textContent = (data.name || "?").trim().charAt(0).toUpperCase();
    }
    node.appendChild(mark);

    var copy = el("span", "rail-copy");
    copy.appendChild(el("strong", null, isOffer ? "Advertise here" : data.name));
    var blurb = isOffer
      ? "This space is available. Reach developers mid-outage."
      : data.blurb;
    if (blurb) copy.appendChild(el("span", null, blurb));
    node.appendChild(copy);

    return node;
  }

  function render() {
    var site = window.SITE || {};
    var sponsors = Array.isArray(site.sponsors) ? site.sponsors.filter(function (s) {
      return s && s.name && s.url;   // a card with no destination is just clutter
    }) : [];

    var left = document.querySelector('[data-rail="left"]');
    var right = document.querySelector('[data-rail="right"]');
    if (!left || !right) return;

    left.textContent = "";
    right.textContent = "";

    // Split so both corners are used once there is more than one sponsor, and
    // the offer keeps the right rail company rather than sitting alone.
    var leftItems = sponsors.filter(function (_, i) { return i % 2 === 0; });
    var rightItems = sponsors.filter(function (_, i) { return i % 2 === 1; });

    leftItems.forEach(function (s) { left.appendChild(card(s, false)); });
    rightItems.forEach(function (s) { right.appendChild(card(s, false)); });
    right.appendChild(card(null, true));

    // An empty rail still has padding and a border box in some browsers' a11y
    // trees; hide it outright so screen readers skip it entirely.
    left.hidden = left.childElementCount === 0;
    right.hidden = right.childElementCount === 0;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
