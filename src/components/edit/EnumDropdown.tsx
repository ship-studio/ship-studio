/**
 * Custom dropdown for the visual editor's enum controls.
 *
 * Replaces the native <select> (whose menu is an unstyleable OS widget). The
 * menu is portaled to <body> and positioned under the trigger so the panel's
 * own `overflow` can't clip it, matching the panel's dark theme.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { PropertyField } from '../primitives/PropertyField';
import { ChevronIcon } from '@/components/icons';

const MENU_EDGE_GUTTER = 8;
const MENU_OFFSET = 4;

interface Option {
  label: string;
  token: string;
}

interface Props {
  label: string;
  options: Option[];
  optionIcons?: Record<string, ReactNode>;
  /** Render as a chevron-only overflow trigger for compact segmented rows. */
  compactTrigger?: boolean;
  /** Currently-active token, or null when none of the options is applied. */
  value: string | null;
  onChange: (token: string) => void;
}

export function EnumDropdown({
  label,
  options,
  optionIcons,
  compactTrigger = false,
  value,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = options.find((o) => o.token === value) ?? null;
  const currentIcon = current ? optionIcons?.[current.token] : undefined;

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuRect({ top: r.bottom + MENU_OFFSET, left: r.left, width: r.width });
  }, []);

  // Position the menu under the trigger when it opens, and keep it there.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  // The menu is wider than a compact trigger in most cases. Measure it after
  // the portal mounts and keep both edges inside the viewport instead of
  // letting the panel's right edge cut the options off.
  useLayoutEffect(() => {
    if (!open || !menuRect || !menuRef.current) return;
    const menu = menuRef.current.getBoundingClientRect();
    const maxLeft = Math.max(MENU_EDGE_GUTTER, window.innerWidth - menu.width - MENU_EDGE_GUTTER);
    const maxTop = Math.max(MENU_EDGE_GUTTER, window.innerHeight - menu.height - MENU_EDGE_GUTTER);
    const left = Math.min(Math.max(MENU_EDGE_GUTTER, menuRect.left), maxLeft);
    const top = Math.min(Math.max(MENU_EDGE_GUTTER, menuRect.top), maxTop);
    if (left === menuRect.left && top === menuRect.top) return;
    setMenuRect((current) => (current ? { ...current, left, top } : current));
  }, [open, menuRect]);

  // Close on outside pointer (menu is portaled, so the trigger is a second
  // "inside" root) / Escape.
  useDismissOnOutsidePointer(open, menuRef, () => setOpen(false), {
    isOutside: (t) => !triggerRef.current?.contains(t) && !menuRef.current?.contains(t),
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <PropertyField
        ref={triggerRef}
        variant="select"
        className={`ss-enum__trigger${compactTrigger ? ' ss-enum__trigger--compact' : ''}`}
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {compactTrigger ? (
          <span className="ss-enum__compact-icon" aria-hidden="true">
            <ChevronIcon />
          </span>
        ) : (
          <span className="ss-enum__current">
            {currentIcon && <span className="ss-enum__option-icon">{currentIcon}</span>}
            <span className={current ? '' : 'ss-edit-panel__muted'}>{current?.label ?? '—'}</span>
          </span>
        )}
        {!compactTrigger && <ChevronIcon className="ss-enum__chevron" />}
      </PropertyField>
      {open &&
        menuRect &&
        createPortal(
          <div
            ref={menuRef}
            className="ss-enum__menu"
            role="listbox"
            id={listId}
            style={{ top: menuRect.top, left: menuRect.left, minWidth: menuRect.width }}
          >
            {options.map((o) => (
              <button
                key={o.token}
                type="button"
                role="option"
                aria-selected={o.token === value}
                className={`ss-enum__item${o.token === value ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(o.token);
                  setOpen(false);
                }}
              >
                {optionIcons?.[o.token] && (
                  <span className="ss-enum__option-icon">{optionIcons[o.token]}</span>
                )}
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
