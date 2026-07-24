import { describe, it, expect } from 'vitest';
import { normalizeThemeDest, defaultThemeDest, hubspotPreviewCommand } from './hubspot';

describe('normalizeThemeDest', () => {
  it('accepts plain paths and lowercases', () => {
    expect(normalizeThemeDest('My-Theme')).toBe('my-theme');
    expect(normalizeThemeDest('themes/marketing-site')).toBe('themes/marketing-site');
  });

  it('converts spaces to hyphens and strips surrounding slashes', () => {
    expect(normalizeThemeDest('  My Cool Theme ')).toBe('my-cool-theme');
    expect(normalizeThemeDest('/themes/site/')).toBe('themes/site');
  });

  it('rejects empty and unsafe input', () => {
    expect(normalizeThemeDest('')).toBeNull();
    expect(normalizeThemeDest('   ')).toBeNull();
    expect(normalizeThemeDest('../escape')).toBeNull();
    expect(normalizeThemeDest('theme;rm')).toBeNull();
    expect(normalizeThemeDest('-flag')).toBeNull();
  });
});

describe('defaultThemeDest', () => {
  it('uses the project folder name for root themes', () => {
    expect(defaultThemeDest('/Users/me/ShipStudio/My Landing Page')).toBe('my-landing-page');
    expect(defaultThemeDest('/Users/me/ShipStudio/site/', '.')).toBe('site');
  });

  it('uses the theme dir name when the theme is nested', () => {
    expect(defaultThemeDest('/Users/me/ShipStudio/ref-refined-technologies', 'rti-2026')).toBe(
      'rti-2026'
    );
  });
});

describe('hubspotPreviewCommand', () => {
  it('builds the preview command with no-ssl and port', () => {
    expect(hubspotPreviewCommand('.', 'my-theme', 3142)).toBe(
      'hs cms theme preview --src . --dest my-theme --noSsl --port 3142'
    );
  });

  it('passes a nested theme src through', () => {
    expect(hubspotPreviewCommand('rti-2026', 'rti-2026', 3200)).toBe(
      'hs cms theme preview --src rti-2026 --dest rti-2026 --noSsl --port 3200'
    );
  });
});
