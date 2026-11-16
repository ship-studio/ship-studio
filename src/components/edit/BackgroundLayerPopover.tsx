import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ValueFieldVariable } from '../primitives/ValueField';
import type {
  BackgroundLayer,
  BackgroundLayerKind,
  BackgroundLayerSettings,
} from '../../lib/cssBackgroundImage';
import { gradientArguments } from '../../lib/cssBackgroundImage';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { PropertyField } from '../primitives/PropertyField';
import { TextField } from '../primitives/TextField';
import {
  ImageIcon,
  TileNoRepeatIcon,
  TileRepeatIcon,
  TileRepeatXIcon,
  TileRepeatYIcon,
  TileRoundIcon,
  TileSpaceIcon,
  SortVerticalUpIcon,
  TrashIcon,
} from '@/components/icons';
import { EditPopover } from './EditPopover';
import { BackgroundLayerTypeSelector } from './BackgroundLayerTypeSelector';
import {
  angleDegrees,
  DEFAULT_COLOR,
  gradientValue,
  initialValue,
  LINEAR_ANGLE_PATTERN,
  normalizeDegrees,
  parseRadialPrelude,
  RADIAL_EXTENTS,
  reverseStopPosition,
} from './backgroundLayerGradient';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { ToggleButton } from '../primitives/ToggleButton';
import { ValueField } from '../primitives/ValueField';

