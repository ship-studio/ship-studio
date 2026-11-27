/** Isolated external browser surface for URLs outside the project's local dev-server origin. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  createExternalPreviewWebview,
  destroyExternalPreviewWebview,
  navigateExternalPreviewWebview,
  resizeExternalPreviewWebview,
  setExternalPreviewWebviewVisible,
} from '../../lib/externalPreview';
import { logger } from '../../lib/logger';

interface ExternalPreviewFrameProps {
  url: string;
  reloadToken: number;
  /** Hide the native child surface while app overlays need to receive input. */
  visible?: boolean;
}

interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let nativeCommandQueue: Promise<unknown> = Promise.resolve();

function enqueueNativeCommand<T>(command: () => Promise<T>): Promise<T> {
  const result = nativeCommandQueue.then(command, command);
  nativeCommandQueue = result.catch(() => undefined);
  return result;
}

function readBounds(element: HTMLElement): PreviewBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function isCovered(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return true;
  const xs = [0.1, 0.5, 0.9].map((fraction) => rect.left + rect.width * fraction);
  const ys = [0.1, 0.5, 0.9].map((fraction) => rect.top + rect.height * fraction);
  return ys.some((y) =>
    xs.some((x) => {
      const top = document.elementFromPoint(x, y);
      return top !== null && !element.contains(top);
    })
  );
}

/**
 * Uses a dedicated native child webview in Tauri so external sites can use
 * storage scoped to an isolated, non-persistent browser context without sharing
 * the privileged app webview. Browser previews retain a sandboxed iframe fallback.
 */
