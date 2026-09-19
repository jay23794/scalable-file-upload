import { Injectable, effect, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'ocean-theme-preference';

/**
 * Owns the app's light/dark choice.
 *
 * All this does is set data-theme on <html>; styles.scss turns that into a
 * color-scheme, and Material's light-dark() values do the rest. Nothing here
 * knows a single colour, which is what keeps the palette swappable.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(restore());

  constructor() {
    effect(() => this.apply(this.preference()));
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);

    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Private browsing or a blocked store. The choice still applies for this
      // session; only remembering it fails, which is not worth surfacing.
    }
  }

  private apply(preference: ThemePreference): void {
    const root = document.documentElement;

    // 'system' is the ABSENCE of the attribute, not a value: styles.scss leaves
    // the bare selector as `light dark` so the OS decides.
    if (preference === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);
  }
}

function restore(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Unreadable store — fall through to following the OS.
  }

  return 'system';
}
