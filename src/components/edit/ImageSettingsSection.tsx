import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { ValueField } from '../primitives/ValueField';
import { CodeIcon, CopyIcon, LockedIcon } from '@/components/icons';
import { EnumDropdown } from './EnumDropdown';
import { PropSection } from './PropSection';
import { JsonImageEditConfirmation } from './JsonImageEditConfirmation';
import { AssetsModal } from '../workspace/AssetsPanel';
import { useOptionalAssetBrowser } from '../../contexts/AssetBrowserContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { safeImageResourceSrc, useImageNaturalSize } from '../../hooks/useImageNaturalSize';
import { assetWebPath, type Asset } from '../../lib/assets';
import type { OpenInCode } from '../../lib/code';
import {
  applyJsonImageSourceEdit,
  parseImageSourceReference,
  type ElementSignature,
} from '../../lib/edit';
import type { ElementAttr, ElementSettings } from '../../hooks/useElementSettings';
import {
  useImageSourceEditConfirmation,
  useImageSourceResolution,
} from '../../hooks/useImageSourceEditing';

const MAX_PREVIEW_DATA_URL_LENGTH = 500_000;
const IMAGE_DIMENSION_KEYWORDS = [
  { value: 'auto', label: 'Auto', kind: 'keyword' as const },
  { value: 'min-content', label: 'Min content', kind: 'keyword' as const },
  { value: 'max-content', label: 'Max content', kind: 'keyword' as const },
  { value: 'fit-content', label: 'Fit content', kind: 'keyword' as const },
];

export type ImageCssDimensionSetter = (
  property: 'width' | 'height',
  value: string | null
) => boolean;
export type ImageCssDimensions = Partial<Record<'width' | 'height', string>>;

