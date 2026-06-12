import { describe, expect, it } from 'vitest';
import {
  normalizeStoreDomain,
  shopifyThemeDevCommand,
  shopifyAdminUrl,
  buildPushPrompt,
  createLoginPromptDetector,
} from './shopify';

describe('normalizeStoreDomain', () => {
  it('passes through a bare myshopify domain', () => {
    expect(normalizeStoreDomain('my-store.myshopify.com')).toBe('my-store.myshopify.com');
  });

  it('appends .myshopify.com to a bare handle', () => {
    expect(normalizeStoreDomain('my-store')).toBe('my-store.myshopify.com');
  });

  it('strips protocol, path, and casing', () => {
    expect(normalizeStoreDomain('https://My-Store.myshopify.com/admin/themes')).toBe(
      'my-store.myshopify.com'
    );
  });

  it('unwraps admin.shopify.com store URLs', () => {
    expect(normalizeStoreDomain('https://admin.shopify.com/store/my-store/themes')).toBe(
      'my-store.myshopify.com'
    );
  });

  it('rejects input that cannot be a store domain', () => {
    expect(normalizeStoreDomain('')).toBeNull();
    expect(normalizeStoreDomain('   ')).toBeNull();
    expect(normalizeStoreDomain('my store')).toBeNull();
    expect(normalizeStoreDomain('store;rm -rf')).toBeNull();
  });
});

describe('shopifyThemeDevCommand', () => {
  it('builds the dev command with store and port', () => {
    expect(shopifyThemeDevCommand('my-store.myshopify.com', 9292)).toBe(
      'shopify theme dev --store my-store.myshopify.com --port 9292'
    );
  });
});

describe('shopifyAdminUrl', () => {
  it('points at the store admin', () => {
    expect(shopifyAdminUrl('my-store.myshopify.com')).toBe('https://my-store.myshopify.com/admin');
  });
});

describe('buildPushPrompt', () => {
  it('targets the connected store and defaults to unpublished', () => {
    const prompt = buildPushPrompt('my-store.myshopify.com');
    expect(prompt).toContain('my-store.myshopify.com');
    expect(prompt).toContain('--unpublished');
  });
});

describe('createLoginPromptDetector', () => {
  it('fires when the login prompt arrives in one chunk', () => {
    const detect = createLoginPromptDetector();
    expect(detect('User verification code: HDVC-LXVJ\n')).toBe(false);
    expect(detect('👉 Press any key to open the login page on your browser\n')).toBe(true);
  });

  it('fires when the prompt is split across PTY chunks', () => {
    const detect = createLoginPromptDetector();
    expect(detect('👉 Press any key to op')).toBe(false);
    expect(detect('en the login page on your browser')).toBe(true);
  });

  it('latches: at most one nudge per server run', () => {
    const detect = createLoginPromptDetector();
    expect(detect('Press any key to open the login page')).toBe(true);
    expect(detect('Press any key to open the login page')).toBe(false);
  });

  it('ignores unrelated output', () => {
    const detect = createLoginPromptDetector();
    expect(detect('Serving theme on http://127.0.0.1:9292\n')).toBe(false);
    expect(detect('Press q to quit\n')).toBe(false);
  });
});
