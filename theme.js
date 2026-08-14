/**
 * Three-way theme toggle — shared verbatim across snackpackuniverse.com,
 * isclaudeup.com and iscodexup.com.
 *
 *   dark   →  light  →  cream  →  dark …
 *
 * Themes are applied as `data-theme` on <html>; each stylesheet defines the
 * palette for all three under `:root[data-theme="…"]`. Nothing here knows about
 * colours, so a site can restyle a theme without touching this file.
 *
 * Two things worth knowing:
 *
 *  1. **The initial theme is set by a tiny inline snippet in <head>, not here.**
 *     This file is deferred, which means it runs after first paint — if it owned
 *     the initial choice, every visit would flash the default palette before
 *     switching. The snippet is injected by scripts/build-theme.mjs; see there.
 *
 *  2. **The button mounts itself**, so adding the toggle to a page needs no
 *     markup. It looks for an explicit `[data-theme-slot]`, then a `.nav-links`
 *     list, then falls back to a fixed top-right button. Preferring the nav
 *     matters on pages whose header already occupies that corner: a fixed
 *     button would sit on top of the links.
 */
(function () {
  "use strict";

  var KEY = "snackpack.theme.v1";
  var ORDER = ["dark", "light", "cream"];

  var META = {
    dark:  { icon: "☾", label: "dark" },
    light: { icon: "☀", label: "light" },
    cream: { icon: "◐", label: "cream" }
  };

  var root = document.documentElement;

  function fallback() {
    // Per-site default, written into <html data-theme-default="…"> by the build
    // step. Without one, honour the OS preference.
    var declared = root.getAttribute("data-theme-default");
    if (declared && META[declared]) return declared;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "cream";
  }

  function current() {
    var value = root.getAttribute("data-theme");
    return META[value] ? value : fallback();
  }

  function next(theme) {
    return ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  }

  function apply(theme, persist) {
    root.setAttribute("data-theme", theme);
    if (persist) {
      try { localStorage.setItem(KEY, theme); } catch (error) {}
    }
    paint(theme);
  }

  var button = null;

  function paint(theme) {
    if (!button) return;
    var upcoming = next(theme);
    button.textContent = META[theme].icon;
    // The control cycles, so the honest label is what the NEXT press does.
    var text = "Switch to " + META[upcoming].label + " mode";
    button.setAttribute("aria-label", text);
    button.setAttribute("title", text);
  }

  function mount() {
    button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    button.setAttribute("data-theme-toggle", "");

    var slot = document.querySelector("[data-theme-slot]");
    var nav = document.querySelector(".nav-links");

    if (slot) {
      slot.appendChild(button);
    } else if (nav) {
      var item = document.createElement("li");
      item.className = "nav-theme-item";
      item.appendChild(button);
      nav.appendChild(item);
    } else {
      button.classList.add("theme-toggle--floating");
      document.body.appendChild(button);
    }

    button.addEventListener("click", function () {
      apply(next(current()), true);
    });

    paint(current());
  }

  // Follow the OS only while the visitor has never chosen for themselves.
  if (window.matchMedia) {
    var query = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      var saved = null;
      try { saved = localStorage.getItem(KEY); } catch (error) {}
      if (!saved) apply(fallback(), false);
    };
    if (query.addEventListener) query.addEventListener("change", onChange);
    else if (query.addListener) query.addListener(onChange);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