function ColorValueField({
  label,
  value,
  onCommit,
  variables = [],
  hideLabel = false,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  variables?: ValueFieldVariable[];
  hideLabel?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <div className="ss-background-layer-popover__color-field">
      {!hideLabel && <span className="ss-background-layer-popover__color-label">{label}</span>}
      <ValueField
        className="ss-background-layer-popover__color-input"
        variant="color"
        value={value}
        variables={variables}
        aria-label={`${label} value`}
        leading={
          <PropertyField
            type="button"
            size="compact"
            className="ss-background-layer-popover__color-property"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={anchor !== null}
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            <span
              className="ss-background-layer-popover__color-swatch"
              style={{ backgroundColor: /^var\(/i.test(value) ? undefined : value }}
              title={/^var\(/i.test(value) ? 'Variable color preview unavailable' : undefined}
            />
          </PropertyField>
        }
        onCommit={(raw) => {
          const next = /^--[\w-]+$/.test(raw.trim()) ? `var(${raw.trim()})` : raw.trim();
          if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', next)) {
            if (!/^var\(\s*--[\w-]+\s*\)$/i.test(next)) return false;
          }
          onCommit(next);
          return true;
        }}
      />
      {anchor && (
        <EditPopover
          anchor={anchor}
          initial={value}
          initialSwatch
          colorProperty
          variables={variables}
          onCommit={onCommit}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}

const KIND_LABELS: Record<BackgroundLayerKind, string> = {
  image: 'Image',
  linear: 'Linear gradient',
  radial: 'Radial gradient',
  solid: 'Solid colour',
};

const BACKGROUND_SIZE_KEYWORDS = [{ value: 'auto', label: 'Auto', kind: 'keyword' as const }];
const SIZE_TOKEN_PATTERN =
  /^(?:auto|var\(--[\w-]+\)|[+-]?(?:\d*\.)?\d+(?:%|px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)?)$/i;
const BACKGROUND_SIZE_PRESETS = ['custom', 'cover', 'contain'] as const;
const BACKGROUND_REPEAT_PRESETS = [
  'repeat',
  'repeat-x',
  'repeat-y',
  'no-repeat',
  'round',
  'space',
] as const;
const BACKGROUND_REPEAT_LABELS: Record<(typeof BACKGROUND_REPEAT_PRESETS)[number], string> = {
  repeat: 'Repeat',
  'repeat-x': 'Repeat horizontally',
  'repeat-y': 'Repeat vertically',
  'no-repeat': 'No repeat',
  round: 'Round',
  space: 'Space',
};

function repeatIcon(preset: (typeof BACKGROUND_REPEAT_PRESETS)[number]) {
  const Icon = {
    repeat: TileRepeatIcon,
    'repeat-x': TileRepeatXIcon,
    'repeat-y': TileRepeatYIcon,
    'no-repeat': TileNoRepeatIcon,
    round: TileRoundIcon,
    space: TileSpaceIcon,
  }[preset];
  return <Icon size={16} aria-hidden="true" />;
}
const BACKGROUND_ATTACHMENT_PRESETS = ['fixed', 'scroll', 'local'] as const;

const POSITION_ANCHORS = [
  { label: 'Top left', x: 'left', y: 'top' },
  { label: 'Top center', x: 'center', y: 'top' },
  { label: 'Top right', x: 'right', y: 'top' },
  { label: 'Center left', x: 'left', y: 'center' },
  { label: 'Center', x: 'center', y: 'center' },
  { label: 'Center right', x: 'right', y: 'center' },
  { label: 'Bottom left', x: 'left', y: 'bottom' },
  { label: 'Bottom center', x: 'center', y: 'bottom' },
  { label: 'Bottom right', x: 'right', y: 'bottom' },
] as const;

function customSizeParts(value: string): { width: string; height: string } | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'cover' || normalized === 'contain') return null;
  const parts = normalized.split(/\s+/);
  if (parts.length > 2 || !parts.every((part) => SIZE_TOKEN_PATTERN.test(part))) return null;
  if (parts.length === 1 && parts[0] === 'auto') return { width: 'auto', height: 'auto' };
  return { width: parts[0], height: parts[1] ?? 'auto' };
}

function positionPreset(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const coordinates = normalized.split(' ');
  const horizontal: Record<string, string> = {
    '0%': 'left',
    '50%': 'center',
    '100%': 'right',
    '0': 'left',
    '0px': 'left',
  };
  const vertical: Record<string, string> = {
    '0%': 'top',
    '50%': 'center',
    '100%': 'bottom',
    '0': 'top',
    '0px': 'top',
  };
  if (coordinates.length === 2 && horizontal[coordinates[0]] && vertical[coordinates[1]])
    return `${horizontal[coordinates[0]]} ${vertical[coordinates[1]]}`;
  const explicit = POSITION_ANCHORS.find((anchor) => `${anchor.x} ${anchor.y}` === normalized);
  if (explicit) return normalized;
  if (normalized === 'center') return 'center center';
  if (normalized === 'top' || normalized === 'bottom') return `center ${normalized}`;
  if (normalized === 'left' || normalized === 'right') return `${normalized} center`;
  return null;
}

export function cssValueIsValid(property: string, value: string): boolean {
  if (!value.trim()) return false;
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports(property, value)
    : property === 'background-image'
      ? !!gradientArguments(value)
      : property === 'background-repeat'
        ? /^(?:(?:repeat|no-repeat|space|round|repeat-x|repeat-y)(?:\s+(?:repeat|no-repeat|space|round))?)(?:\s*,\s*(?:repeat|no-repeat|space|round|repeat-x|repeat-y))*$/i.test(
            value
          )
        : property === 'background-attachment'
          ? /^(?:scroll|fixed|local)(?:\s*,\s*(?:scroll|fixed|local))*$/i.test(value)
          : /^(?:auto|cover|contain|center|top|right|bottom|left|(?:[+-]?(?:\d*\.)?\d+)(?:%|px|rem|em|vh|vw|vmin|vmax|ch|lh))(?:\s+(?:auto|center|top|right|bottom|left|[+-]?(?:\d*\.)?\d+(?:%|px|rem|em|vh|vw|vmin|vmax|ch|lh)))*(?:\s*,\s*(?:auto|cover|contain|center|top|right|bottom|left|[+-]?(?:\d*\.)?\d+(?:%|px|rem|em|vh|vw|vmin|vmax|ch|lh)))*$/i.test(
              value
            );
}

function validGradient(value: string): boolean {
  return cssValueIsValid('background-image', value);
}

function Field({
  label,
  displayLabel,
  value,
  onChange,
  onCommit,
  type = 'text',
  placeholder,
  property,
  hideLabel = false,
}: {
  label: string;
  displayLabel?: string;
  value: string;
  onChange: (value: string) => void;
  onCommit?: () => void;
  type?: 'text' | 'number';
  placeholder?: string;
  property?: string;
  hideLabel?: boolean;
}) {
  const [draftState, setDraftState] = useState({ source: value, draft: value });
  const draft = draftState.source === value ? draftState.draft : value;
  const setDraft = (next: string) => setDraftState({ source: value, draft: next });
  const [reason, setReason] = useState('');
  const skipBlurCommitRef = useRef(false);
  const commit = () => {
    if (draft === value) return true;
    if (property && !cssValueIsValid(property, draft)) {
      setReason(`Enter a valid ${label.toLowerCase()} value.`);
      return false;
    }
    setReason('');
    onChange(draft);
    onCommit?.();
    skipBlurCommitRef.current = true;
    return true;
  };
  return (
    <label
      className={`ss-background-layer-popover__field${hideLabel ? ' ss-background-layer-popover__field--hidden-label' : ''}`}
      title={reason || undefined}
    >
      {!hideLabel && (
        <span
          className="ss-background-layer-popover__field-label"
          title={displayLabel ? label : undefined}
        >
          {displayLabel ?? label}
        </span>
      )}
      <TextField
        key={value}
        className="ss-background-layer-popover__input"
        type={type}
        value={draft}
        aria-label={hideLabel || displayLabel ? label : undefined}
        placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value);
          setReason('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (commit()) event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            skipBlurCommitRef.current = true;
            setDraft(value);
            setReason('');
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          if (skipBlurCommitRef.current) {
            skipBlurCommitRef.current = false;
            return;
          }
          if (event.currentTarget.value !== value) commit();
        }}
      />
      {reason && (
        <span className="ss-background-layer-popover__reason" role="status">
          {reason}
        </span>
      )}
    </label>
  );
}

