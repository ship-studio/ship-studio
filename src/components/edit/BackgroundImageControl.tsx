import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { DragHandleIcon, PlusIcon, TrashIcon } from '@/components/icons';
import { useOptionalAssetBrowser } from '../../contexts/AssetBrowserContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { assetWebPath, getAssetsRoot, listAssets } from '../../lib/assets';
import {
  alignBackgroundValues,
  backgroundImageForLayer,
  backgroundImageFromTokens,
  backgroundLayerToken,
  backgroundListFromTokens,
  backgroundListToken,
  cssUrlValue,
  DEFAULT_BACKGROUND_SETTINGS,
  insertBackgroundLayerSettings,
  parseBackgroundStack,
  removeBackgroundLayerValue,
  reorderBackgroundLayerValues,
  serializeBackgroundStack,
  splitCssCommaList,
  updateBackgroundLayerValue,
  type BackgroundLayer,
  type BackgroundLayerKind,
  type BackgroundLayerSettings,
} from '../../lib/cssBackgroundImage';
import { readLayer, tailwindUtilityParts, type LayerContext, type ResetSpec } from '../../lib/edit';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { BackgroundLayerPopover, defaultBackgroundLayer } from './BackgroundLayerPopover';
import type { ValueFieldVariable } from '../primitives/ValueField';

const CSS_SETTINGS = {
  size: 'background-size',
  position: 'background-position',
  repeat: 'background-repeat',
  attachment: 'background-attachment',
} as const;

