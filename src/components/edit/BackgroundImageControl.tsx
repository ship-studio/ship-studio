import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ImageIcon } from '@/components/icons';
import { useOptionalAssetBrowser } from '../../contexts/AssetBrowserContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { assetWebPath, getAssetsRoot, listAssets } from '../../lib/assets';
import { isSimpleCssBackgroundUrl, tailwindBackgroundUrlToken } from '../../lib/cssBackgroundImage';
import { utilityTokenFor, type LayerContext, type ResetSpec } from '../../lib/edit';
import { Button } from '../primitives/Button';
import { PropertyField } from '../primitives/PropertyField';
import { TextButton } from '../primitives/TextButton';

function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\r\f ])?|([\r\n\f])|([\s\S]))/g,
    (_match, hex: string | undefined, newline: string | undefined, escaped: string | undefined) => {
      if (hex) {
        const codePoint = parseInt(hex, 16);
        return codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? '\ufffd'
          : String.fromCodePoint(codePoint);
      }
      if (newline) return '';
      return escaped ?? '';
    }
  );
}

function simpleCssUrlSource(value: string): string | null {
  if (!isSimpleCssBackgroundUrl(value)) return null;
  const trimmed = value.trim();
  const open = /^url\s*\(/i.exec(trimmed);
  if (!open) return null;
  let source = trimmed.slice(open[0].length, -1).trim();
  const quote = source.charAt(0);
  if (quote === '"' || quote === "'") {
    if (source.charAt(source.length - 1) !== quote) return null;
    source = source.slice(1, -1);
  }
  return decodeCssEscapes(source);
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function imageFilename(source: string | null): string {
  if (!source) return 'Background image';
  if (/^data:/i.test(source)) return 'Embedded image';
  let path = source;
  if (/^https?:\/\//i.test(source)) {
    try {
      path = new URL(source).pathname;
    } catch {
      // Keep the authored source if it is not a valid absolute URL.
    }
  }
  const pathSegments = path.split(/[?#]/, 1)[0].split(/[\\/]/).filter(Boolean);
  const filename = pathSegments[pathSegments.length - 1];
  return filename ? safelyDecode(filename) : 'Background image';
}

function assetMatchPath(source: string | null): string | null {
  // Only root-absolute project URLs have a known mapping to the configured
  // assets directory. Relative paths depend on the preview page's URL.
  if (!source || !/^\/(?!\/)/.test(source)) return null;
  const path = source.split(/[?#]/, 1)[0];
  return path.split('/').map(safelyDecode).join('/');
}

function localAssetPreview(
  source: string | null,
  lookup: { root: string; assets: Awaited<ReturnType<typeof listAssets>> } | null
): string | null {
  const sourcePath = assetMatchPath(source);
  if (!sourcePath || !lookup) return null;
  for (const asset of lookup.assets) {
    if (asset.isDirectory) continue;
    try {
      const assetPath = assetMatchPath(assetWebPath(lookup.root, asset.path));
      if (assetPath === sourcePath) return convertFileSrc(asset.fullPath);
    } catch {
      // A configured asset root may not have a public URL mapping.
    }
  }
  return null;
}

function directImageSource(source: string | null): string | null {
  if (!source) return null;
  if (/^https?:\/\//i.test(source) || /^blob:/i.test(source)) return source;
  if (/^data:image\//i.test(source)) return source;
  return null;
}

export function BackgroundImageControl({
  currentClass,
  layer,
  computed,
  projectPath,
  selectionKey,
  onApplyEnum,
  onReset,
}: {
  currentClass: string;
  layer: LayerContext;
  computed?: string;
  projectPath?: string;
  selectionKey?: string;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}) {
  const browser = useOptionalAssetBrowser();
  const { showToast } = useOptionalToast();
  const pickerIdRef = useRef<number | null>(null);
  const [pickedPreview, setPickedPreview] = useState<{
    projectPath: string;
    path: string;
    source: string;
  } | null>(null);
  const value = computed?.trim() ?? '';
  const isSimpleImage = isSimpleCssBackgroundUrl(value);
  const sourceUrl = simpleCssUrlSource(value);
  const hasLocalProjectUrl = !!sourceUrl && /^\/(?!\/)/.test(sourceUrl);
  const isEmpty = !value || value === 'none';
  const isComplex = !isSimpleImage && !isEmpty;
  const canPick = !isComplex && !!projectPath && !!browser;
  const {
    data: assetsData,
    execute: loadAssets,
    reset: resetAssets,
  } = useAsyncState(async (path: string) => {
    const [root, projectAssets] = await Promise.all([getAssetsRoot(path), listAssets(path)]);
    return { projectPath: path, root, assets: projectAssets };
  });
  const assetLookup = assetsData?.projectPath === projectPath ? assetsData : null;

  useEffect(() => {
    if (projectPath && hasLocalProjectUrl) void loadAssets(projectPath);
    else if (!projectPath) resetAssets();
  }, [hasLocalProjectUrl, loadAssets, projectPath, resetAssets]);

  const normalizedAssetPath = assetMatchPath(sourceUrl);
  const pickedSource =
    pickedPreview !== null &&
    pickedPreview.projectPath === projectPath &&
    pickedPreview.path === normalizedAssetPath
      ? pickedPreview.source
      : null;
  const thumbnailSource =
    directImageSource(sourceUrl) ?? pickedSource ?? localAssetPreview(sourceUrl, assetLookup);
  const filename = imageFilename(sourceUrl);
  const currentIdentity = JSON.stringify([
    projectPath ?? '',
    selectionKey ?? '',
    layer.bp.name,
    layer.bp.prefix,
    layer.bp.minPx,
    layer.utilityPrefix ?? '',
    currentClass,
  ]);
  const identityRef = useRef(currentIdentity);
  const cancelPicker = browser?.cancelPicker;
  const cancelPickerRef = useRef(cancelPicker);

  useLayoutEffect(() => {
    cancelPickerRef.current = cancelPicker;
  }, [cancelPicker]);

  useLayoutEffect(() => {
    const changed = identityRef.current !== currentIdentity;
    identityRef.current = currentIdentity;
    if (changed && pickerIdRef.current != null) {
      cancelPickerRef.current?.(pickerIdRef.current);
      pickerIdRef.current = null;
    }
  }, [currentIdentity]);

  useEffect(
    () => () => {
      if (pickerIdRef.current != null) cancelPickerRef.current?.(pickerIdRef.current);
    },
    []
  );

  const openPicker = () => {
    if (!canPick || !browser || !projectPath) return;
    const expectedIdentity = currentIdentity;
    pickerIdRef.current = browser.openPicker({
      projectPath,
      title: 'Choose background image',
      onPick: (asset, root) => {
        if (identityRef.current !== expectedIdentity) {
          pickerIdRef.current = null;
          return;
        }
        try {
          const url = assetWebPath(root, asset.path);
          onApplyEnum(utilityTokenFor(tailwindBackgroundUrlToken(url), layer.utilityPrefix), {
            'background-image': `url(${url})`,
          });
          setPickedPreview({
            projectPath: projectPath,
            path: assetMatchPath(url) ?? url,
            source: convertFileSrc(asset.fullPath),
          });
          pickerIdRef.current = null;
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), 'error');
          throw error;
        }
      },
    });
  };

  const reset: ResetSpec = {
    match: (token) => {
      let bare = token.replace(/^!/, '').replace(/!$/, '');
      if (layer.utilityPrefix && bare.startsWith(layer.utilityPrefix))
        bare = bare.slice(layer.utilityPrefix.length);
      return bare.startsWith('bg-[url(');
    },
    cssProps: ['background-image'],
    utilityPrefix: layer.utilityPrefix,
  };

  return (
    <div className="ss-edit-panel__control ss-background-image-control">
      <span className="ss-edit-panel__label ss-background-image-control__label">Image</span>
      <div className="ss-background-image-control__actions">
        {isSimpleImage ? (
          <div className="ss-background-image-control__field">
            <PropertyField
              className="ss-background-image-control__pick"
              aria-label={`Choose background image: ${filename}`}
              title={filename}
              disabled={!canPick}
              onClick={openPicker}
            >
              <span className="ss-background-image-control__thumbnail" aria-hidden="true">
                <ImageIcon size={14} />
                {thumbnailSource && <img src={thumbnailSource} alt="" />}
              </span>
              <span className="ss-background-image-control__filename">{filename}</span>
            </PropertyField>
            <TextButton
              className="ss-background-image-control__reset"
              aria-label="Reset background image"
              onClick={() => onReset(reset)}
            >
              Reset
            </TextButton>
          </div>
        ) : (
          <Button
            variant="default"
            leftIcon={<ImageIcon size={14} />}
            disabled={!canPick}
            onClick={openPicker}
            title={isComplex ? 'Edit layered images in Custom CSS to preserve them' : undefined}
          >
            Choose image…
          </Button>
        )}
        {isComplex ? (
          <span className="ss-background-image-control__note">
            Layered or gradient image values are kept as authored.
          </span>
        ) : !isSimpleImage ? (
          <Button variant="ghost" size="compact" disabled onClick={() => onReset(reset)}>
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}
