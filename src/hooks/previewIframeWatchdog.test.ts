import { describe, it, expect } from 'vitest';
import {
  decideIframeWatchdogArm,
  isPreviewProofOfLife,
  IFRAME_BLANK_TIMEOUT_MS,
  type IframeWatchdogState,
} from './previewIframeWatchdog';

const ready: IframeWatchdogState = {
  serverReady: true,
  proxyActive: true,
  aliveSinceNavigation: false,
};

describe('decideIframeWatchdogArm', () => {
  it('arms on navigation when the server is ready and the proxy injects', () => {
    expect(decideIframeWatchdogArm('navigation', ready)).toBe('arm');
  });

  it('never arms before the server is ready', () => {
    expect(decideIframeWatchdogArm('navigation', { ...ready, serverReady: false })).toBe('skip');
    expect(decideIframeWatchdogArm('load', { ...ready, serverReady: false })).toBe('skip');
  });

  it('never arms when the iframe bypasses the injecting proxy', () => {
    // Proxy failed to start → direct dev-server URL → no injected script could
    // ever prove life. Arming would flag every healthy page as blank.
    expect(decideIframeWatchdogArm('navigation', { ...ready, proxyActive: false })).toBe('skip');
    expect(decideIframeWatchdogArm('load', { ...ready, proxyActive: false })).toBe('skip');
  });

  it('re-arms on a load hop that has not proven life yet', () => {
    expect(decideIframeWatchdogArm('load', ready)).toBe('arm');
  });

  it('does not re-arm on load once the navigation proved life', () => {
    // Injected scripts post at parse time, BEFORE the load event — re-arming
    // here would wait for a message that will never come and false-positive.
    expect(decideIframeWatchdogArm('load', { ...ready, aliveSinceNavigation: true })).toBe('skip');
  });

  it('always arms on navigation even if the previous document was alive', () => {
    // A new document replaces the old one; its proof no longer stands.
    expect(decideIframeWatchdogArm('navigation', { ...ready, aliveSinceNavigation: true })).toBe(
      'arm'
    );
  });
});

describe('isPreviewProofOfLife', () => {
  it('accepts the injected alive/navigate/error messages', () => {
    expect(isPreviewProofOfLife('shipstudio:alive')).toBe(true);
    expect(isPreviewProofOfLife('shipstudio:navigate')).toBe(true);
    expect(isPreviewProofOfLife('shipstudio:error')).toBe(true);
  });

  it('accepts visual-editor messages — they also only run in a parsed page', () => {
    expect(isPreviewProofOfLife('ss:select')).toBe(true);
    expect(isPreviewProofOfLife('ss:tree')).toBe(true);
    expect(isPreviewProofOfLife('ss:cascade')).toBe(true);
  });

  it('rejects unrelated or malformed message types', () => {
    expect(isPreviewProofOfLife('webpackHotUpdate')).toBe(false);
    expect(isPreviewProofOfLife(undefined)).toBe(false);
    expect(isPreviewProofOfLife(42)).toBe(false);
    expect(isPreviewProofOfLife(null)).toBe(false);
  });
});

describe('IFRAME_BLANK_TIMEOUT_MS', () => {
  it('is long enough to ride an on-demand page compile of a warm server', () => {
    expect(IFRAME_BLANK_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
