import { useSyncExternalStore } from "react";

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const theme = systemTheme.matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}
applyTheme();
systemTheme.addEventListener("change", applyTheme);

export function useSystemTheme() {
  return useSyncExternalStore(
    (notify) => {
      systemTheme.addEventListener("change", notify);
      return () => systemTheme.removeEventListener("change", notify);
    },
    () => (systemTheme.matches ? "dark" : "light"),
  );
}
