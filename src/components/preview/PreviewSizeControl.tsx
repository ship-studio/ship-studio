/**
 * The toolbar dimensions readout ("1440 × 900"), now a control: clicking it
 * opens a popover where the user types an exact viewport size — the same
 * true-width-scaled-to-fit rendering the agent gets via preview_set_viewport
 * and the editor gets via its breakpoint selector. Height is optional (auto
 * = full available height).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontalIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { ValueField } from '../primitives/ValueField';
import { trackEvent } from '../../lib/analytics';

const MIN_WIDTH = 200;
const MAX_WIDTH = 3000;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 3000;

export interface PreviewBreakpointOption {
  value: string;
  label: string;
  width: string;
  icon: ReactNode;
}

interface PreviewSizeControlProps {
  /** True (unscaled) width the page is laid out at. */
  width: number | null;
  /** True (unscaled) height. */
  height: number | null;
  /** Whether the user has pinned a custom height (vs auto). */
  hasCustomHeight: boolean;
  /** Visual scale percentage when the frame is shrunk to fit, or null at 1:1. */
  scalePercent: number | null;
  /** Apply an exact size (height null = auto). */
  onApply: (width: number, height: number | null) => void;
  /** Reset to full pane width / auto height. */
  onFit: () => void;
  /** Bump to open the popover from outside (Cmd+K command). */
  openSignal?: number;
  /** Breakpoints to expose in the compact size popover. */
  breakpointOptions?: PreviewBreakpointOption[];
  /** The currently selected visible or overflow breakpoint. */
  activeBreakpoint?: string;
  /** Select a breakpoint from the compact size popover. */
  onBreakpointChange?: (value: string) => void;
  /** Shows the current viewport controls without allowing local-frame changes. */
  disabled?: boolean;
}

