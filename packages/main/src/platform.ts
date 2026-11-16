import { existsSync } from 'node:fs';

/**
 * Flatpak runs the app inside a bubblewrap sandbox and exports FLATPAK_ID plus a
 * /.flatpak-info marker file. Both are absent for deb/AppImage/dev runs.
 */
export const isFlatpak = Boolean(process.env.FLATPAK_ID) || existsSync('/.flatpak-info');

/**
 * Chromium's own sandbox cannot initialise inside the Flatpak sandbox: the setuid
 * helper is stripped and unprivileged user namespaces are unavailable. The Flatpak
 * (bubblewrap) sandbox is the isolation boundary for these helper browsers, so the
 * puppeteer-launched Chromium runs with its sandbox disabled.
 */
export const FLATPAK_CHROMIUM_ARGS: readonly string[] = ['--no-sandbox', '--disable-dev-shm-usage'];

export function getFlatpakChromiumArgs(flatpak: boolean = isFlatpak): string[] {
  return flatpak ? [...FLATPAK_CHROMIUM_ARGS] : [];
}