function imageFilename(source: string | null | undefined): string | null {
  const value = source?.trim();
  if (!value || value.includes('{')) return null;
  let path = value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    path = url.pathname;
  } catch {
    // A relative asset path is already known data; leave it relative rather
    // than resolving it against the Ship Studio shell's origin.
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  }
  const withoutSuffix = path.split(/[?#]/, 1)[0] ?? path;
  const segment = withoutSuffix.split('/').filter(Boolean).pop();
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function dimensionFieldValue(value: string): string {
  return /^\d+(?:\.\d+)?$/.test(value) ? `${value}px` : value;
}

function htmlPixelDimension(value: string): string | null {
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && Number.isInteger(number) ? String(number) : null;
}

function cssSupportsDimension(property: 'width' | 'height', value: string): boolean {
  return (
    typeof CSS === 'undefined' ||
    typeof CSS.supports !== 'function' ||
    CSS.supports(property, value)
  );
}

function safeImagePreviewSrc(signature: ElementSignature): string | null {
  const rasterPreview = signature.currentPreview;
  if (
    rasterPreview &&
    rasterPreview.length <= MAX_PREVIEW_DATA_URL_LENGTH &&
    /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      rasterPreview
    )
  ) {
    return rasterPreview;
  }

  return safeImageResourceSrc(signature.currentSrc);
}

/** Image-specific source and accessibility fields in the CSS editor's Settings tab. */
export function ImageSettingsSection({
  settings,
  signature,
  projectPath,
  onOpenInCode,
  onSetCssDimension,
  cssDimensions,
}: {
  settings: ElementSettings;
  signature: ElementSignature;
  projectPath: string;
  onOpenInCode?: OpenInCode;
  onSetCssDimension?: ImageCssDimensionSetter;
  cssDimensions?: ImageCssDimensions;
}) {
  const browser = useOptionalAssetBrowser();
  const cancelPicker = browser?.cancelPicker;
  const { showToast } = useOptionalToast();
  const { copy, isCopied } = useCopyToClipboard();
  const fieldIdPrefix = useId();
  const { resolution: imageResolution, setResolution: setImageResolution } =
    useImageSourceResolution(projectPath, signature, settings.selectionKey);
  const [legacyPickerState, setLegacyPickerState] = useState({
    selectionKey: settings.selectionKey,
    open: false,
  });
  const legacyPickerOpen =
    legacyPickerState.selectionKey === settings.selectionKey && legacyPickerState.open;
  const [previewState, setPreviewState] = useState<{
    identity: string;
    status: 'loaded' | 'error';
  } | null>(null);
  const pickerIdRef = useRef<number | null>(null);
  const selectionKeyRef = useRef(settings.selectionKey);
  const src = settings.attributes.find((attr) => attr.name.toLowerCase() === 'src');
  const srcset = settings.attributes.find((attr) => attr.name.toLowerCase() === 'srcset');
  const alt = settings.attributes.find((attr) => attr.name.toLowerCase() === 'alt');
  const width = settings.attributes.find((attr) => attr.name.toLowerCase() === 'width');
  const height = settings.attributes.find((attr) => attr.name.toLowerCase() === 'height');
  const loading = settings.attributes.find((attr) => attr.name.toLowerCase() === 'loading');
  const renderedSrc = src ? null : signature.attrSrc;
  const renderedAlt = alt ? null : signature.attrAlt;
  const renderedWidth = width ? null : signature.attrWidth;
  const renderedHeight = height ? null : signature.attrHeight;
  const renderedLoading = loading ? null : signature.attrLoading;
  const jsonSource = imageResolution?.status === 'json_property' ? imageResolution : null;
  const jsonReferences = jsonSource
    ? jsonSource.references.filter((reference) => {
        const location = parseImageSourceReference(reference);
        return (
          !location ||
          location.file !== jsonSource.source_file ||
          location.line !== jsonSource.source_line ||
          location.column !== jsonSource.source_column
        );
      })
    : [];
  const displayedSrc: ElementAttr | undefined = jsonSource
    ? { name: src?.name ?? 'src', value: jsonSource.src }
    : (src ?? (renderedSrc == null ? undefined : { name: 'src', value: renderedSrc }));
  const displayedAlt: ElementAttr | undefined =
    alt ?? (renderedAlt == null ? undefined : { name: 'alt', value: renderedAlt });
  const displayedWidth: ElementAttr | undefined =
    width ?? (renderedWidth == null ? undefined : { name: 'width', value: renderedWidth });
  const displayedHeight: ElementAttr | undefined =
    height ?? (renderedHeight == null ? undefined : { name: 'height', value: renderedHeight });
  const displayedLoading: ElementAttr | undefined =
    loading ?? (renderedLoading == null ? undefined : { name: 'loading', value: renderedLoading });
  const loadingSourceUnavailable = settings.sourceMarkupStatus !== 'resolved';
  const sourceMarkupUnavailable = settings.sourceMarkupStatus === 'unavailable';
  const sourcePlaceholder =
    settings.sourceMarkupStatus === 'resolving'
      ? 'Resolving source…'
      : settings.sourceMarkupStatus === 'unavailable'
        ? 'Source unavailable'
        : settings.sourceMarkupStatus === 'idle'
          ? 'Source not resolved'
          : 'Not set';
  const fieldPlaceholder = (hasKnownValue: boolean) =>
    hasKnownValue ? '' : settings.sourceMarkupStatus === 'resolved' ? 'Not set' : sourcePlaceholder;
  const hasRenderedAttributeFallback = [
    !src && renderedSrc != null,
    !alt && renderedAlt != null,
    !width && renderedWidth != null,
    !height && renderedHeight != null,
    !loading && renderedLoading != null,
  ].some(Boolean);
  const sourceLabel = jsonSource
    ? `JSON: ${jsonSource.file} › ${jsonSource.property_path.join('.')}`
    : settings.sourceMarkupStatus === 'resolved'
      ? (src?.value ??
        (renderedSrc != null ? `Rendered: ${renderedSrc}` : 'No src attribute in source markup'))
      : settings.sourceMarkupStatus === 'resolving'
        ? 'Resolving source markup…'
        : 'Source markup unavailable';
  const selectedSourceLocation =
    imageResolution?.status === 'resolved'
      ? { file: imageResolution.file, line: imageResolution.line }
      : imageResolution?.status === 'json_property'
        ? { file: imageResolution.source_file, line: imageResolution.source_line }
        : settings.location;
  const sourceCodeLocation = selectedSourceLocation;
  const elementCodeLocation = settings.location;
  const sourceFieldValue = jsonSource
    ? `src={${jsonSource.expression}}`
    : src?.isExpression
      ? `src=${src.value}`
      : src
        ? `src=${JSON.stringify(src.value)}`
        : imageResolution?.status === 'resolved'
          ? `src=${JSON.stringify(imageResolution.src)}`
          : '';
  const sourceFieldPlaceholder = sourceFieldValue
    ? undefined
    : settings.imageAttributeEditBlockReason
      ? 'Unavailable'
      : sourcePlaceholder;
  const sourceFieldTitle = jsonSource
    ? `JSON value: ${jsonSource.file} › ${jsonSource.property_path.join('.')}`
    : selectedSourceLocation
      ? `Selected image source location: ${selectedSourceLocation.file}:${selectedSourceLocation.line}`
      : imageResolution?.status === 'read_only'
        ? imageResolution.reason
        : 'Source location unavailable.';
  const previewSrc = safeImagePreviewSrc(signature);
  const previewFilename =
    imageFilename(signature.currentSrc) ??
    imageFilename(displayedSrc?.value) ??
    imageFilename(signature.attrSrc);
  const previewIdentity = `${settings.selectionKey}:${previewSrc ?? ''}`;
  const { size: currentNaturalSize, status: sourceDimensionsStatus } = useImageNaturalSize(
    signature,
    settings.selectionKey
  );
  const previewStatus = !previewSrc
    ? signature.currentSrc || signature.currentPreview
      ? 'unsafe'
      : 'missing'
    : previewState?.identity === previewIdentity
      ? previewState.status
      : 'loading';
  const dynamicSrc = src?.isExpression ?? false;
  const dynamicSrcset = srcset?.isExpression ?? false;
  const dynamicFields = [src, srcset, alt, width, height, loading].filter(
    (attr): attr is ElementAttr => Boolean(attr?.isExpression)
  );
  const dynamicFieldsReadOnly = dynamicFields.filter(
    (attr) => !(jsonSource && attr.name.toLowerCase() === 'src')
  );
  const hasSrcset = Boolean(srcset);
  const insidePicture =
    signature.elementPath?.slice(0, -1).some((item) => item.tagName.toLowerCase() === 'picture') ??
    false;
  const sourceMarkupReason =
    settings.sourceMarkupStatus === 'resolving'
      ? 'Source markup is still resolving.'
      : settings.sourceMarkupStatus === 'unavailable'
        ? 'Source markup could not be mapped, so image values are read-only.'
        : settings.sourceMarkupStatus === 'idle'
          ? 'Source markup has not been resolved, so image values are read-only.'
          : null;
  const imageEditBlockReason =
    settings.imageAttributeEditBlockReason === 'ambiguous'
      ? 'Several identical source locations match this image.'
      : settings.imageAttributeEditBlockReason === 'spread'
        ? 'A spread attribute may provide image values.'
        : settings.imageAttributeEditBlockReason === 'mismatch'
          ? 'The rendered image attributes do not match the source markup.'
          : null;
  const readonlyReasonId = `${fieldIdPrefix}-readonly-reason`;
  const fieldDescriptionId = (disabled: boolean) =>
    disabled &&
    (dynamicFieldsReadOnly.length > 0 ||
      jsonSource != null ||
      insidePicture ||
      imageEditBlockReason != null ||
      sourceMarkupReason != null ||
      !settings.canEditAttributes)
      ? readonlyReasonId
      : undefined;
  const sourceFieldDisabledReason = (attribute?: ElementAttr) => {
    if (jsonSource && attribute?.name.toLowerCase() === 'src') {
      if (settings.busy) return 'Image settings are being saved.';
      if (hasSrcset) return 'This image has responsive srcset markup.';
      if (insidePicture) return 'This image is inside a picture element with responsive sources.';
      return '';
    }
    if (attribute?.isExpression) return 'This value is generated by code.';
    if (settings.busy) return 'Image settings are being saved.';
    return sourceMarkupReason ?? (!settings.canEditAttributes ? 'Image values are read-only.' : '');
  };
  const urlDisabledReason = jsonSource
    ? sourceFieldDisabledReason(src)
    : sourceFieldDisabledReason(src) ||
      (dynamicSrcset
        ? 'The image source set is generated by code.'
        : insidePicture
          ? 'This image is inside a picture element with responsive sources.'
          : (imageEditBlockReason ?? ''));
  const srcDisabled = jsonSource
    ? settings.busy || hasSrcset || insidePicture
    : !settings.canEditAttributes ||
      settings.busy ||
      !!settings.imageAttributeEditBlockReason ||
      dynamicSrc ||
      dynamicSrcset ||
      insidePicture;
  const altDisabled = !settings.canEditAttributes || settings.busy || (alt?.isExpression ?? false);
  const canEditCssDimensions = Boolean(onSetCssDimension) && !settings.busy;
  const canEditWidthAttribute =
    settings.canEditAttributes && !settings.busy && !(width?.isExpression ?? false);
  const canEditHeightAttribute =
    settings.canEditAttributes && !settings.busy && !(height?.isExpression ?? false);
  const widthDisabled = !canEditWidthAttribute && !canEditCssDimensions;
  const heightDisabled = !canEditHeightAttribute && !canEditCssDimensions;
  const widthDisabledReason = widthDisabled
    ? sourceFieldDisabledReason(width) || 'Image dimensions are read-only.'
    : undefined;
  const heightDisabledReason = heightDisabled
    ? sourceFieldDisabledReason(height) || 'Image dimensions are read-only.'
    : undefined;
  const loadingDisabled =
    !settings.canEditAttributes ||
    settings.busy ||
    (loading?.isExpression ?? false) ||
    settings.imageAttributeEditBlockReason != null;
  const loadingDisabledReason = loading?.isExpression
    ? 'Loading behavior is generated by code.'
    : settings.busy
      ? 'Image settings are being saved.'
      : (imageEditBlockReason ??
        sourceMarkupReason ??
        (!settings.canEditAttributes ? 'Image values are read-only.' : undefined));
  const canReplace = jsonSource
    ? !settings.busy && !hasSrcset && !insidePicture
    : settings.canEditAttributes &&
      !settings.busy &&
      !dynamicSrc &&
      !dynamicSrcset &&
      !insidePicture &&
      !settings.imageAttributeEditBlockReason;
  const replaceDisabledReason =
    jsonSource && hasSrcset
      ? 'This image has responsive srcset markup.'
      : jsonSource && insidePicture
        ? 'This image is inside a picture element with responsive sources.'
        : !settings.canEditAttributes
          ? (sourceMarkupReason ?? 'Image values are read-only.')
          : settings.busy
            ? 'Image settings are being saved.'
            : dynamicSrc
              ? 'This image source is generated by code.'
              : dynamicSrcset
                ? 'The image source set is generated by code.'
                : insidePicture
                  ? 'This image is inside a picture element with responsive sources.'
                  : (imageEditBlockReason ?? undefined);
  const readonlyDescriptionAvailable =
    Boolean(jsonSource) ||
    dynamicFieldsReadOnly.length > 0 ||
    insidePicture ||
    settings.imageAttributeEditBlockReason != null ||
    sourceMarkupUnavailable ||
    settings.sourceMarkupStatus === 'resolving' ||
    settings.sourceMarkupStatus === 'idle' ||
    !settings.canEditAttributes;

  useLayoutEffect(() => {
    if (selectionKeyRef.current === settings.selectionKey) return;
    if (pickerIdRef.current != null) cancelPicker?.(pickerIdRef.current);
    pickerIdRef.current = null;
    selectionKeyRef.current = settings.selectionKey;
  }, [cancelPicker, settings.selectionKey]);

  useEffect(
    () => () => {
      if (pickerIdRef.current != null) cancelPicker?.(pickerIdRef.current);
    },
    [cancelPicker]
  );

  const replaceJsonSource = useCallback(
    async (value: string, confirmedShared = false) => {
      if (!jsonSource) throw new Error('The image source is no longer mapped to JSON.');
      try {
        await applyJsonImageSourceEdit(projectPath, jsonSource, value, confirmedShared);
        setImageResolution({ ...jsonSource, src: value });
        showToast('Image replaced', 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
        throw error;
      }
    },
    [jsonSource, projectPath, setImageResolution, showToast]
  );
  const sourceEdit = useImageSourceEditConfirmation(
    imageResolution,
    `${projectPath}:${settings.selectionKey}`,
    replaceJsonSource
  );

  const saveAttribute = async (name: string, value: string | null) => {
    if (settings.busy) return false;
    if (name.toLowerCase() === 'src' && !value?.trim()) {
      showToast('Image URLs cannot be empty.', 'info');
      return false;
    }
    if (name.toLowerCase() === 'src' && jsonSource && value != null) {
      try {
        await sourceEdit.requestReplacement(value);
        return true;
      } catch {
        return false;
      }
    }
    return settings.setAttribute(name, value);
  };

  const saveDimension = async (
    name: 'width' | 'height',
    value: string,
    canSaveAttribute: boolean
  ) => {
    if (settings.busy) return false;
    const trimmed = value.trim();
    const htmlValue = htmlPixelDimension(trimmed);

    if (!trimmed) {
      if (onSetCssDimension && !onSetCssDimension(name, null)) return false;
      return canSaveAttribute ? saveAttribute(name, null) : Boolean(onSetCssDimension);
    }

    if (htmlValue !== null && canSaveAttribute) {
      if (onSetCssDimension && !onSetCssDimension(name, null)) return false;
      return saveAttribute(name, htmlValue);
    }

    if (!onSetCssDimension) return false;
    const cssValue = htmlValue === null ? trimmed : `${htmlValue}px`;
    if (!cssSupportsDimension(name, cssValue)) return false;
    if (!onSetCssDimension(name, cssValue)) return false;
    return canSaveAttribute ? saveAttribute(name, null) : true;
  };

  const replaceWithAsset = async (asset: Asset, root: string, expectedSelection: string) => {
    if (selectionKeyRef.current !== expectedSelection) return;
    let webPath: string;
    try {
      webPath = assetWebPath(root, asset.path);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      throw error;
    }
    const saved = await saveAttribute('src', webPath);
    if (!saved) throw new Error('The image source could not be updated.');
    pickerIdRef.current = null;
  };

  const openPicker = () => {
    const expectedSelection = settings.selectionKey;
    if (browser) {
      pickerIdRef.current = browser.openPicker({
        projectPath,
        title: 'Replace image',
        onPick: (asset, root) => replaceWithAsset(asset, root, expectedSelection),
      });
    } else {
      setLegacyPickerState({ selectionKey: settings.selectionKey, open: true });
    }
  };

  const imageRequest =
    `Update the selected image in my project.\n\n` +
    `Element: <img>${signature.className ? ` (classes: "${signature.className}")` : ''}\n` +
    (dynamicFields.length
      ? `Code-generated fields: ${dynamicFields.map((attr) => attr.name).join(', ')}\n`
      : '') +
    (insidePicture ? 'The image is inside a <picture> element with responsive sources.\n' : '') +
    (settings.imageAttributeEditBlockReason === 'ambiguous'
      ? 'Several identical source instances match this image.\n'
      : settings.imageAttributeEditBlockReason === 'spread'
        ? 'A spread attribute may supply image attributes.\n'
        : settings.imageAttributeEditBlockReason === 'mismatch'
          ? 'The selected image’s rendered attributes do not match the source markup found.\n'
          : '') +
    (settings.location ? `Near: ${settings.location.file}:${settings.location.line}\n` : '') +
    `Current source: ${src?.value ?? signature.attrSrc ?? '(unknown)'}`;

  return (
    <PropSection title="Image Settings" sectionId="settings-image" defaultOpen>
      <div className="ss-edit-panel__control ss-settings-image__asset-control">
        <span className="ss-edit-panel__label">Image</span>
        <div className="ss-settings-image__asset-card">
          <div className="ss-settings-image__asset-summary">
            {previewSrc ? (
              <img
                className="ss-settings-image__preview"
                src={previewSrc}
                alt={displayedAlt?.value || 'Selected image preview'}
                onLoad={() => {
                  setPreviewState({ identity: previewIdentity, status: 'loaded' });
                }}
                onError={() => setPreviewState({ identity: previewIdentity, status: 'error' })}
              />
            ) : (
              <span
                className="ss-settings-image__preview ss-settings-image__preview--empty"
                aria-label={
                  previewStatus === 'unsafe'
                    ? 'Image preview unavailable for this source'
                    : 'No rendered image source'
                }
                role="img"
              />
            )}
            <div className="ss-settings-image__preview-meta">
              <code title={src?.value ?? signature.attrSrc ?? undefined}>
                {previewFilename ?? sourceLabel}
              </code>
              {currentNaturalSize && (
                <span>
                  {currentNaturalSize.width} × {currentNaturalSize.height} px
                </span>
              )}
              {sourceDimensionsStatus && (
                <span aria-live="polite">
                  {sourceDimensionsStatus === 'loading'
                    ? 'Loading dimensions…'
                    : 'Dimensions unavailable.'}
                </span>
              )}
              {previewStatus !== 'loaded' && (
                <span
                  className="ss-settings-image__preview-status"
                  role="status"
                  aria-live="polite"
                >
                  {previewStatus === 'loading'
                    ? 'Loading preview…'
                    : previewStatus === 'error'
                      ? 'Image preview failed to load.'
                      : previewStatus === 'unsafe'
                        ? 'Preview unavailable for this image source.'
                        : settings.sourceMarkupStatus === 'resolving'
                          ? 'Waiting for rendered image…'
                          : 'No rendered image source.'}
                </span>
              )}
            </div>
          </div>
          <Button
            variant="default"
            width="fill"
            disabled={!canReplace}
            title={!canReplace ? replaceDisabledReason : undefined}
            aria-label="Replace image…"
            aria-describedby={fieldDescriptionId(!canReplace)}
            onClick={openPicker}
          >
            Replace
          </Button>
        </div>
      </div>

      <ImageTextAttributeField
        key={`${settings.selectionKey}:src`}
        id={`${fieldIdPrefix}-src`}
        label="URL"
        value={displayedSrc?.value ?? ''}
        disabled={srcDisabled}
        disabledReason={urlDisabledReason}
        describedBy={fieldDescriptionId(srcDisabled)}
        locked={srcDisabled && !settings.busy}
        codeLocation={sourceCodeLocation}
        onOpenInCode={onOpenInCode}
        onSave={(value) => saveAttribute('src', value)}
        placeholder={fieldPlaceholder(displayedSrc != null)}
      />
      <ImageTextAttributeField
        key={`${settings.selectionKey}:alt`}
        id={`${fieldIdPrefix}-alt`}
        label="Alt text"
        value={displayedAlt?.value ?? ''}
        disabled={altDisabled}
        disabledReason={sourceFieldDisabledReason(alt)}
        describedBy={fieldDescriptionId(altDisabled)}
        locked={altDisabled && !settings.busy}
        codeLocation={elementCodeLocation}
        onOpenInCode={onOpenInCode}
        onSave={(value) => saveAttribute('alt', value)}
        placeholder={fieldPlaceholder(displayedAlt != null)}
      />
      <div className="ss-settings-image__dimensions">
        <ImageDimensionField
          key={`${settings.selectionKey}:width`}
          id={`${fieldIdPrefix}-width`}
          label="Width"
          property="width"
          value={dimensionFieldValue(cssDimensions?.width ?? displayedWidth?.value ?? '')}
          cssDimensionsSupported={Boolean(onSetCssDimension)}
          canSaveAttribute={canEditWidthAttribute}
          disabled={widthDisabled}
          disabledReason={widthDisabledReason}
          describedBy={fieldDescriptionId(widthDisabled)}
          locked={widthDisabled && !settings.busy}
          codeLocation={elementCodeLocation}
          onOpenInCode={onOpenInCode}
          placeholder={
            fieldPlaceholder(cssDimensions?.width != null || displayedWidth != null) || undefined
          }
          onSave={(value) => saveDimension('width', value, canEditWidthAttribute)}
        />
        <ImageDimensionField
          key={`${settings.selectionKey}:height`}
          id={`${fieldIdPrefix}-height`}
          label="Height"
          property="height"
          value={dimensionFieldValue(cssDimensions?.height ?? displayedHeight?.value ?? '')}
          cssDimensionsSupported={Boolean(onSetCssDimension)}
          canSaveAttribute={canEditHeightAttribute}
          disabled={heightDisabled}
          disabledReason={heightDisabledReason}
          describedBy={fieldDescriptionId(heightDisabled)}
          locked={heightDisabled && !settings.busy}
          codeLocation={elementCodeLocation}
          onOpenInCode={onOpenInCode}
          placeholder={
            fieldPlaceholder(cssDimensions?.height != null || displayedHeight != null) || undefined
          }
          onSave={(value) => saveDimension('height', value, canEditHeightAttribute)}
        />
      </div>
      <div className="ss-edit-panel__control ss-settings-image__control">
        <span className="ss-edit-panel__label" id={`${fieldIdPrefix}-loading-label`}>
          Loading
        </span>
        <ReadonlyFieldSlot
          locked={loadingDisabled && !settings.busy}
          label="image loading behavior"
          location={elementCodeLocation}
          onOpenInCode={onOpenInCode}
        >
          <EnumDropdown
            label="Loading"
            value={
              displayedLoading?.value || (loadingSourceUnavailable ? '__source_unknown' : 'auto')
            }
            options={[
              ...(loadingSourceUnavailable && !displayedLoading
                ? [
                    {
                      label:
                        settings.sourceMarkupStatus === 'resolving'
                          ? 'Resolving source…'
                          : 'Source unavailable',
                      token: '__source_unknown',
                    },
                  ]
                : []),
              ...(!['', 'auto', 'lazy', 'eager'].includes(displayedLoading?.value ?? '') &&
              displayedLoading
                ? [{ label: displayedLoading.value, token: displayedLoading.value }]
                : []),
              { label: 'Auto', token: 'auto' },
              { label: 'Lazy', token: 'lazy' },
              { label: 'Eager', token: 'eager' },
            ]}
            disabled={loadingDisabled}
            title={loadingDisabledReason || undefined}
            describedBy={fieldDescriptionId(loadingDisabled)}
            onChange={(value) => void saveAttribute('loading', value === 'auto' ? null : value)}
          />
        </ReadonlyFieldSlot>
      </div>

      <div
        className="ss-settings-image__metadata-divider"
        role="separator"
        aria-orientation="horizontal"
      />
      <div className="ss-settings-image__metadata">
        <div className="ss-edit-panel__control ss-settings-image__control">
          <label className="ss-edit-panel__label" htmlFor={`${fieldIdPrefix}-source`}>
            Source
          </label>
          <ReadonlyFieldSlot
            locked
            label="image source binding"
            location={selectedSourceLocation}
            onOpenInCode={onOpenInCode}
          >
            <TextField
              id={`${fieldIdPrefix}-source`}
              className="ss-settings-image__field-control"
              aria-label="Source"
              value={sourceFieldValue}
              placeholder={sourceFieldPlaceholder}
              disabled
              title={sourceFieldTitle}
              aria-describedby={fieldDescriptionId(true)}
            />
          </ReadonlyFieldSlot>
        </div>
        {(jsonSource || !selectedSourceLocation) && (
          <div className="ss-edit-panel__control ss-settings-image__source-row">
            <span className="ss-edit-panel__label ss-settings-image__source-label">References</span>
            <div className="ss-settings-image__source-value">
              {jsonSource ? (
                jsonReferences.length > 0 ? (
                  <div className="ss-settings-image__references">
                    {jsonReferences.map((reference) => {
                      const location = parseImageSourceReference(reference);
                      const label = location
                        ? `Open reference in ${location.file}, line ${location.line}`
                        : undefined;
                      return location && onOpenInCode ? (
                        <TextButton
                          key={reference}
                          className="ss-settings-image__reference-link"
                          aria-label={label}
                          title={label}
                          onClick={() => onOpenInCode(location.file, location.line)}
                        >
                          <code>{`${location.file}:${location.line}`}</code>
                        </TextButton>
                      ) : (
                        <code key={reference} className="ss-settings-image__reference-text">
                          {location ? `${location.file}:${location.line}` : reference}
                        </code>
                      );
                    })}
                  </div>
                ) : (
                  <span className="ss-settings-image__reference-text">No other references.</span>
                )
              ) : (
                <ReadonlyFieldSlot
                  locked
                  label="image references"
                  location={null}
                  onOpenInCode={onOpenInCode}
                >
                  <TextField
                    id={`${fieldIdPrefix}-references`}
                    className="ss-settings-image__field-control"
                    aria-label="References"
                    value="Unavailable"
                    disabled
                  />
                </ReadonlyFieldSlot>
              )}
            </div>
          </div>
        )}
        {selectedSourceLocation && (
          <div className="ss-edit-panel__control ss-settings-image__source-row">
            <span className="ss-edit-panel__label ss-settings-image__source-label">
              {jsonSource ? 'Defined in' : 'File location'}
            </span>
            <div className="ss-settings-image__file-location">
              {onOpenInCode ? (
                <TextButton
                  className="ss-settings-image__file-location-link"
                  aria-label={`Open ${selectedSourceLocation.file}, line ${selectedSourceLocation.line} in Code`}
                  title="Open this source location in Code"
                  onClick={() =>
                    onOpenInCode(selectedSourceLocation.file, selectedSourceLocation.line)
                  }
                >
                  <code>{`${selectedSourceLocation.file}:${selectedSourceLocation.line}`}</code>
                </TextButton>
              ) : (
                <code>{`${selectedSourceLocation.file}:${selectedSourceLocation.line}`}</code>
              )}
            </div>
          </div>
        )}
        {jsonSource && jsonSource.literal_references.length > 0 && (
          <div className="ss-edit-panel__control ss-settings-image__source-row">
            <span className="ss-edit-panel__label ss-settings-image__source-label">
              Matching URL literals (not changed)
            </span>
            <div className="ss-settings-image__literal-references ss-settings-image__source-value">
              {jsonSource.literal_references.map((reference) => (
                <code key={reference}>{reference}</code>
              ))}
            </div>
          </div>
        )}
        {jsonSource && !jsonSource.scope_known && (
          <p className="ss-settings-image__scope-note">
            Other access to this JSON import could not be classified; confirmation is required.
          </p>
        )}
        {readonlyDescriptionAvailable && (
          <div className="ss-settings-image__handoff">
            <p id={readonlyReasonId}>
              {jsonSource &&
                `The URL updates ${jsonSource.file} › ${jsonSource.property_path.join('.')}; the authored src expression stays in place.`}
              {!jsonSource &&
                settings.sourceMarkupStatus === 'resolving' &&
                'The selected image’s source markup is still resolving, so its saved values stay read-only here.'}
              {!jsonSource &&
                settings.sourceMarkupStatus === 'idle' &&
                'The selected image’s source markup has not been resolved, so its saved values stay read-only here.'}
              {!jsonSource &&
                sourceMarkupUnavailable &&
                'The selected image’s source markup could not be mapped, so its saved values stay read-only here.'}
              {!jsonSource &&
                settings.sourceMarkupStatus !== 'resolved' &&
                hasRenderedAttributeFallback &&
                ' Known attribute values below come from the rendered image and stay read-only as HTML until its source is mapped.'}
              {dynamicFieldsReadOnly.length > 0 && (
                <>
                  {dynamicFieldsReadOnly.map((attr) => attr.name).join(', ')}{' '}
                  {dynamicFieldsReadOnly.length === 1 ? 'is' : 'are'} set by code and stay read-only
                  here.
                </>
              )}
              {insidePicture &&
                ' This image is inside a <picture> element, which can use sibling responsive sources.'}
              {settings.imageAttributeEditBlockReason === 'ambiguous' &&
                ' This image matches several identical source locations, so editing here could change more than the selected image.'}
              {settings.imageAttributeEditBlockReason === 'spread' &&
                ' A spread attribute may provide image values, so its attributes cannot be changed safely here.'}
              {settings.imageAttributeEditBlockReason === 'mismatch' &&
                ' The selected image’s rendered attributes do not match the source markup found. The displayed values are read-only until the image source is matched.'}
              {!settings.canEditAttributes &&
                !jsonSource &&
                !sourceMarkupReason &&
                !imageEditBlockReason &&
                dynamicFieldsReadOnly.length === 0 &&
                !insidePicture &&
                ' Image values are read-only here.'}
              {' Copy to alter with agent'}
            </p>
            <TextButton
              width="hug"
              rightIcon={<CopyIcon size={14} />}
              onClick={() => void copy(imageRequest)}
            >
              {isCopied ? 'Request copied' : 'Copy request'}
            </TextButton>
          </div>
        )}
      </div>

      {!browser && (
        <AssetsModal
          projectPath={projectPath}
          isOpen={legacyPickerOpen}
          onClose={() => setLegacyPickerState({ selectionKey: settings.selectionKey, open: false })}
          pick={{
            title: 'Replace image',
            onPick: (asset, root) => replaceWithAsset(asset, root, settings.selectionKey),
          }}
        />
      )}

      <JsonImageEditConfirmation
        resolution={imageResolution}
        value={sourceEdit.pendingValue}
        applying={sourceEdit.applying}
        onCancel={sourceEdit.cancel}
        onConfirm={() => void sourceEdit.confirm()}
      />
    </PropSection>
  );
}

function ReadonlyFieldSlot({
  children,
  locked = false,
  label,
  location,
  onOpenInCode,
}: {
  children: ReactNode;
  locked?: boolean;
  label: string;
  location?: { file: string; line: number } | null;
  onOpenInCode?: OpenInCode;
}) {
  if (!locked) return <>{children}</>;
  const actionLabel = location
    ? `Open ${label} in ${location.file}, line ${location.line}`
    : `Open ${label} in code`;
  return (
    <div className="ss-settings-image__readonly-control">
      <div
        className={[
          'ss-settings-image__field-shell',
          locked ? 'ss-settings-image__field-shell--locked' : null,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
        {locked && (
          <span className="ss-settings-image__lock" aria-hidden="true" title="Read-only">
            <LockedIcon size={12} />
          </span>
        )}
      </div>
      <span className="ss-settings-image__code-action-slot">
        {locked && onOpenInCode && location ? (
          <IconButton
            size="compact"
            variant="ghost"
            className="ss-settings-image__code-action"
            icon={<CodeIcon size={14} />}
            aria-label={actionLabel}
            title={actionLabel}
            onClick={() => onOpenInCode(location.file, location.line)}
          />
        ) : (
          <span aria-hidden="true" />
        )}
      </span>
    </div>
  );
}

function ImageTextAttributeField({
  id,
  label,
  value,
  disabled,
  disabledReason,
  describedBy,
  locked = false,
  codeLocation,
  onOpenInCode,
  onSave,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  disabledReason?: string;
  describedBy?: string;
  locked?: boolean;
  codeLocation?: { file: string; line: number } | null;
  onOpenInCode?: OpenInCode;
  onSave: (value: string) => Promise<boolean>;
  placeholder?: string;
}) {
  const [draftState, setDraftState] = useState({ value, draft: value });
  const cancelPendingBlurRef = useRef(false);
  const draft = draftState.value === value ? draftState.draft : value;
  const commit = () => {
    if (cancelPendingBlurRef.current) {
      cancelPendingBlurRef.current = false;
      return;
    }
    if (!disabled && draft !== value) void onSave(draft);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelPendingBlurRef.current = true;
      setDraftState({ value, draft: value });
      event.currentTarget.blur();
    }
  };
  return (
    <div className="ss-edit-panel__control ss-settings-image__control">
      <label className="ss-edit-panel__label" htmlFor={id}>
        {label}
      </label>
      <ReadonlyFieldSlot
        locked={locked}
        label={label === 'URL' ? 'selected image source' : label.toLowerCase()}
        location={codeLocation}
        onOpenInCode={onOpenInCode}
      >
        <TextField
          id={id}
          className="ss-settings-image__field-control"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          title={disabled ? disabledReason : undefined}
          aria-describedby={describedBy}
          onChange={(event) => setDraftState({ value, draft: event.target.value })}
          onBlur={commit}
          onKeyDown={handleKeyDown}
        />
      </ReadonlyFieldSlot>
    </div>
  );
}

function ImageDimensionField({
  id,
  label,
  property,
  value,
  disabled,
  disabledReason,
  describedBy,
  locked = false,
  codeLocation,
  onOpenInCode,
  placeholder,
  cssDimensionsSupported,
  canSaveAttribute,
  onSave,
}: {
  id: string;
  label: string;
  property: 'width' | 'height';
  value: string;
  disabled: boolean;
  disabledReason?: string;
  describedBy?: string;
  locked?: boolean;
  codeLocation?: { file: string; line: number } | null;
  onOpenInCode?: OpenInCode;
  placeholder?: string;
  cssDimensionsSupported: boolean;
  canSaveAttribute: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  return (
    <div className="ss-edit-panel__control ss-settings-image__control ss-settings-image__dimension-control">
      <label className="ss-edit-panel__label" htmlFor={id}>
        {label}
      </label>
      <ReadonlyFieldSlot
        locked={locked}
        label={`${label.toLowerCase()} dimension`}
        location={codeLocation}
        onOpenInCode={onOpenInCode}
      >
        <ValueField
          id={id}
          className="ss-settings-image__field-control"
          variant="length"
          defaultUnit="px"
          keywords={IMAGE_DIMENSION_KEYWORDS}
          value={value}
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          aria-label={label}
          aria-describedby={describedBy}
          inputMode="decimal"
          min={0}
          commitEmpty
          placeholder={placeholder}
          unitSelectorDisabled={disabled}
          filterOption={(option) => {
            if (disabled) return true;
            if (option.kind === 'variable') return cssDimensionsSupported;
            if (option.kind === 'keyword') {
              return cssDimensionsSupported && cssSupportsDimension(property, option.value);
            }
            if (option.value === '' || option.value === 'px') {
              return cssDimensionsSupported || canSaveAttribute;
            }
            return cssDimensionsSupported && cssSupportsDimension(property, `1${option.value}`);
          }}
          onCommit={(next) => {
            if (disabled || next === value) return true;
            if (!canSaveAttribute && !cssDimensionsSupported) return false;
            if (next.trim() !== '' && htmlPixelDimension(next) === null) {
              if (!cssDimensionsSupported || !cssSupportsDimension(property, next.trim())) {
                return false;
              }
            }
            void onSave(next);
            return true;
          }}
        />
      </ReadonlyFieldSlot>
    </div>
  );
}
