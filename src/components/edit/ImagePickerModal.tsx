/**
 * Asset picker for the visual editor's image replacement — a slim, picker-shaped
 * view of the project's assets folder (default /public): image files only, as a
 * thumbnail grid, plus an inline upload. Picking (or uploading) an image hands
 * its web path to the caller, which writes it into the `src` literal.
 */

import { useEffect, useMemo, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { listAssets, uploadAsset, isImageFile, assetWebPath, type Asset } from '../../lib/assets';
import { useAsyncState } from '../../hooks/useAsyncState';

interface Props {
  isOpen: boolean;
  projectPath: string;
  /** The image's current src (web path) — its grid tile is highlighted. */
  currentSrc?: string | null;
  /** Called with the chosen asset's web path (e.g. "/images/hero.png"). */
  onPick: (webPath: string) => void;
  onClose: () => void;
}

/** Percent-decode for display/compare; malformed input is shown as-is. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function ImagePickerModal({ isOpen, projectPath, currentSrc, onPick, onClose }: Props) {
  const {
    data: assets,
    isLoading,
    error,
    execute: reload,
  } = useAsyncState(() => listAssets(projectPath));
  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  const images = useMemo(
    () => (assets ?? []).filter((a) => !a.isDirectory && isImageFile(a.name)),
    [assets]
  );

  // Upload lands in the assets root, then is picked immediately — uploading from
  // here means "replace with this file", so a second click would just be friction.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isLoading: isUploading, execute: upload } = useAsyncState(
    async (file: File) => {
      const data = Array.from(new Uint8Array(await file.arrayBuffer()));
      return uploadAsset(projectPath, '/', file.name, data);
    },
    { onSuccess: (asset: Asset) => onPick(assetWebPath(asset.path)) }
  );

  const current = currentSrc ? safeDecode(currentSrc) : null;

  return (
    <ModalFrame isOpen={isOpen} onClose={onClose} title="Replace image" className="ss-image-picker">
      <p className="ss-image-picker__hint">
        Pick an image from your assets folder, or upload a new one.
      </p>

      {error && <p className="ss-image-picker__error">{error.message}</p>}

      {isLoading && !assets ? (
        <p className="ss-image-picker__empty">Loading assets…</p>
      ) : images.length === 0 ? (
        <p className="ss-image-picker__empty">
          No images in your assets folder yet — upload one below.
        </p>
      ) : (
        <div className="ss-image-picker__grid">
          {images.map((asset) => {
            const webPath = assetWebPath(asset.path);
            const isCurrent = current !== null && safeDecode(webPath) === current;
            return (
              <button
                key={asset.path}
                type="button"
                className={`ss-image-picker__item${isCurrent ? ' is-current' : ''}`}
                onClick={() => onPick(webPath)}
                title={safeDecode(webPath)}
              >
                <span className="ss-image-picker__thumb">
                  <img src={convertFileSrc(asset.fullPath)} alt="" loading="lazy" />
                </span>
                <span className="ss-image-picker__name">{asset.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="ss-image-picker__footer">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? 'Uploading…' : 'Upload image…'}
        </Button>
      </div>
    </ModalFrame>
  );
}
