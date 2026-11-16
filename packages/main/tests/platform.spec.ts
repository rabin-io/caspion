import { expect, test } from 'vitest';
import { FLATPAK_CHROMIUM_ARGS, getFlatpakChromiumArgs } from '../src/platform';

test('Chromium sandbox opt-out flags are added only inside Flatpak', () => {
  expect(getFlatpakChromiumArgs(true)).toEqual([...FLATPAK_CHROMIUM_ARGS]);
  expect(getFlatpakChromiumArgs(false)).toEqual([]);
});
