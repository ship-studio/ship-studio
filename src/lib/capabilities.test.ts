import { describe, it, expect } from 'vitest';
import { previewOrigin } from './capabilities';

describe('previewOrigin', () => {
  it('dials host:port over http when no template is configured', () => {
    expect(previewOrigin(3100, 'localhost', null)).toBe('http://localhost:3100');
  });

  it('brackets a bare IPv6 host', () => {
    expect(previewOrigin(3100, '::1', null)).toBe('http://[::1]:3100');
  });

  it('does not double-bracket a host that is already bracketed', () => {
    expect(previewOrigin(3100, '[::1]', null)).toBe('http://[::1]:3100');
  });

  it('uses the operator template when one is configured', () => {
    expect(previewOrigin(3100, 'example.com', 'https://preview-{port}.example.com')).toBe(
      'https://preview-3100.example.com'
    );
  });

  it('lets the template override the host entirely', () => {
    // The reverse proxy may publish previews on a different name than the app,
    // so the template must win rather than being merged with previewHost.
    expect(previewOrigin(3100, 'app.example.com', 'https://preview-{port}.other.test')).toBe(
      'https://preview-3100.other.test'
    );
  });

  it('substitutes every occurrence of the port placeholder', () => {
    expect(previewOrigin(3100, 'example.com', 'https://{port}.example.com/p/{port}')).toBe(
      'https://3100.example.com/p/3100'
    );
  });

  it('produces an https origin so a TLS page is not blocked as mixed content', () => {
    // The regression this guards: an http preview inside an https app is
    // blocked by the browser before the request is made, so the readiness
    // probe never resolves and the preview spins forever.
    const origin = previewOrigin(3100, 'ship.example.com', 'https://preview-{port}.example.com');
    expect(origin.startsWith('https://')).toBe(true);
  });
});
