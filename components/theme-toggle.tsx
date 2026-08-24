'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Theme = 'light' | 'dark';

/**
 * Light/dark switch.
 *
 * The class on <html> is set before first paint by the inline script in the
 * layout, so this component only has to read what is already there. It renders
 * a placeholder until mounted: the server has no idea which theme this visitor
 * chose, and rendering the wrong icon then correcting it is a hydration
 * mismatch and a visible flicker.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    setTheme(next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // private mode or blocked storage — the choice just won't outlive the tab
    }
  }

  if (theme === null) {
    // same footprint as the real button, so the nav doesn't shift on mount
    return <span aria-hidden className="inline-block size-7" />;
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/**
 * Runs before the page paints: applies the saved choice, falling back to the
 * system preference. Without this the page would render in the default theme
 * and then snap to the chosen one.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');document.documentElement.classList.toggle('dark',t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();`;
