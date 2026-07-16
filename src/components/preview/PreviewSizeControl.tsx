/**
 * The toolbar dimensions readout ("1440 × 900"), now a control: clicking it
 * opens a popover where the user types an exact viewport size — the same
 * true-width-scaled-to-fit rendering the agent gets via preview_set_viewport
 * and the editor gets via its breakpoint selector. Height is optional (auto
 * = full available height).
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { trackEvent } from '../../lib/analytics';

const MIN_WIDTH = 200;
const MAX_WIDTH = 3000;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 3000;

interface PreviewSizeControlProps {
  /** True (unscaled) width the page is laid out at. */
  width: number;
  /** True (unscaled) height. */
  height: number;
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
}

export function PreviewSizeControl({
  width,
  height,
  hasCustomHeight,
  scalePercent,
  onApply,
  onFit,
  openSignal = 0,
}: PreviewSizeControlProps) {
  const [open, setOpen] = useState(false);
  const [widthText, setWidthText] = useState('');
  const [heightText, setHeightText] = useState('');
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Seed the inputs from the live size each time the popover opens.
  const openPopover = () => {
    setWidthText(String(width));
    setHeightText(hasCustomHeight ? String(height) : '');
    setOpen(true);
  };

  // External open requests (the Cmd+K "Set exact preview size…" command) —
  // guarded render-time state adjustment, per the React derived-state pattern.
  const [seenSignal, setSeenSignal] = useState(openSignal);
  if (openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    if (openSignal > 0 && !open) openPopover();
  }

  useEffect(() => {
    if (open) void trackEvent('preview_size_popover_opened');
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const apply = () => {
    const w = Math.round(Number(widthText));
    if (!Number.isFinite(w) || w < MIN_WIDTH || w > MAX_WIDTH) return;
    let h: number | null = null;
    if (heightText.trim() !== '') {
      const parsed = Math.round(Number(heightText));
      if (!Number.isFinite(parsed) || parsed < MIN_HEIGHT || parsed > MAX_HEIGHT) return;
      h = parsed;
    }
    onApply(w, h);
    void trackEvent('preview_size_applied', { width: w, has_height: h !== null });
    setOpen(false);
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') apply();
  };

  return (
    <span className="preview-size-wrap" ref={wrapRef}>
      <button
        type="button"
        className="preview-dimensions"
        title="Set an exact preview size"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        {width} × {height}
      </button>
      {open && (
        <div className="preview-size-popover" role="dialog" aria-label="Set preview size">
          <div className="preview-size-inputs">
            <input
              type="number"
              className="preview-size-input"
              value={widthText}
              min={MIN_WIDTH}
              max={MAX_WIDTH}
              onChange={(e) => setWidthText(e.target.value)}
              onKeyDown={onInputKeyDown}
              aria-label="Width in pixels"
              autoFocus
            />
            <span className="preview-size-x">×</span>
            <input
              type="number"
              className="preview-size-input"
              value={heightText}
              placeholder="auto"
              min={MIN_HEIGHT}
              max={MAX_HEIGHT}
              onChange={(e) => setHeightText(e.target.value)}
              onKeyDown={onInputKeyDown}
              aria-label="Height in pixels (empty for auto)"
            />
          </div>
          {scalePercent !== null && (
            <p className="preview-size-note">
              Wider than the pane — rendered at true size, scaled to {scalePercent}%.
            </p>
          )}
          <div className="preview-size-actions">
            <Button variant="primary" size="sm" onClick={apply}>
              Apply
            </Button>
            <Button
              variant="secondary"
              size="sm"
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