export function PreviewSizeControl({
  width,
  height,
  hasCustomHeight,
  scalePercent,
  onApply,
  onFit,
  openSignal = 0,
  breakpointOptions,
  activeBreakpoint,
  onBreakpointChange,
  disabled = false,
}: PreviewSizeControlProps) {
  const [open, setOpen] = useState(false);
  const [widthText, setWidthText] = useState('');
  const [heightText, setHeightText] = useState('');
  const widthDraftRef = useRef('');
  const heightDraftRef = useRef('');
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Seed the inputs from the live size each time the popover opens.
  const openPopover = useCallback(() => {
    setWidthText(String(width ?? ''));
    setHeightText(hasCustomHeight ? String(height ?? '') : '');
    widthDraftRef.current = String(width ?? '');
    heightDraftRef.current = hasCustomHeight ? String(height ?? '') : '';
    setOpen(true);
  }, [hasCustomHeight, height, width]);

  // External open requests (the Cmd+K "Set exact preview size…" command).
  const seenSignalRef = useRef(openSignal);
  useEffect(() => {
    if (disabled) return;
    if (openSignal === seenSignalRef.current) return;
    seenSignalRef.current = openSignal;
    if (openSignal > 0 && !open) {
      const timeoutId = window.setTimeout(openPopover, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [disabled, open, openPopover, openSignal]);

  useEffect(() => {
    if (!open || disabled) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [disabled, open]);

  // Close the popover when its owning preview becomes unavailable.
  useEffect(() => {
    if (disabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize transient UI with an external availability change.
      setOpen(false);
    }
  }, [disabled]);

  const apply = () => {
    const w = Math.round(Number(widthDraftRef.current));
    if (!Number.isFinite(w) || w < MIN_WIDTH || w > MAX_WIDTH) return;
    let h: number | null = null;
    const heightDraft = heightDraftRef.current.trim().toLowerCase();
    if (heightDraft !== '' && heightDraft !== 'auto') {
      const parsed = Math.round(Number(heightDraftRef.current));
      if (!Number.isFinite(parsed) || parsed < MIN_HEIGHT || parsed > MAX_HEIGHT) return;
      h = parsed;
    }
    onApply(w, h);
    void trackEvent('preview_size_applied', { width: w, has_height: h !== null });
    setOpen(false);
  };

  const commitWidth = (next: string) => {
    const parsed = Math.round(Number(next));
    if (!Number.isFinite(parsed) || parsed < MIN_WIDTH || parsed > MAX_WIDTH) {
      widthDraftRef.current = widthText;
      return false;
    }
    const normalized = String(parsed);
    setWidthText(normalized);
    widthDraftRef.current = normalized;
    return true;
  };

  const commitHeight = (next: string) => {
    const trimmed = next.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'auto') {
      setHeightText('');
      heightDraftRef.current = '';
      return true;
    }
    const parsed = Math.round(Number(next));
    if (!Number.isFinite(parsed) || parsed < MIN_HEIGHT || parsed > MAX_HEIGHT) {
      heightDraftRef.current = heightText;
      return false;
    }
    const normalized = String(parsed);
    setHeightText(normalized);
    heightDraftRef.current = normalized;
    return true;
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') apply();
  };

  const togglePopover = () => {
    if (open) setOpen(false);
    else openPopover();
  };

  const hasBreakpointOptions = Boolean(breakpointOptions?.length && onBreakpointChange);
  const sizeButtonLabel =
    width === null || height === null
      ? 'Preview size unavailable for this destination'
      : `Set preview size: ${width} × ${height}`;

  return (
    <span className="preview-size-wrap" ref={wrapRef}>
      {/* One control, not two: the ⋯ and the readout open the same popover, so
          they are one button that reads as pressed while it is open — the
          treatment every other toolbar toggle uses. The ⋯ appears only once the
          icon strip has gone, where it stands in for the strip; the readout
          drops at the narrowest widths, leaving the ⋯ alone. */}
      <Button
        type="button"
        variant="default"
        className="preview-dimensions"
        title={
          disabled
            ? 'Viewport sizing is unavailable for external previews'
            : 'Set preview size or choose a breakpoint'
        }
        aria-label={sizeButtonLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={togglePopover}
        disabled={disabled}
      >
        <MoreHorizontalIcon size={14} className="preview-dimensions-dots" />
        <span className="preview-dimensions-label">
          {width ?? '—'} × {height ?? '—'}
        </span>
      </Button>
      {open && !disabled && (
        <div className="preview-size-popover" role="dialog" aria-labelledby="preview-size-title">
          <h2 id="preview-size-title" className="preview-size-title">
            Preview size
          </h2>
          {hasBreakpointOptions && (
            <section
              className="preview-size-breakpoints"
              aria-labelledby="preview-breakpoints-title"
            >
              <h3 id="preview-breakpoints-title" className="preview-size-breakpoints-title">
                Breakpoints
              </h3>
              <div
                className="preview-size-breakpoint-list"
                role="group"
                aria-label="Preview breakpoint options"
              >
                {(breakpointOptions ?? []).map((option) => (
                  <Button
                    key={option.value}
                    variant="ghost"
                    size="compact"
                    width="fill"
                    className="preview-size-breakpoint-option"
                    leftIcon={option.icon}
                    aria-pressed={option.value === activeBreakpoint}
                    title={`${option.label} (${option.width})`}
                    disabled={disabled}
                    onClick={() => {
                      onBreakpointChange?.(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="preview-size-breakpoint-option-label">{option.label}</span>
                    <span className="preview-size-breakpoint-option-width">{option.width}</span>
                  </Button>
                ))}
              </div>
            </section>
          )}
          {hasBreakpointOptions && <div className="preview-size-divider" aria-hidden="true" />}
          <div className="preview-size-inputs">
            <ValueField
              className="preview-size-field"
              value={widthText}
              variant="number"
              min={MIN_WIDTH}
              max={MAX_WIDTH}
              inputMode="numeric"
              onInput={(e) => {
                widthDraftRef.current = e.currentTarget.value;
              }}
              onKeyDown={onInputKeyDown}
              aria-label="Width in pixels"
              autoFocus
              onCommit={commitWidth}
            />
            <span className="preview-size-x">×</span>
            <ValueField
              className="preview-size-field"
              value={heightText}
              variant="number"
              keywords={[{ value: 'auto', label: 'AUTO', kind: 'keyword' }]}
              placeholder="auto"
              min={MIN_HEIGHT}
              max={MAX_HEIGHT}
              inputMode="numeric"
              onInput={(e) => {
                heightDraftRef.current = e.currentTarget.value;
              }}
              onKeyDown={onInputKeyDown}
              aria-label="Height in pixels (empty for auto)"
              onCommit={commitHeight}
            />
          </div>
          {scalePercent !== null && (
            <p className="preview-size-note">
              Wider than the pane — rendered at true size, scaled to {scalePercent}%.
            </p>
          )}
          <div className="preview-size-actions">
            <Button variant="primary" size="default" onClick={apply}>
              Apply
            </Button>
            <Button
              variant="secondary"
              size="default"
              onClick={() => {
                onFit();
                setOpen(false);
              }}
            >
              Fit pane
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}
