/* Shared seasonal appearance for the SnackPack and status sites. */
(() => {
  const root = document.documentElement;
  const offset = Number(document.currentScript.dataset.rotationOffset || 0);
  const key = "snackpack.seasonal-appearance.v1";
  const choices = { auto: "Automatic", winter: "Winter", classic: "Classic" };
  const day = 86400000;
  const start = Date.UTC(2026, 10, 25);
  const end = Date.UTC(2026, 11, 31);

  function storedChoice() {
    try {
      const value = localStorage.getItem(key);
      if (Object.hasOwn(choices, value)) return value;
    } catch {
      // Appearance still works within this page when storage is unavailable.
    }
    return "auto";
  }

  let choice = storedChoice();
  let select;
  let description;
  let timer;

  function refresh() {
    const now = new Date();
    // Use the visitor's calendar day and UTC arithmetic to avoid DST drift.
    const date = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const inSeason = date >= start && date < end;
    const active = choice === "winter" || (choice === "auto" && inSeason);
    const rotation = Math.floor((date - start) / day) + offset;
    root.dataset.season = active ? "winter" : "classic";
    root.dataset.winterScene = String((rotation % 4 + 4) % 4);

    if (select) {
      select.value = choice;
      description.textContent = choice === "auto"
        ? "Automatic is showing " + (active ? "Winter" : "Classic") + "."
        : choices[choice] + " appearance is selected.";
    }

    clearTimeout(timer);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    timer = setTimeout(refresh, midnight - now + 100);
  }

  function mount() {
    const modeToggle = document.querySelector("[data-theme-toggle]");
    if (!modeToggle || typeof HTMLDialogElement === "undefined") return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle season-toggle";
    button.textContent = "❄";
    button.title = "Seasonal appearance";
    button.setAttribute("aria-label", "Seasonal appearance");
    button.setAttribute("aria-haspopup", "dialog");

    const dialog = document.createElement("dialog");
    dialog.className = "season-dialog";
    dialog.setAttribute("aria-labelledby", "season-title");
    dialog.innerHTML = `
      <h2 id="season-title">Seasonal appearance</h2>
      <label class="season-field">Appearance
        <select name="appearance" autofocus>
          <option value="auto">Automatic</option>
          <option value="winter">Winter</option>
          <option value="classic">Classic</option>
        </select>
      </label>
      <p aria-live="polite" data-season-description></p>
      <p class="season-help">Automatic uses Winter from November 25 through December 30, 2026, in your local time.</p>
      <form method="dialog"><button type="submit">Done</button></form>`;
    select = dialog.querySelector("select");
    description = dialog.querySelector("[data-season-description]");
    select.addEventListener("change", () => {
      choice = select.value;
      try { localStorage.setItem(key, choice); } catch {}
      refresh();
    });
    button.addEventListener("click", () => dialog.showModal());
    modeToggle.after(button);
    document.body.append(dialog);
    refresh();
  }

  refresh();
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) {
      choice = storedChoice();
      refresh();
    }
  });
  // theme.js mounts the adjacent mode button before DOMContentLoaded.
  document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
