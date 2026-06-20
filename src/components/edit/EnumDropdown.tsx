/**
 * Custom dropdown for the visual editor's enum controls.
 *
 * Replaces the native <select> (whose menu is an unstyleable OS widget). The
 * menu is portaled to <body> and positioned under the trigger so the panel's
 * own `overflow` can't clip it, matching the panel's dark theme.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Option {
  label: string;
  token: string;
}

interface Props {
  label: string;
  options: Option[];
  /** Currently-active token, or null when none of the options is applied. */
  value: string | null;
  onChange: (token: string) => void;
}

export function EnumDropdown({ label, options, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = options.find((o) => o.token === value) ?? null;

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 4, left: r.left, width: r.width });
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

  // Close on outside pointer / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ss-enum__trigger"
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={current ? '' : 'ss-edit-panel__muted'}>{current?.label ?? '—'}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
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
                {o.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
