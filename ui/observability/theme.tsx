/**
 * Light/dark theme, stored in `localStorage` under `mt-theme`.
 *
 * `index.html` resolves the stored preference into a `.dark` class on <html>
 * before first paint, so there is no flash; this module only has to keep that
 * class in sync afterwards. Dark stays the default when nothing is stored — the
 * dashboard has been dark-only for its whole life, and the OS preference should
 * not silently change it for existing users.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ThemeToggle as BeuiThemeToggle } from "./components/beui/registry/components/motion/theme-toggle";

const STORE_KEY = "mt-theme";

export type Theme = "light" | "dark";

function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The active theme, and a setter that persists it and updates <html>. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(storedTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const setTheme = useCallback((t: Theme): void => {
    setThemeState(t);
    try {
      localStorage.setItem(STORE_KEY, t);
    } catch {
      /* storage unavailable — the class still flips for this session */
    }
  }, []);

  return [theme, setTheme];
}

/** A single icon button that flips between light and dark. */
export function ThemeToggle(): ReactNode {
  return (
    <BeuiThemeToggle
      variant="circle"
      className="size-9 rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      iconClassName="size-4"
    />
  );
}