function cssSourceUrl(value: string): string | null {
  const match = /^url\s*\(\s*(["']?)(.*?)\1\s*\)$/i.exec(value.trim());
  return match?.[2] ?? null;
}

export function backgroundPreviewValue(
  value: string,
  assetSources: Record<string, string>
): string {
  const source = cssSourceUrl(value);
  if (!source || /^(?:https?:|blob:|data:)/i.test(source)) return value;
  const path = source.split(/[?#]/, 1)[0];
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    /* retain authored path */
  }
  const fileSource = assetSources[path] ?? assetSources[decodedPath];
  return fileSource ? cssUrlValue(fileSource) : value;
}

function displayLayer(layer: BackgroundLayer, index: number): string {
  if (layer.kind === 'image') {
    const source = cssSourceUrl(layer.value);
    if (!source) return `Image ${index + 1}`;
    if (/^data:/i.test(source)) return 'Embedded image';
    let path = source.split(/[?#]/, 1)[0];
    if (/^https?:\/\//i.test(source)) {
      try {
        path = new URL(source).pathname;
      } catch {
        // Keep the authored path if an external image URL is malformed.
      }
    }
    const filename = path.split(/[\\/]/).filter(Boolean).pop();
    try {
      return (filename ? decodeURIComponent(filename) : '') || `Image ${index + 1}`;
    } catch {
      return filename || `Image ${index + 1}`;
    }
  }
  if (layer.kind === 'solid') return 'Solid colour';
  return layer.kind === 'linear' ? 'Linear gradient' : 'Radial gradient';
}

function sourceSettings(
  currentClass: string,
  layer: LayerContext,
  count: number,
  computedSettings?: Partial<Record<keyof BackgroundLayerSettings, string>>
) {
  const result = {} as Record<keyof BackgroundLayerSettings, string[]>;
  for (const property of Object.keys(CSS_SETTINGS) as Array<keyof BackgroundLayerSettings>) {
    const inherited = readLayer(currentClass, layer, (tokens) =>
      backgroundListFromTokens(tokens, property, layer.utilityPrefix)
    ).value;
    const computedValue = computedSettings?.[property];
    result[property] =
      inherited ??
      (computedValue
        ? (splitCssCommaList(computedValue) ?? [computedValue])
        : [DEFAULT_BACKGROUND_SETTINGS[property]]);
    if (result[property].length === 0) result[property] = [DEFAULT_BACKGROUND_SETTINGS[property]];
    // Keep extra list items: CSS applies them if the user adds more image layers.
    if (count > 0 && result[property].length < count) {
      result[property] = alignBackgroundValues(result[property], count);
    }
  }
  return result;
}

export function BackgroundImageControl({
  currentClass,
  layer,
  computed,
  computedSettings,
  projectPath,
  selectionKey,
  variables,
  onApplyEnum,
}: {
  currentClass: string;
  layer: LayerContext;
  computed?: string;
  computedSettings?: Partial<Record<keyof BackgroundLayerSettings, string>>;
  projectPath?: string;
  selectionKey?: string;
  variables?: ValueFieldVariable[];
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}) {
  const browser = useOptionalAssetBrowser();
  const { showToast } = useOptionalToast();
  const pickerIdRef = useRef<number | null>(null);
  const identity = JSON.stringify([
    projectPath ?? '',
    selectionKey ?? '',
    layer.bp.name,
    layer.bp.prefix,
    layer.utilityPrefix ?? '',
  ]);
  const imageValue = backgroundImageForLayer(currentClass, layer, computed);
  const authoredImage = readLayer(currentClass, layer, (tokens) =>
    backgroundImageFromTokens(tokens, layer.utilityPrefix)
  ).value;
  const activeTokens = readLayer(currentClass, layer, (tokens) => tokens).value ?? '';
  const hasNativeGradientUtility = activeTokens.split(/\s+/).some((token) => {
    const base = tailwindUtilityParts(token, layer.utilityPrefix)?.base;
    return !!base && /^bg-(?:gradient-|linear-|radial-|conic-)/.test(base);
  });
  const hasBackgroundShorthand = activeTokens.split(/\s+/).some((token) => {
    const base = tailwindUtilityParts(token, layer.utilityPrefix)?.base;
    return !!base && base.startsWith('[background:');
  });
  const initial = parseBackgroundStack(imageValue);
  const sourceKey = JSON.stringify([
    identity,
    currentClass,
    computed ?? '',
    computedSettings ?? {},
  ]);
  const initialSettings = sourceSettings(
    currentClass,
    layer,
    initial.layers.length,
    computedSettings
  );
  const [draftState, setDraftState] = useState(() => ({
    sourceKey,
    identity,
    layers: initial.layers,
    settings: initialSettings,
  }));
  const layers =
    draftState.sourceKey === sourceKey
      ? draftState.layers
      : initial.layers.map((item, index) => ({
          ...item,
          id:
            draftState.identity === identity ? (draftState.layers[index]?.id ?? item.id) : item.id,
        }));
  const settings = draftState.sourceKey === sourceKey ? draftState.settings : initialSettings;
  const isCssBacked = !authoredImage && !!computed && computed !== 'none';
  const unsupported =
    initial.reason ??
    (hasNativeGradientUtility
      ? 'This Tailwind gradient utility does not expose editable colour stops here. It is shown read-only to preserve its authored gradient.'
      : isCssBacked
        ? 'This background is defined outside the active Tailwind classes. It is shown read-only so its source styling is preserved.'
        : hasBackgroundShorthand
          ? 'This Tailwind background shorthand also controls the image layer. It is shown read-only so its other background values are preserved.'
          : undefined);
  const canEdit = !unsupported;
  const [selectedLayerState, setSelectedLayer] = useState<{
    id: string;
    anchor: HTMLButtonElement | null;
    identity: string;
  } | null>(null);
  const selectedLayer =
    selectedLayerState?.identity === identity && canEdit ? selectedLayerState : null;
  const panelRoot = selectedLayer?.anchor?.closest<HTMLElement>('.ss-edit-panel') ?? null;
  const [assetSources, setAssetSources] = useState<Record<string, string>>({});
  const [activePickerId, setActivePickerId] = useState<number | null>(null);
  const idRef = useRef(0);
  const identityRef = useRef(identity);
  const pickerIdentityRef = useRef(identity);
  const revisionRef = useRef(0);
  const pickerRevisionRef = useRef(0);
  const currentClassRef = useRef(currentClass);
  const draggedLayerRef = useRef(false);
  const cancelPickerRef = useRef(browser?.cancelPicker);
  const shellRef = useRef<HTMLDivElement>(null);
  const latestStateRef = useRef({ identity, layers, settings });

  useLayoutEffect(() => {
    latestStateRef.current = { identity, layers, settings };
  }, [identity, layers, settings]);

  useEffect(() => {
    if (!projectPath) return;
    let active = true;
    void Promise.all([getAssetsRoot(projectPath), listAssets(projectPath)])
      .then(([root, assets]) => {
        if (!active) return;
        const next: Record<string, string> = {};
        for (const asset of assets) {
          if (asset.isDirectory) continue;
          try {
            const webPath = assetWebPath(root, asset.path);
            const fileSource = convertFileSrc(asset.fullPath);
            next[webPath] = fileSource;
            try {
              next[decodeURIComponent(webPath)] = fileSource;
            } catch {
              // Keep the encoded key when the asset path contains malformed escapes.
            }
          } catch {
            // Non-public roots do not have a framework-independent preview URL.
          }
        }
        setAssetSources(next);
      })
      .catch(() => {
        if (active) setAssetSources({});
      });
    return () => {
      active = false;
    };
  }, [projectPath]);

  useLayoutEffect(() => {
    cancelPickerRef.current = browser?.cancelPicker;
  }, [browser?.cancelPicker]);

  useLayoutEffect(() => {
    if (identityRef.current === identity && currentClassRef.current === currentClass) return;
    identityRef.current = identity;
    currentClassRef.current = currentClass;
    revisionRef.current += 1;
    if (pickerIdRef.current !== null) cancelPickerRef.current?.(pickerIdRef.current);
    pickerIdRef.current = null;
  }, [currentClass, identity]);

  useEffect(
    () => () => {
      if (pickerIdRef.current !== null) cancelPickerRef.current?.(pickerIdRef.current);
    },
    []
  );

  const selectedId = selectedLayer?.id ?? null;
  const selectedIndex = layers.findIndex((item) => item.id === selectedId);
  const popoverAnchor = selectedLayer?.anchor ?? null;
  const activePickerRequest = browser?.pickRequest?.id === activePickerId;
  const pickerOwnsEscape =
    activePickerRequest && (browser?.modalOpen === true || browser?.panelOpen === true);
  const imagePickerInPanel = browser?.panelOpen === true && activePickerRequest;
  useDismissOnOutsidePointer(
    selectedId !== null,
    shellRef,
    () => {
      setSelectedLayer(null);
    },
    {
      isOutside: (target) => {
        if (shellRef.current?.contains(target)) return false;
        const element = target as HTMLElement;
        if (
          element.closest?.(
            '.ss-background-layer-popover, .ss-value-pop, .ss-color-picker__floating-surface, .ss-color-picker__format-menu, .ss-add-menu, .modal-frame-overlay'
          )
        )
          return false;
        return true;
      },
    }
  );
  useEffect(() => {
    if (selectedId === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pickerOwnsEscape) return;
      if (
        document.querySelector(
          '.ss-value-pop, .ss-color-picker__floating-surface, .ss-color-picker__format-menu, .modal-frame-overlay:not([data-modal-inactive="true"])'
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedLayer(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [pickerOwnsEscape, selectedId]);
  const apply = useCallback(
    (nextLayers: BackgroundLayer[], nextSettings = settings, writeSettings = false) => {
      revisionRef.current += 1;
      setDraftState({ sourceKey, identity, layers: nextLayers, settings: nextSettings });
      latestStateRef.current = { identity, layers: nextLayers, settings: nextSettings };
      const image = nextLayers.length === 0 ? 'none' : serializeBackgroundStack(nextLayers);
      onApplyEnum(backgroundLayerToken(image), { 'background-image': image });
      if (writeSettings && nextLayers.length > 0) {
        for (const property of Object.keys(CSS_SETTINGS) as Array<keyof BackgroundLayerSettings>) {
          onApplyEnum(backgroundListToken(property, nextSettings[property]), {
            [CSS_SETTINGS[property]]: nextSettings[property].join(', '),
          });
        }
      }
    },
    [identity, onApplyEnum, settings, sourceKey]
  );

  const pickImage = useCallback(
    (replaceId: string) => {
      if (!browser || !projectPath) return;
      const expectedIdentity = identity;
      const expectedRevision = revisionRef.current;
      pickerIdentityRef.current = expectedIdentity;
      pickerRevisionRef.current = expectedRevision;
      const pickerId = browser.openPicker({
        projectPath,
        title: 'Choose background image',
        onPick: (asset, root) => {
          if (
            pickerIdentityRef.current !== expectedIdentity ||
            identityRef.current !== expectedIdentity ||
            pickerRevisionRef.current !== revisionRef.current
          ) {
            pickerIdRef.current = null;
            setActivePickerId(null);
            return;
          }
          try {
            const url = assetWebPath(root, asset.path);
            const value = cssUrlValue(url);
            const latest = latestStateRef.current;
            if (latest.identity !== expectedIdentity) return;
            const next = [...latest.layers];
            const index = next.findIndex((item) => item.id === replaceId);
            if (index < 0) {
              pickerIdRef.current = null;
              setActivePickerId(null);
              return;
            }
            next[index] = { ...next[index], kind: 'image', value };
            apply(next, latest.settings);
            latestStateRef.current = { ...latest, layers: next };
            pickerIdRef.current = null;
            setActivePickerId(null);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), 'error');
            throw error;
          }
        },
      });
      pickerIdRef.current = pickerId;
      setActivePickerId(pickerId);
    },
    [apply, browser, identity, projectPath, showToast]
  );

  const addLayer = (kind: BackgroundLayerKind) => {
    const id = `background-${++idRef.current}`;
    const next = [defaultBackgroundLayer(kind, id), ...layers];
    const nextSettings = insertBackgroundLayerSettings(settings, layers.length);
    setSelectedLayer({ id, anchor: null, identity });
    apply(next, nextSettings, true);
  };

  const changeLayer = (id: string, updated: BackgroundLayer) => {
    const next = layers.map((item) => (item.id === id ? updated : item));
    apply(next);
  };

  const changeSetting = (index: number, property: keyof BackgroundLayerSettings, value: string) => {
    const nextSettings = {
      ...settings,
      [property]: updateBackgroundLayerValue(settings[property], layers.length, index, value),
    };
    revisionRef.current += 1;
    setDraftState({ sourceKey, identity, layers, settings: nextSettings });
    latestStateRef.current = { identity, layers, settings: nextSettings };
    onApplyEnum(backgroundListToken(property, nextSettings[property]), {
      [CSS_SETTINGS[property]]: nextSettings[property].join(', '),
    });
  };

  const removeLayer = (id: string) => {
    const index = layers.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = layers.filter((item) => item.id !== id);
    const nextSettings = { ...settings };
    for (const property of Object.keys(CSS_SETTINGS) as Array<keyof BackgroundLayerSettings>) {
      nextSettings[property] = removeBackgroundLayerValue(settings[property], layers.length, index);
    }
    setSelectedLayer(null);
    apply(next, nextSettings, true);
  };

  const moveLayer = (from: number, to: number) => {
    if (from < 0 || to < 0 || from >= layers.length || to >= layers.length || from === to) return;
    const next = [...layers];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    const nextSettings = { ...settings };
    for (const property of Object.keys(CSS_SETTINGS) as Array<keyof BackgroundLayerSettings>) {
      nextSettings[property] = reorderBackgroundLayerValues(
        settings[property],
        layers.length,
        from,
        to
      );
    }
    apply(next, nextSettings, true);
  };

  const onDrop = (event: React.DragEvent<HTMLButtonElement>, to: number) => {
    let ownerValue: unknown;
    try {
      ownerValue = JSON.parse(
        event.dataTransfer.getData('application/x-shipstudio-background-layer')
      ) as unknown;
    } catch {
      return;
    }
    if (!ownerValue || typeof ownerValue !== 'object') return;
    const owner = ownerValue as Record<string, unknown>;
    if (typeof owner.identity !== 'string' || typeof owner.revision !== 'number') return;
    if (owner.identity !== identity || owner.revision !== revisionRef.current) return;
    const value = event.dataTransfer.getData('text/background-layer-index');
    if (!/^\d+$/.test(value)) return;
    event.preventDefault();
    moveLayer(Number(value), to);
  };

  const rowSettings = useMemo(
    () =>
      selectedIndex >= 0
        ? {
            size: alignBackgroundValues(settings.size, layers.length)[selectedIndex],
            position: alignBackgroundValues(settings.position, layers.length)[selectedIndex],
            repeat: alignBackgroundValues(settings.repeat, layers.length)[selectedIndex],
            attachment: alignBackgroundValues(settings.attachment, layers.length)[selectedIndex],
          }
        : DEFAULT_BACKGROUND_SETTINGS,
    [layers.length, selectedIndex, settings]
  );

  const previewImage = (value: string) => backgroundPreviewValue(value, assetSources);

  return (
    <div className="ss-edit-panel__control ss-background-image-control" ref={shellRef}>
      <div className="ss-background-image-control__header">
        <span className="ss-edit-panel__label ss-background-image-control__label">
          Image, gradient, or color
        </span>
        <IconButton
          variant="ghost"
          size="compact"
          icon={<PlusIcon size={14} />}
          aria-label="Add background layer"
          title="Add background layer"
          disabled={!canEdit}
          onClick={() => addLayer('linear')}
        />
      </div>
      <div className="ss-background-image-control__stack">
        {layers.map((item, index) => (
          <div className="ss-background-image-control__layer-wrap" key={item.id}>
            <div
              className={`ss-background-image-control__row${selectedId === item.id ? ' ss-background-image-control__row--selected' : ''}`}
            >
              <Button
                type="button"
                variant="ghost"
                size="compact"
                className="ss-background-image-control__layer"
                ref={(element) => {
                  if (element && selectedLayer?.id === item.id) {
                    setSelectedLayer((current) =>
                      current?.identity === identity &&
                      current.id === item.id &&
                      current.anchor !== element
                        ? { ...current, anchor: element }
                        : current
                    );
                  }
                }}
                aria-label={`Edit ${displayLayer(item, index)} layer ${index + 1}`}
                aria-expanded={selectedId === item.id}
                disabled={!canEdit}
                draggable={canEdit}
                onPointerDown={() => {
                  draggedLayerRef.current = false;
                }}
                onDragStart={(event) => {
                  draggedLayerRef.current = true;
                  event.dataTransfer.setData('text/background-layer-index', String(index));
                  event.dataTransfer.setData(
                    'application/x-shipstudio-background-layer',
                    JSON.stringify({ identity, revision: revisionRef.current })
                  );
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onDrop(event, index)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' && index === 0) {
                    event.preventDefault();
                    return;
                  }
                  const to =
                    event.key === 'ArrowUp'
                      ? index - 1
                      : event.key === 'ArrowDown'
                        ? index + 1
                        : -1;
                  if (to < 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  moveLayer(index, to);
                }}
                onClick={(event) => {
                  if (event.detail > 0 && draggedLayerRef.current) {
                    draggedLayerRef.current = false;
                    return;
                  }
                  const anchor = event.currentTarget;
                  setSelectedLayer((current) =>
                    current?.identity === identity && current.id === item.id
                      ? null
                      : { id: item.id, anchor, identity }
                  );
                }}
              >
                <span className="ss-background-image-control__drag" aria-hidden="true">
                  <DragHandleIcon size={14} />
                </span>
                <span
                  className="ss-background-image-control__swatch"
                  style={{ backgroundImage: previewImage(item.value) }}
                  aria-hidden="true"
                />
                <span className="ss-background-image-control__name">
                  {displayLayer(item, index)}
                </span>
                <span className="ss-background-image-control__kind">{item.kind}</span>
              </Button>
              <IconButton
                variant="ghost"
                size="compact"
                icon={<TrashIcon size={14} />}
                aria-label={`Remove ${displayLayer(item, index)} layer`}
                disabled={!canEdit}
                onClick={() => removeLayer(item.id)}
              />
            </div>
            {selectedId === item.id && canEdit && !imagePickerInPanel && (
              <BackgroundLayerPopover
                layer={item}
                anchor={popoverAnchor}
                settings={rowSettings}
                imageName={item.value ? displayLayer(item, index) : 'No image selected'}
                imagePreview={previewImage(item.value)}
                variables={variables}
                escapeIsOwned={pickerOwnsEscape}
                onChange={(updated) => changeLayer(item.id, updated)}
                onSettingChange={(property, value) => changeSetting(index, property, value)}
                onPickImage={() => pickImage(item.id)}
                onClose={() => {
                  setSelectedLayer(null);
                }}
              />
            )}
          </div>
        ))}
        {unsupported && <p className="ss-background-image-control__note">{unsupported}</p>}
      </div>
      {panelRoot && selectedId !== null
        ? createPortal(
            <div
              className="ss-background-image-control__panel-scrim"
              data-testid="background-layer-panel-scrim"
              aria-hidden="true"
            />,
            panelRoot
          )
        : null}
    </div>
  );
}
