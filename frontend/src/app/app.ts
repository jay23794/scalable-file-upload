import { Component, computed, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { ThemePreference, ThemeService } from './core/theme.service';

interface ThemeOption {
  value: ThemePreference;
  label: string;
  icon: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'system', label: 'System', icon: 'brightness_auto' },
  { value: 'light', label: 'Light', icon: 'light_mode' },
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatMenuModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  private readonly theme = inject(ThemeService);

  protected readonly sidenavOpen = signal(true);
  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly themePreference = this.theme.preference;

  // The trigger shows the CHOICE, not the resolved scheme — on 'system' the
  // auto icon is the honest answer, since the OS owns it from there.
  protected readonly themeIcon = computed(
    () => THEME_OPTIONS.find(o => o.value === this.themePreference())?.icon ?? 'brightness_auto',
  );

  toggleSidenav() {
    this.sidenavOpen.update(v => !v);
  }

  setTheme(preference: ThemePreference) {
    this.theme.set(preference);
  }
}
