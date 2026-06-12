/**
 * Browser selection dropdown component.
 *
 * Displays the "Open in Browser" button with a dropdown for selecting
 * a specific browser. Default click opens in system default browser.
 *
 * @module components/BrowserDropdown
 */

import { useState, useEffect, useRef, useLayoutEffect, type CSSProperties } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ExternalLinkIcon,
  ChevronIcon,
  SafariIcon,
  ChromeIcon,
  FirefoxIcon,
  ArcIcon,
  BraveIcon,
  EdgeIcon,
  GlobeIcon,
} from '../icons';
import { BrowserInfo, checkBrowserAvailability, openUrlInBrowser } from '../../lib/browser';
import { logger } from '../../lib/logger';

interface BrowserDropdownProps {
  url: string;
  className?: string;
  buttonClassName?: string;
  /** When true, shows only the icon without text */
  iconOnly?: boolean;
}

const BROWSER_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  safari: SafariIcon,
  chrome: ChromeIcon,
  firefox: FirefoxIcon,
  arc: ArcIcon,
  brave: BraveIcon,
  edge: EdgeIcon,
};

export function BrowserDropdown({
  url,
  className = '',
  buttonClassName = 'preview-action-btn',
  iconOnly = false,
}: BrowserDropdownProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [openingBrowser, setOpeningBrowser] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({});

  // Check browser availability on mount
  useEffect(() => {
    void checkBrowserAvailability()
      .then((result) => setBrowsers(result))
      .catch(() => setBrowsers([]));
  }, []);

  // Clean up any pending close timer on unmount.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Short grace period so the user can cross the 4px gap between the
  // trigger button and the (fixed-positioned) dropdown without the
  // dropdown snapping shut mid-traverse.
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setShowDropdown(false);
      closeTimerRef.current = null;
    }, 120);
  };

  const openNow = () => {
    cancelClose();
    setShowDropdown(true);
  };

  // Dropdown uses position:fixed so it escapes ancestor `overflow: hidden`
  // (e.g. the sidebar's scroll/list clipping). Recompute coords each time it
  // opens from the trigger button's bounding rect — anchor the dropdown's
  // right edge to the trigger's right edge (matches the original right:0
  // absolute layout) and place its top just below the trigger.
  useLayoutEffect(() => {
    if (!showDropdown || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: 'fixed',
      top: `${rect.bottom}px`,
      right: `${window.innerWidth - rect.right}px`,
    });
  }, [showDropdown]);

  // Close on scroll — fixed coords don't track scrolling, so reopening on
  // re-hover keeps the dropdown glued to the button.
  useEffect(() => {
    if (!showDropdown) return;
    const handler = () => setShowDropdown(false);
    window.addEventListener('scroll', handler, true);
    return () => window.removeEventListener('scroll', handler, true);
  }, [showDropdown]);

  const handleDefaultOpen = () => {
    void openUrl(url);
  };

  const handleBrowserOpen = async (browserId: string) => {
    setOpeningBrowser(browserId);
    try {
      await openUrlInBrowser(url, browserId);
      setShowDropdown(false);
    } catch (e) {
      logger.error(`Failed to open in ${browserId}`, { error: e });
    } finally {
      setOpeningBrowser(null);
    }
  };

  const getBrowserIcon = (browserId: string) => {
    const IconComponent = BROWSER_ICONS[browserId] || GlobeIcon;
    return <IconComponent size={14} />;
  };

  const iconSize = iconOnly ? 12 : 14;

  // If no browsers detected, show simple button
  if (browsers.length === 0) {
    return (
      <button className={buttonClassName} onClick={handleDefaultOpen} title="Open in Browser">
        <ExternalLinkIcon size={iconSize} />
        {!iconOnly && <span>Open</span>}
      </button>
    );
  }

  return (
    <div
      className={`browser-dropdown-container ${className}`}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        className={`${buttonClassName} browser-dropdown-trigger`}
        onClick={handleDefaultOpen}
        title="Open in Browser (click for default, hover for options)"
      >
        <ExternalLinkIcon size={iconSize} />
        {!iconOnly && (
          <>
            <span>Open</span>
            <ChevronIcon size={10} className="browser-dropdown-chevron" />
          </>
        )}
      </button>
      {showDropdown && (
        <div
          className="browser-dropdown"
          style={dropdownStyle}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="browser-dropdown-inner">
            {browsers.map((browser) => (
              <button
                key={browser.id}
                onClick={() => void handleBrowserOpen(browser.id)}
                disabled={openingBrowser !== null}
              >
                {getBrowserIcon(browser.id)}
                {openingBrowser === browser.id ? 'Opening...' : browser.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
