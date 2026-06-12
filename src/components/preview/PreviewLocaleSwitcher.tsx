/**
 * PreviewLocaleSwitcher — view the preview in any configured language.
 *
 * Shows a compact globe button in the preview toolbar with the locale the
 * current path is displaying; the dropdown rewrites the path's locale prefix
 * (default locale is the unprefixed form — i18n middleware redirects as
 * needed). Renders nothing unless the project has 2+ locales configured.
 *
 * @module components/PreviewLocaleSwitcher
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GlobeIcon } from '../icons';
import { useModal } from '../../contexts/ModalContext';
import { getI18nStatus, localeDisplayName, pathLocale, switchPathLocale } from '../../lib/i18n';
import { logger } from '../../lib/logger';

export interface PreviewLocaleConfig {
  locales: string[];
  defaultLocale: string | null;
}

interface PreviewLocaleSwitcherProps {
  projectPath: string;
  /** Current preview pathname (tracked from the iframe). */
  currentPage: string;
  onNavigate: (route: string) => void;
  /** Reports the loaded config so the parent can keep page selection locale-aware. */
  onConfigChange?: (config: PreviewLocaleConfig | null) => void;
}

export function PreviewLocaleSwitcher({
  projectPath,
  currentPage,
  onNavigate,
  onConfigChange,
}: PreviewLocaleSwitcherProps) {
  const [config, setConfig] = useState<PreviewLocaleConfig | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const applyStatus = useCallback(
    (status: Awaited<ReturnType<typeof getI18nStatus>>) => {
      const next =
        status.configured && status.locales.length >= 2
          ? { locales: status.locales, defaultLocale: status.defaultLocale }
          : null;
      setConfig(next);
      onConfigChange?.(next);
    },
    [onConfigChange]
  );

  /** Re-check on dropdown open so Languages-modal changes are picked up. */
  const refresh = useCallback(() => {
    getI18nStatus(projectPath)
      .then(applyStatus)
      .catch((err) =>
        logger.warn('[PreviewLocaleSwitcher] i18n status check failed', { error: String(err) })
      );
  }, [projectPath, applyStatus]);

  useEffect(() => {
    let cancelled = false;
    getI18nStatus(projectPath)
      .then((status) => {
        if (!cancelled) applyStatus(status);
      })
      .catch((err) =>
        logger.warn('[PreviewLocaleSwitcher] i18n status check failed', { error: String(err) })
      );
    return () => {
      cancelled = true;
    };
  }, [projectPath, applyStatus]);

  // The Languages modal is where the config changes — refetch when it closes
  // so the switcher appears right after languages are first enabled (when
  // `config` is null there's no button to click, so open-click refresh alone
  // can't recover).
  const i18nModalOpen = useModal('i18n').isOpen;
  const sawModalOpenRef = useRef(false);
  useEffect(() => {
    if (i18nModalOpen) {
      sawModalOpenRef.current = true;
      return;
    }
    if (!sawModalOpenRef.current) return;
    sawModalOpenRef.current = false;
    let cancelled = false;
    getI18nStatus(projectPath)
      .then((status) => {
        if (!cancelled) applyStatus(status);
      })
      .catch((err) =>
        logger.warn('[PreviewLocaleSwitcher] i18n status check failed', { error: String(err) })
      );
    return () => {
      cancelled = true;
    };
  }, [i18nModalOpen, projectPath, applyStatus]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!config) return null;

  const active = pathLocale(currentPage, config.locales, config.defaultLocale);

  const selectLocale = (code: string) => {
    setOpen(false);
    if (code === active) return;
    onNavigate(switchPathLocale(currentPage, code, config.locales, config.defaultLocale));
  };

  return (
    <div className="locale-switcher" ref={rootRef}>
      <button
        type="button"
        className="locale-switcher-btn"
        title="View in another language"
        onClick={() => {
          if (!open) void refresh();
          setOpen(!open);
        }}
      >
        <GlobeIcon size={12} />
        <span className="locale-switcher-code">{(active ?? '–').toUpperCase()}</span>
      </button>
      {open && (
        <div className="locale-dropdown">
          {config.locales.map((code) => (
            <button
              key={code}
              type="button"
              className={`locale-item${code === active ? ' active' : ''}`}
              onClick={() => selectLocale(code)}
            >
              <span className="locale-item-name">{localeDisplayName(code)}</span>
              <span className="locale-item-code">{code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
