import themeInitSource from "./theme-init.js?raw";

export type Theme = "light" | "dark";

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export const THEME_STORAGE_KEY = "omnyo.theme";

export const THEME_COLORS: Readonly<Record<Theme, string>> = {
  light: "#ffffff",
  dark: "#151515",
};

export const THEME_INIT = `(${themeInitSource})(${[
  DARK_SCHEME_QUERY,
  THEME_STORAGE_KEY,
  THEME_COLORS,
]
  .map((value) => JSON.stringify(value))
  .join(",")})`;

const listeners = new Set<() => void>();

export const currentTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

const systemTheme = (): Theme =>
  matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";

function chosenTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);

    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

function storeChoice(theme: Theme | null): void {
  try {
    if (theme === null) localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    return;
  }
}

function showTheme(theme: Theme, chosen: boolean): void {
  const changed = currentTheme() !== theme;

  document.documentElement.classList.toggle("dark", theme === "dark");

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    const scheme: Theme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLORS[chosen ? theme : scheme];
  }

  if (!changed) return;

  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme): void {
  const chosen = theme !== systemTheme();

  storeChoice(chosen ? theme : null);
  showTheme(theme, chosen);
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function watchTheme(): () => void {
  const media = matchMedia(DARK_SCHEME_QUERY);

  const sync = () => {
    const chosen = chosenTheme();
    showTheme(chosen ?? systemTheme(), chosen !== null);
  };

  const syncStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) sync();
  };

  sync();
  media.addEventListener("change", sync);
  window.addEventListener("storage", syncStorage);

  return () => {
    media.removeEventListener("change", sync);
    window.removeEventListener("storage", syncStorage);
  };
}
