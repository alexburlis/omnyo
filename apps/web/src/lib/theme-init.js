function themeInit(darkQuery, storageKey, colors) {
  var chosen = null;

  try {
    chosen = localStorage.getItem(storageKey);
  } catch {
    chosen = null;
  }

  var picked = chosen === "dark" || chosen === "light";
  var dark = picked ? chosen === "dark" : matchMedia(darkQuery).matches;

  if (dark) document.documentElement.classList.add("dark");

  if (!picked) return;

  var metas = document.querySelectorAll('meta[name="theme-color"]');

  for (var index = 0; index < metas.length; index++) {
    metas[index].setAttribute("content", dark ? colors.dark : colors.light);
  }
}