export function BackgroundLayerPopover({
  layer,
  anchor,
  settings,
  imageName = 'Image',
  imagePreview,
  variables = [],
  escapeIsOwned = false,
  onChange,
  onSettingChange,
  onPickImage,
  onClose,
}: {
  layer: BackgroundLayer;
  anchor: HTMLElement | null;
  settings: BackgroundLayerSettings;
  imageName?: string;
  imagePreview?: string;
  variables?: ValueFieldVariable[];
  escapeIsOwned?: boolean;
  onChange: (next: BackgroundLayer) => void;
  onSettingChange: (key: keyof BackgroundLayerSettings, value: string) => void;
  onPickImage: () => void;
  onClose: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => gradientArguments(layer.value), [layer.value]);
  const stops = parsed?.stops ?? [
    { color: DEFAULT_COLOR, position: '0%' },
    { color: '#ec4899', position: '100%' },
  ];
  const prelude = parsed?.prelude ?? (layer.kind === 'radial' ? 'circle at center' : '90deg');
  const sizeParts = customSizeParts(settings.size);
  const sizePreset =
    settings.size.trim().toLowerCase() === 'cover'
      ? 'cover'
      : settings.size.trim().toLowerCase() === 'contain'
        ? 'contain'
        : 'custom';
  const repeatPreset = BACKGROUND_REPEAT_PRESETS.find(
    (preset) => preset === settings.repeat.trim().toLowerCase()
  );
  const attachmentPreset = BACKGROUND_ATTACHMENT_PRESETS.find(
    (preset) => preset === settings.attachment.trim().toLowerCase()
  );
  const selectedPositionPreset = positionPreset(settings.position);
  const [selectedStop, setSelectedStop] = useState<number | null>(null);
  const [draggingStop, setDraggingStop] = useState<number | null>(null);
  const stopMovedRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<{ id: number; kind: 'stop' | 'angle'; index?: number } | null>(null);
  const repeating = /^repeating-/i.test(layer.value.trim());
  const numericAngle = angleDegrees(prelude);

  const changeKind = (kind: BackgroundLayerKind) => {
    if (kind === layer.kind) return;
    if (kind === 'image') {
      onPickImage();
      return;
    }
    const currentGradient = gradientArguments(layer.value);
    const repeating = /^repeating-/i.test(layer.value.trim());
    let nextValue = initialValue(kind);
    if (kind === 'solid' && currentGradient) {
      const color = currentGradient.stops[0]?.color ?? DEFAULT_COLOR;
      nextValue = `linear-gradient(${color}, ${color})`;
    } else if ((kind === 'linear' || kind === 'radial') && currentGradient) {
      nextValue = gradientValue(
        kind,
        kind === 'radial' ? 'circle at center' : '90deg',
        currentGradient.stops,
        repeating
      );
    }
    onChange({ ...layer, kind, value: nextValue });
  };

  const updateStop = (index: number, key: 'color' | 'position', value: string): boolean => {
    const next = stops.map((stop, i) => (i === index ? { ...stop, [key]: value } : stop));
    const nextValue = gradientValue(
      layer.kind,
      prelude,
      next,
      /^repeating-/i.test(layer.value.trim())
    );
    if (!validGradient(nextValue)) return false;
    onChange({ ...layer, value: nextValue });
    return true;
  };

  const setAngle = (degrees: number) => {
    const nextValue = gradientValue(
      layer.kind,
      `${normalizeDegrees(degrees)}deg`,
      stops,
      repeating
    );
    if (validGradient(nextValue)) onChange({ ...layer, value: nextValue });
  };

  const reverseStops = () => {
    const reversed = [...stops].reverse().map((stop) => ({
      ...stop,
      position: stop.position ? reverseStopPosition(stop.position) : '',
    }));
    const nextValue = gradientValue(layer.kind, prelude, reversed, repeating);
    if (validGradient(nextValue)) onChange({ ...layer, value: nextValue });
  };

  const toggleRepeating = () => {
    const values = gradientArguments(layer.value);
    if (!values) return;
    const next = gradientValue(layer.kind, values.prelude, values.stops, !repeating);
    if (validGradient(next)) onChange({ ...layer, value: next });
  };

  const updateRadialPrelude = (nextShape: string, nextExtent: string, nextPosition: string) => {
    const nextPrelude = [nextShape, nextExtent, `at ${nextPosition}`].filter(Boolean).join(' ');
    const nextValue = gradientValue('radial', nextPrelude, stops, repeating);
    if (validGradient(nextValue)) onChange({ ...layer, value: nextValue });
  };

  const setStopAtPointer = (index: number, clientX: number) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    const percent = Math.round(
      Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100))
    );
    updateStop(index, 'position', `${percent}%`);
  };

  const setSolid = (value: string) => {
    const nextValue = `linear-gradient(${value}, ${value})`;
    if (validGradient(nextValue)) onChange({ ...layer, value: nextValue });
  };

  const addStop = () => {
    const next = [...stops, { color: DEFAULT_COLOR, position: '100%' }];
    const nextValue = gradientValue(
      layer.kind,
      prelude,
      next,
      /^repeating-/i.test(layer.value.trim())
    );
    if (validGradient(nextValue)) onChange({ ...layer, value: nextValue });
  };

  const removeStop = (index: number) => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, i) => i !== index);
    const nextValue = gradientValue(
      layer.kind,
      prelude,
      next,
      /^repeating-/i.test(layer.value.trim())
    );
    if (validGradient(nextValue)) onChange({ ...layer, value: nextValue });
  };

  const solidColor = parsed?.stops[0]?.color ?? DEFAULT_COLOR;
  const radial = parseRadialPrelude(prelude);

  useLayoutEffect(() => {
    const popover = wrapperRef.current;
    if (!popover || !anchor) return;
    const row = anchor.closest<HTMLElement>('.ss-background-image-control__row');
    const panel = anchor.closest<HTMLElement>('.ss-edit-panel');
    const panelBody = anchor.closest<HTMLElement>('.ss-edit-panel__body');
    const place = () => {
      const panelRect = panel?.getBoundingClientRect();
      const verticalBoundary = panelBody?.getBoundingClientRect() ??
        panelRect ?? {
          left: 0,
          right: window.innerWidth,
          top: 0,
          bottom: window.innerHeight,
        };
      const bounds = {
        left: Math.max(0, panelRect?.left ?? 0),
        right: Math.min(window.innerWidth, panelRect?.right ?? window.innerWidth),
        top: Math.max(0, verticalBoundary.top),
        bottom: Math.min(window.innerHeight, verticalBoundary.bottom),
      };
      const anchorRect = anchor.getBoundingClientRect();
      const horizontalRect = row?.getBoundingClientRect() ?? anchorRect;

      popover.style.maxHeight = '';
      const width = Math.min(horizontalRect.width, Math.max(0, bounds.right - bounds.left));
      popover.style.width = `${width}px`;
      const rect = popover.getBoundingClientRect();
      const gap =
        Number.parseFloat(getComputedStyle(popover).getPropertyValue('--spacing-xs')) || 8;
      const left = Math.max(bounds.left, Math.min(horizontalRect.left, bounds.right - width));
      const below = bounds.bottom - anchorRect.bottom - gap;
      const above = anchorRect.top - bounds.top - gap;
      const placeAbove = above > below && above > 0;
      const space = Math.max(0, placeAbove ? above : below);
      const top = placeAbove
        ? anchorRect.top - Math.min(rect.height, space) - gap
        : anchorRect.bottom + gap;
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
      popover.style.maxHeight = `${space}px`;
    };
    place();
    const onResize = () => place();
    const onScroll = () => place();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    resizeObserver?.observe(anchor);
    if (row) resizeObserver?.observe(row);
    if (panel) resizeObserver?.observe(panel);
    if (panelBody) resizeObserver?.observe(panelBody);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, layer.id, layer.value, settings]);

  return createPortal(
    <div
      className="ss-background-layer-popover"
      role="dialog"
      aria-label={`${KIND_LABELS[layer.kind]} settings`}
      ref={wrapperRef}
      /* inline-style-ok: measured viewport coordinates must stay fixed; native
         tracing reproduced a late CSS override moving this popup off-screen. */
      style={{ position: 'fixed' }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || escapeIsOwned) return;
        event.stopPropagation();
        onClose();
      }}
    >
      <BackgroundLayerTypeSelector kind={layer.kind} onChange={changeKind} />

      {layer.kind === 'image' && (
        <div className="ss-background-layer-popover__section ss-background-layer-popover__image-section">
          <span className="ss-background-layer-popover__section-label">Image</span>
          <div className="ss-background-layer-popover__image-content">
            <div className="ss-background-layer-popover__image-detail">
              <div
                className="ss-background-layer-popover__image-preview"
                style={imagePreview ? { backgroundImage: imagePreview } : undefined}
                aria-hidden="true"
              >
                {!imagePreview && <ImageIcon size={20} />}
              </div>
              <span className="ss-background-layer-popover__image-name" title={imageName}>
                {imageName}
              </span>
            </div>
            <Button variant="secondary" size="compact" width="fill" onClick={onPickImage}>
              Choose image
            </Button>
          </div>
        </div>
      )}

      {layer.kind === 'solid' ? (
        <div className="ss-background-layer-popover__section">
          <span className="ss-background-layer-popover__section-label">Color</span>
          <div className="ss-background-layer-popover__section-value">
            <ColorValueField
              label="Color"
              value={solidColor}
              variables={variables}
              hideLabel
              onCommit={setSolid}
            />
          </div>
        </div>
      ) : layer.kind === 'linear' || layer.kind === 'radial' ? (
        <div className="ss-background-layer-popover__gradient-section">
          {layer.kind === 'linear' ? (
            <div className="ss-background-layer-popover__angle-row">
              <div
                className="ss-background-layer-popover__angle-dial"
                role="slider"
                tabIndex={0}
                aria-label="Gradient angle"
                aria-valuemin={0}
                aria-valuemax={359}
                aria-valuenow={numericAngle}
                aria-valuetext={`${numericAngle} degrees`}
                ref={dialRef}
                style={{ '--angle': `${numericAngle}deg` } as CSSProperties}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setAngle(numericAngle + 15);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    setAngle(numericAngle - 15);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    setAngle(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    setAngle(359);
                  }
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  pointerRef.current = { id: event.pointerId, kind: 'angle' };
                  setDraggingStop(null);
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  const rect = event.currentTarget.getBoundingClientRect();
                  const angle = Math.atan2(
                    event.clientY - (rect.top + rect.height / 2),
                    event.clientX - (rect.left + rect.width / 2)
                  );
                  setAngle((angle * 180) / Math.PI + 90);
                }}
                onPointerMove={(event) => {
                  if (
                    pointerRef.current?.id !== event.pointerId ||
                    pointerRef.current.kind !== 'angle'
                  )
                    return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const angle = Math.atan2(
                    event.clientY - (rect.top + rect.height / 2),
                    event.clientX - (rect.left + rect.width / 2)
                  );
                  setAngle((angle * 180) / Math.PI + 90);
                }}
                onPointerUp={(event) => {
                  if (pointerRef.current?.id !== event.pointerId) return;
                  pointerRef.current = null;
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={(event) => {
                  if (pointerRef.current?.id !== event.pointerId) return;
                  pointerRef.current = null;
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onLostPointerCapture={() => {
                  pointerRef.current = null;
                }}
              >
                <span aria-hidden="true" />
              </div>
              <div className="ss-background-layer-popover__angle-controls">
                {LINEAR_ANGLE_PATTERN.test(prelude) ? (
                  <ValueField
                    className="ss-background-layer-popover__angle"
                    variant="angle"
                    defaultUnit="deg"
                    value={prelude}
                    aria-label="Angle"
                    onCommit={(value) => {
                      const next = gradientValue('linear', value, stops, repeating);
                      if (!validGradient(next)) return false;
                      onChange({ ...layer, value: next });
                      return true;
                    }}
                  />
                ) : (
                  <Field
                    label="Angle"
                    value={prelude}
                    onChange={(value) => {
                      const next = gradientValue('linear', value, stops, repeating);
                      if (validGradient(next)) onChange({ ...layer, value: next });
                    }}
                    placeholder="90deg or to right"
                  />
                )}
                <div className="ss-background-layer-popover__gradient-actions">
                  <IconButton
                    variant="ghost"
                    size="compact"
                    icon={<SortVerticalUpIcon size={14} />}
                    aria-label="Reverse gradient stops"
                    title="Reverse gradient stops"
                    onClick={reverseStops}
                  />
                  <IconButton
                    variant="ghost"
                    size="compact"
                    icon={<TileRepeatIcon size={14} />}
                    aria-pressed={repeating}
                    aria-label="Repeating gradient"
                    title={repeating ? 'Stop repeating gradient' : 'Repeat gradient'}
                    onClick={toggleRepeating}
                  />
                </div>
              </div>
            </div>
          ) : null}
          {layer.kind === 'radial' && (
            <div className="ss-background-layer-popover__radial-controls">
              <div className="ss-background-layer-popover__radial-origin">
                <div
                  className="ss-background-layer-popover__position-grid"
                  role="group"
                  aria-label="Gradient origin"
                >
                  {POSITION_ANCHORS.map((position) => {
                    const preset = `${position.x} ${position.y}`;
                    const selected =
                      radial.position.toLowerCase() === preset.toLowerCase() ||
                      (preset === 'center center' && radial.position.toLowerCase() === 'center');
                    return (
                      <ToggleButton
                        key={position.label}
                        variant="ghost"
                        size="compact"
                        className="ss-background-layer-popover__position-anchor"
                        pressed={selected}
                        aria-label={`Gradient origin ${position.label.toLowerCase()}`}
                        title={position.label}
                        onClick={() => updateRadialPrelude(radial.shape, radial.extent, preset)}
                      >
                        <span aria-hidden="true" />
                      </ToggleButton>
                    );
                  })}
                </div>
                <div className="ss-background-layer-popover__radial-xy">
                  <Field
                    label="Gradient origin X"
                    displayLabel="X"
                    value={radial.x}
                    onChange={(x) =>
                      updateRadialPrelude(radial.shape, radial.extent, `${x} ${radial.y}`)
                    }
                    placeholder="50%"
                  />
                  <Field
                    label="Gradient origin Y"
                    displayLabel="Y"
                    value={radial.y}
                    onChange={(y) =>
                      updateRadialPrelude(radial.shape, radial.extent, `${radial.x} ${y}`)
                    }
                    placeholder="50%"
                  />
                </div>
              </div>
              <div className="ss-background-layer-popover__radial-options">
                <SegmentedControl
                  className="ss-background-layer-popover__presets"
                  value={radial.shape}
                  aria-label="Radial gradient shape"
                  options={[
                    { value: 'circle', label: 'Circle' },
                    { value: 'ellipse', label: 'Ellipse' },
                  ]}
                  onValueChange={(shape) =>
                    updateRadialPrelude(shape, radial.extent, radial.position)
                  }
                />
                <SegmentedControl
                  className="ss-background-layer-popover__presets ss-background-layer-popover__radial-extent"
                  value={radial.extent}
                  aria-label="Radial gradient extent"
                  options={[
                    ...RADIAL_EXTENTS.map((value) => ({ value, label: value.replace('-', ' ') })),
                    ...(!RADIAL_EXTENTS.includes(radial.extent as (typeof RADIAL_EXTENTS)[number])
                      ? [{ value: radial.extent, label: 'Custom' }]
                      : []),
                  ]}
                  onValueChange={(extent) =>
                    updateRadialPrelude(radial.shape, extent, radial.position)
                  }
                />
                <div className="ss-background-layer-popover__gradient-actions">
                  <IconButton
                    variant="ghost"
                    size="compact"
                    icon={<SortVerticalUpIcon size={14} />}
                    aria-label="Reverse gradient stops"
                    title="Reverse gradient stops"
                    onClick={reverseStops}
                  />
                  <IconButton
                    variant="ghost"
                    size="compact"
                    icon={<TileRepeatIcon size={14} />}
                    aria-pressed={repeating}
                    aria-label="Repeating gradient"
                    title={repeating ? 'Stop repeating gradient' : 'Repeat gradient'}
                    onClick={toggleRepeating}
                  />
                </div>
              </div>
            </div>
          )}
          <div
            className="ss-background-layer-popover__gradient-track"
            role="group"
            aria-label="Gradient stops"
          >
            <div className="ss-background-layer-popover__gradient-track-axis" ref={trackRef}>
              <div
                className="ss-background-layer-popover__gradient-track-fill"
                style={{
                  background: `linear-gradient(90deg, ${stops.map((stop) => `${stop.color} ${stop.position || ''}`).join(', ')})`,
                }}
              />
              {stops.map((stop, index) => {
                const explicitPosition = /^-?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(stop.position.trim())
                  ? Number.parseFloat(stop.position)
                  : null;
                const position =
                  explicitPosition ?? (stops.length > 1 ? (index / (stops.length - 1)) * 100 : 0);
                return (
                  <button
                    key={`handle-${index}`}
                    type="button"
                    className={`ss-background-layer-popover__gradient-handle${selectedStop === index ? ' is-selected' : ''}${draggingStop === index ? ' is-dragging' : ''}`}
                    style={{
                      left: `${position}%`,
                      backgroundColor: /^var\(/i.test(stop.color)
                        ? 'var(--surface-control)'
                        : stop.color,
                    }}
                    aria-label={`Select stop ${index + 1} at ${stop.position || `${Math.round(position)}%`}`}
                    aria-pressed={selectedStop === index}
                    role="slider"
                    tabIndex={0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(position)}
                    aria-valuetext={`${Math.round(position)} percent`}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'ArrowLeft' ||
                        event.key === 'ArrowDown' ||
                        event.key === 'ArrowRight' ||
                        event.key === 'ArrowUp'
                      ) {
                        event.preventDefault();
                        const step = event.shiftKey ? 5 : 1;
                        const direction =
                          event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
                        setSelectedStop(index);
                        updateStop(
                          index,
                          'position',
                          `${Math.max(0, Math.min(100, position + direction * step))}%`
                        );
                      } else if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        const stopRow = event.currentTarget
                          .closest('.ss-background-layer-popover')
                          ?.querySelectorAll<HTMLButtonElement>(
                            '.ss-background-layer-popover__color-property'
                          )[index];
                        stopRow?.click();
                      }
                    }}
                    onClick={(event) => {
                      if (stopMovedRef.current) {
                        stopMovedRef.current = false;
                        return;
                      }
                      setSelectedStop(index);
                      const stopRow = event.currentTarget
                        .closest('.ss-background-layer-popover')
                        ?.querySelectorAll<HTMLButtonElement>(
                          '.ss-background-layer-popover__color-property'
                        )[index];
                      stopRow?.click();
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      setSelectedStop(index);
                      setDraggingStop(index);
                      stopMovedRef.current = false;
                      pointerRef.current = { id: event.pointerId, kind: 'stop', index };
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (
                        pointerRef.current?.id !== event.pointerId ||
                        pointerRef.current.kind !== 'stop' ||
                        pointerRef.current.index === undefined
                      )
                        return;
                      stopMovedRef.current = true;
                      setStopAtPointer(pointerRef.current.index, event.clientX);
                    }}
                    onPointerUp={(event) => {
                      if (pointerRef.current?.id !== event.pointerId) return;
                      pointerRef.current = null;
                      setDraggingStop(null);
                      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                    onPointerCancel={(event) => {
                      if (pointerRef.current?.id !== event.pointerId) return;
                      pointerRef.current = null;
                      setDraggingStop(null);
                      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                    }}
                    onLostPointerCapture={() => {
                      pointerRef.current = null;
                      setDraggingStop(null);
                    }}
                  />
                );
              })}
            </div>
          </div>
          <div className="ss-background-layer-popover__stops">
            <span className="ss-background-layer-popover__section-label">Color stops</span>
            {stops.map((stop, index) => (
              <div className="ss-background-layer-popover__stop" key={`${index}-${stop.color}`}>
                <ColorValueField
                  label={`Stop ${index + 1} color`}
                  value={stop.color}
                  variables={variables}
                  onCommit={(value) => updateStop(index, 'color', value)}
                  hideLabel
                />
                <ValueField
                  className="ss-background-layer-popover__stop-position"
                  variant="length"
                  defaultUnit="%"
                  value={stop.position}
                  aria-label={`Stop ${index + 1} position`}
                  placeholder="0%"
                  onCommit={(value) => updateStop(index, 'position', value)}
                />
                <IconButton
                  variant="ghost"
                  size="compact"
                  icon={<TrashIcon size={12} />}
                  aria-label={`Remove stop ${index + 1}`}
                  disabled={stops.length <= 2}
                  onClick={() => removeStop(index)}
                />
              </div>
            ))}
            <Button variant="ghost" size="compact" onClick={addStop}>
              Add color stop
            </Button>
          </div>
        </div>
      ) : null}

      {layer.kind === 'image' && (
        <div className="ss-background-layer-popover__settings">
          <div className="ss-background-layer-popover__section">
            <span className="ss-background-layer-popover__section-label">Size</span>
            <div className="ss-background-layer-popover__section-value">
              <SegmentedControl
                className="ss-background-layer-popover__presets"
                value={sizePreset}
                aria-label="Background size preset"
                options={BACKGROUND_SIZE_PRESETS.map((preset) => ({
                  value: preset,
                  label:
                    preset === 'custom' ? 'Custom' : `${preset[0].toUpperCase()}${preset.slice(1)}`,
                }))}
                onValueChange={(value) => {
                  if (value === 'custom') {
                    if (!sizeParts) onSettingChange('size', 'auto auto');
                  } else {
                    onSettingChange('size', value);
                  }
                }}
              />
              {sizePreset === 'custom' &&
                (sizeParts ? (
                  <div className="ss-background-layer-popover__dimension-grid">
                    {(['width', 'height'] as const).map((dimension) => (
                      <label className="ss-background-layer-popover__dimension" key={dimension}>
                        <span>{dimension === 'width' ? 'Width' : 'Height'}</span>
                        <ValueField
                          variant="length"
                          keywords={BACKGROUND_SIZE_KEYWORDS}
                          hideKeywordUnitLabel
                          value={sizeParts[dimension]}
                          aria-label={`Background ${dimension}`}
                          onCommit={(value) => {
                            const nextParts = { ...sizeParts, [dimension]: value };
                            const nextValue = `${nextParts.width} ${nextParts.height}`;
                            if (!cssValueIsValid('background-size', nextValue)) return false;
                            onSettingChange('size', nextValue);
                            return true;
                          }}
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <Field
                    hideLabel
                    label="Custom size"
                    value={settings.size}
                    onChange={(value) => onSettingChange('size', value)}
                    placeholder="e.g. 120px auto"
                    property="background-size"
                  />
                ))}
            </div>
          </div>

          <div className="ss-background-layer-popover__section">
            <span className="ss-background-layer-popover__section-label">Position</span>
            <div className="ss-background-layer-popover__position-value">
              <div
                className="ss-background-layer-popover__position-grid"
                role="group"
                aria-label="Position preset"
              >
                {POSITION_ANCHORS.map((position) => {
                  const value = `${position.x} ${position.y}`;
                  return (
                    <ToggleButton
                      key={position.label}
                      variant="ghost"
                      size="compact"
                      className="ss-background-layer-popover__position-anchor"
                      pressed={selectedPositionPreset === value}
                      aria-label={position.label}
                      title={position.label}
                      onClick={() => onSettingChange('position', value)}
                    >
                      <span aria-hidden="true" />
                    </ToggleButton>
                  );
                })}
              </div>
              <Field
                hideLabel
                label="Position"
                value={settings.position}
                onChange={(value) => onSettingChange('position', value)}
                placeholder="center"
                property="background-position"
              />
            </div>
          </div>

          <div className="ss-background-layer-popover__section">
            <span className="ss-background-layer-popover__section-label">Tile</span>
            <div className="ss-background-layer-popover__section-value">
              <SegmentedControl
                className="ss-background-layer-popover__presets ss-background-layer-popover__repeat-presets ss-edit-panel__align-tabs"
                value={repeatPreset ?? ''}
                aria-label="Background tile"
                options={BACKGROUND_REPEAT_PRESETS.map((preset) => ({
                  value: preset,
                  label: repeatIcon(preset),
                  ariaLabel: BACKGROUND_REPEAT_LABELS[preset],
                  title: BACKGROUND_REPEAT_LABELS[preset],
                }))}
                onValueChange={(value) => onSettingChange('repeat', value)}
              />
              {!repeatPreset && (
                <Field
                  hideLabel
                  label="Tile value"
                  value={settings.repeat}
                  onChange={(value) => onSettingChange('repeat', value)}
                  placeholder="repeat"
                  property="background-repeat"
                />
              )}
            </div>
          </div>

          <div className="ss-background-layer-popover__section">
            <span className="ss-background-layer-popover__section-label">Fixed</span>
            <div className="ss-background-layer-popover__section-value">
              <SegmentedControl
                className="ss-background-layer-popover__presets"
                value={attachmentPreset ?? ''}
                aria-label="Background attachment"
                options={BACKGROUND_ATTACHMENT_PRESETS.map((preset) => ({
                  value: preset,
                  label: preset[0].toUpperCase() + preset.slice(1),
                }))}
                onValueChange={(value) => onSettingChange('attachment', value)}
              />
              {!attachmentPreset && (
                <Field
                  hideLabel
                  label="Attachment value"
                  value={settings.attachment}
                  onChange={(value) => onSettingChange('attachment', value)}
                  placeholder="scroll"
                  property="background-attachment"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

export function defaultBackgroundLayer(kind: BackgroundLayerKind, id: string): BackgroundLayer {
  return { id, kind, value: initialValue(kind) };
}
