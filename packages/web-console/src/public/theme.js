(function applyHedgelingTheme() {
  const storageKey = "hedgeling.theme";
  const normalize = (value) => ["light", "dark"].includes(value) ? value : "system";
  const readPreference = () => {
    try { return normalize(localStorage.getItem(storageKey)); }
    catch { return "system"; }
  };
  let preference = readPreference();
  const query = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const theme = preference === "system" ? (query.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    for (const control of document.querySelectorAll("select[data-theme-preference]")) control.value = preference;
    const label = document.querySelector("#themeLabel");
    if (label) label.textContent = preference === "system" ? `Using system ${theme} theme` : `Using ${theme} theme`;
  };
  window.HedgelingTheme = { syncControls: apply };
  document.addEventListener("change", (event) => {
    if (!event.target.matches("select[data-theme-preference]")) return;
    preference = normalize(event.target.value);
    try { localStorage.setItem(storageKey, preference); }
    catch { /* The current page can still switch when storage is unavailable. */ }
    apply();
  });
  addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) { preference = readPreference(); apply(); }
  });
  apply();
  query.addEventListener?.("change", apply);
  addEventListener("DOMContentLoaded", apply, { once: true });
  async function applyBrand() {
    try {
      const response = await fetch("/design-system/brand.json");
      if (!response.ok) return;
      const brand = await response.json();
      if (!String(brand.logo).startsWith("/design-system/assets/")) return;
      for (const image of document.querySelectorAll('img[src="/hedgeling-logo.png"]')) image.src = brand.logo;
      for (const node of document.querySelectorAll("[data-brand-name]")) node.textContent = brand.productName;
      document.title = document.title.replaceAll("Hedgeling", brand.productName);
    } catch { /* The existing page remains usable if branding cannot load. */ }
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", applyBrand, { once: true });
  else void applyBrand();
})();
