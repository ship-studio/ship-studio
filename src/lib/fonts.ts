/**
 * Font loading utilities for the terminal.
 *
 * Loads JetBrains Mono Nerd Font from Tauri bundled resources using the
 * FontFace API with ArrayBuffer. This approach bypasses WebKit's URL/CORS/CSP
 * issues that occur when loading fonts via CSS @font-face in Tauri production builds.
 *
 * The fonts include Nerd Font glyphs for proper rendering of icons and
 * special characters used by Claude Code CLI.
 *
 * @module lib/fonts
 */

import { readFile, BaseDirectory } from '@tauri-apps/plugin-fs';

/** Track if fonts have been loaded */
let fontsLoaded = false;
/** Promise for in-progress font loading (prevents duplicate loads) */
let fontLoadPromise: Promise<void> | null = null;

/**
 * Load Nerd Fonts from Tauri resources and register them with the browser.
 * Uses ArrayBuffer directly with FontFace API to bypass WebKit's URL loading issues.
 */
export async function loadNerdFonts(): Promise<void> {
  // Return existing promise if already loading
  if (fontLoadPromise) {
    return fontLoadPromise;
  }

  // Skip if already loaded
  if (fontsLoaded) {
    return;
  }

  fontLoadPromise = (async () => {
    try {
      // eslint-disable-next-line no-console
      console.log('[Fonts] Loading Nerd Fonts from resources...');

      // Read font files as binary data from Tauri resources
      const [regularData, boldData] = await Promise.all([
        readFile('fonts/JetBrainsMonoNerdFontMono-Regular.woff2', {
          baseDir: BaseDirectory.Resource,
        }),
        readFile('fonts/JetBrainsMonoNerdFontMono-Bold.woff2', {
          baseDir: BaseDirectory.Resource,
        }),
      ]);

      // eslint-disable-next-line no-console
      console.log('[Fonts] Font data loaded:', {
        regularSize: regularData.byteLength,
        boldSize: boldData.byteLength,
      });

      // Create FontFace with ArrayBuffer directly (NOT URLs)
      // This bypasses all WebKit URL/CORS/CSP issues
      const regularFont = new FontFace('JetBrainsMono NF', regularData.buffer, {
        weight: '400',
        style: 'normal',
      });

      const boldFont = new FontFace('JetBrainsMono NF', boldData.buffer, {
        weight: '700',
        style: 'normal',
      });

      // Load and add to document
      const [loadedRegular, loadedBold] = await Promise.all([regularFont.load(), boldFont.load()]);

      document.fonts.add(loadedRegular);
      document.fonts.add(loadedBold);

      // Verify fonts are ready
      await document.fonts.ready;

      const isLoaded = document.fonts.check('12px "JetBrainsMono NF"');
      // eslint-disable-next-line no-console
      console.log('[Fonts] Nerd Fonts registered, available:', isLoaded);

      fontsLoaded = true;
    } catch (err) {
      console.error('[Fonts] Failed to load Nerd Fonts:', err);
      // Don't throw - let the terminal use fallback fonts
    }
  })();

  return fontLoadPromise;
}

/**
 * Check if Nerd Fonts are available
 */
export function areFontsLoaded(): boolean {
  return fontsLoaded || document.fonts.check('12px "JetBrainsMono NF"');
}
