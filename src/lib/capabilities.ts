import { useEffect, useState } from 'react';
import { isTauriRuntime } from './webEvents';

export interface Capabilities {
  terminal: boolean;
  filePicker: boolean;
  preview: boolean;
  screenshots: boolean;
  clipboardImage: boolean;
  updater: boolean;
  deepLinks: boolean;
  processControl: boolean;
  windowControls: boolean;
  mobilePreview: boolean;
  revealInFileManager: boolean;
  analytics: boolean;
  homeDir: string | null;
  previewHost: string;
  /** Template containing `{port}` describing how *this browser* reaches a
   *  preview listener, e.g. `https://preview-{port}.example.com`. Set by the
   *  operator when previews are fronted by a reverse proxy; `null` falls back
   *  to dialling `previewHost:port` over plain http. */
  previewUrlTemplate: string | null;
}

const desktop: Capabilities = {
  terminal: true,
  filePicker: true,
  preview: true,
  screenshots: true,
  clipboardImage: true,
  updater: true,
  deepLinks: true,
  processControl: true,
  windowControls: true,
  mobilePreview: true,
  revealInFileManager: true,
  analytics: true,
  homeDir: null,
  previewHost: 'localhost',
  previewUrlTemplate: null,
};

const web: Capabilities = {
  ...desktop,
  screenshots: false,
  clipboardImage: false,
  updater: false,
  deepLinks: false,
  processControl: false,
  windowControls: false,
  mobilePreview: false,
  revealInFileManager: false,
  analytics: false,
  previewHost: location.hostname || 'localhost',
};

let cached: Promise<Capabilities> | null = null;

export function getCapabilities(): Promise<Capabilities> {
  if (isTauriRuntime()) return Promise.resolve(desktop);
  cached ??= fetch('/api/capabilities', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((body: { ok: boolean; data?: Capabilities }) => {
      if (!body.ok || !body.data) throw new Error('Failed to load server capabilities');
      return body.data;
    });
  return cached;
}

export function useCapabilities(): Capabilities {
  const [value, setValue] = useState(isTauriRuntime() ? desktop : web);
  useEffect(() => {
    void getCapabilities()
      .then(setValue)
      .catch(() => {});
  }, []);
  return value;
}

export function previewOrigin(
  port: number,
  host = web.previewHost,
  template: string | null = null
): string {
  // An operator-supplied template wins: only the deployment knows whether the
  // preview is dialled directly or through a reverse proxy, and on a TLS origin
  // the `http://host:port` form below is blocked as mixed content regardless of
  // whether the port is reachable.
  if (template) return template.split('{port}').join(String(port));
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}
