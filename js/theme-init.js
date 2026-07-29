(function (root) {
  "use strict";

  const STORAGE_KEY = "pdf-merger-theme";

  function resolveTheme(storedTheme, prefersDark) {
    if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
    return prefersDark ? "dark" : "light";
  }

  function readStoredTheme() {
    try {
      return root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : null;
    } catch {
      return null;
    }
  }

  function applyTheme(theme, persist) {
    const nextTheme = resolveTheme(theme, false);
    if (root.document && root.document.documentElement) {
      root.document.documentElement.dataset.theme = nextTheme;
      root.document.documentElement.style.colorScheme = nextTheme;
    }
    if (persist !== false) {
      try {
        if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, nextTheme);
      } catch {}
    }
    return nextTheme;
  }

  function getInitialTheme() {
    const prefersDark = Boolean(
      root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches
    );
    return resolveTheme(readStoredTheme(), prefersDark);
  }

  const api = {
    STORAGE_KEY,
    resolveTheme,
    readStoredTheme,
    applyTheme,
    getInitialTheme,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PdfMergerTheme = api;
  applyTheme(getInitialTheme(), false);
})(typeof window !== "undefined" ? window : globalThis);