export function ExternalPreviewFrame({
  url,
  reloadToken,
  visible = true,
}: ExternalPreviewFrameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ownerIdRef = useRef<string | null>(null);
  const creatingRef = useRef(false);
  const latestUrlRef = useRef(url);
  const latestVisibleRef = useRef(visible);
  const latestReloadTokenRef = useRef(reloadToken);
  const lastAppliedRef = useRef<{ url: string; reloadToken: number } | null>(null);
  const lastBoundsRef = useRef<PreviewBounds | null>(null);
  const lastVisibleRef = useRef<boolean | null>(null);
  const [nativeFailure, setNativeFailure] = useState<string | null>(null);
  const nativeUnavailable = nativeFailure !== null;

  useLayoutEffect(() => {
    latestUrlRef.current = url;
    latestVisibleRef.current = visible;
    latestReloadTokenRef.current = reloadToken;
  }, [url, visible, reloadToken]);

  const resizeNative = useCallback(() => {
    const host = hostRef.current;
    const ownerId = ownerIdRef.current;
    if (!ownerId || !host) return;
    const bounds = readBounds(host);
    const previous = lastBoundsRef.current;
    if (
      previous &&
      previous.x === bounds.x &&
      previous.y === bounds.y &&
      previous.width === bounds.width &&
      previous.height === bounds.height
    )
      return;
    lastBoundsRef.current = bounds;
    void enqueueNativeCommand(() => resizeExternalPreviewWebview(bounds, ownerId)).catch(
      (error: unknown) => {
        logger.warn('[ExternalPreviewFrame] Native surface resize failed', {
          error: String(error),
        });
      }
    );
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !isTauri() || nativeUnavailable) return;
    let cancelled = false;
    let frame = 0;
    let visibilityFrame = 0;
    const ownerId = crypto.randomUUID();
    ownerIdRef.current = ownerId;

    const updateVisibility = () => {
      visibilityFrame = 0;
      if (ownerIdRef.current !== ownerId || !lastAppliedRef.current) return;
      const shouldShow = latestVisibleRef.current && !isCovered(host);
      if (lastVisibleRef.current === shouldShow) return;
      lastVisibleRef.current = shouldShow;
      void enqueueNativeCommand(() => setExternalPreviewWebviewVisible(shouldShow, ownerId)).catch(
        (error: unknown) => {
          logger.warn('[ExternalPreviewFrame] Native surface visibility update failed', {
            error: String(error),
          });
        }
      );
    };
    const scheduleVisibilityUpdate = () => {
      if (!visibilityFrame) visibilityFrame = window.requestAnimationFrame(updateVisibility);
    };
    const create = () => {
      frame = 0;
      if (cancelled || creatingRef.current) return;
      const bounds = readBounds(host);
      if (bounds.width <= 0 || bounds.height <= 0) return;
      creatingRef.current = true;
      lastBoundsRef.current = bounds;
      const sentUrl = latestUrlRef.current;
      const sentReloadToken = latestReloadTokenRef.current;
      void enqueueNativeCommand(() => createExternalPreviewWebview(sentUrl, bounds, ownerId))
        .then(() => {
          if (cancelled) {
            return enqueueNativeCommand(() => destroyExternalPreviewWebview(ownerId));
          }
          lastAppliedRef.current = { url: sentUrl, reloadToken: sentReloadToken };
          lastVisibleRef.current = null;
          if (
            latestUrlRef.current !== sentUrl ||
            latestReloadTokenRef.current !== sentReloadToken
          ) {
            const latestUrl = latestUrlRef.current;
            const latestReloadToken = latestReloadTokenRef.current;
            lastAppliedRef.current = { url: latestUrl, reloadToken: latestReloadToken };
            void enqueueNativeCommand(() =>
              navigateExternalPreviewWebview(latestUrl, ownerId)
            ).catch((error: unknown) => {
              logger.warn('[ExternalPreviewFrame] Native surface navigation failed', {
                error: String(error),
              });
            });
          }
          resizeNative();
          scheduleVisibilityUpdate();
        })
        .catch((error: unknown) => {
          logger.warn('[ExternalPreviewFrame] Native surface unavailable; using sandboxed iframe', {
            error: String(error),
          });
          if (!cancelled) setNativeFailure(String(error));
        })
        .finally(() => {
          if (ownerIdRef.current === ownerId) creatingRef.current = false;
        });
    };
    const scheduleCreate = () => {
      if (!frame && !creatingRef.current && !lastAppliedRef.current)
        frame = window.requestAnimationFrame(create);
    };
    const observer = new ResizeObserver(() => {
      if (ownerIdRef.current === ownerId && lastAppliedRef.current) resizeNative();
      else scheduleCreate();
      scheduleVisibilityUpdate();
    });
    const mutations = new MutationObserver(scheduleVisibilityUpdate);
    observer.observe(host);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.addEventListener('resize', resizeNative);
    window.addEventListener('scroll', resizeNative, true);
    scheduleCreate();
    return () => {
      cancelled = true;
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', resizeNative);
      window.removeEventListener('scroll', resizeNative, true);
      if (frame) window.cancelAnimationFrame(frame);
      if (ownerIdRef.current === ownerId) {
        ownerIdRef.current = null;
        creatingRef.current = false;
      }
      lastAppliedRef.current = null;
      lastBoundsRef.current = null;
      lastVisibleRef.current = null;
      if (visibilityFrame) window.cancelAnimationFrame(visibilityFrame);
      void enqueueNativeCommand(() => destroyExternalPreviewWebview(ownerId)).catch(
        (error: unknown) => {
          logger.warn('[ExternalPreviewFrame] Native surface cleanup failed', {
            error: String(error),
          });
        }
      );
    };
  }, [nativeUnavailable, resizeNative]);

  useEffect(() => {
    const ownerId = ownerIdRef.current;
    if (!ownerId || !lastAppliedRef.current || nativeUnavailable) return;
    const previous = lastAppliedRef.current;
    if (previous.url === url && previous.reloadToken === reloadToken) return;
    lastAppliedRef.current = { url, reloadToken };
    void enqueueNativeCommand(() => navigateExternalPreviewWebview(url, ownerId)).catch(
      (error: unknown) => {
        logger.warn('[ExternalPreviewFrame] Native surface navigation failed', {
          error: String(error),
        });
      }
    );
  }, [url, reloadToken, nativeUnavailable]);

  useEffect(() => {
    const ownerId = ownerIdRef.current;
    const host = hostRef.current;
    if (!ownerId || !host || !lastAppliedRef.current || nativeUnavailable) return;
    const shouldShow = visible && !isCovered(host);
    if (lastVisibleRef.current === shouldShow) return;
    lastVisibleRef.current = shouldShow;
    void enqueueNativeCommand(() => setExternalPreviewWebviewVisible(shouldShow, ownerId)).catch(
      (error: unknown) => {
        logger.warn('[ExternalPreviewFrame] Native surface visibility update failed', {
          error: String(error),
        });
      }
    );
  }, [visible, nativeUnavailable]);

  return (
    <div className="preview-external-frame" ref={hostRef}>
      {(!isTauri() || nativeUnavailable) && (
        <>
          {nativeFailure && (
            <div className="preview-external-frame__notice" role="status">
              Embedded browser unavailable. This sandboxed preview may not retain site data.
            </div>
          )}
          <iframe
            key={`${url}:${reloadToken}`}
            className="preview-external-frame__fallback"
            title={`External preview: ${url}`}
            src={url}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
          />
        </>
      )}
    </div>
  );
}
