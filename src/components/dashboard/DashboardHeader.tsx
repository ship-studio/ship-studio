/**
 * DashboardHeader — the presentation-only hero shared by the home-level screens
 * (Home, Routines, Inbox). The mark and its pulse stay identical; only the
 * headline changes per view.
 *
 * @module components/DashboardHeader
 */

import { useState, type ReactNode } from 'react';
import { EyeOffIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';

interface DashboardHeaderProps {
  /** Called when the user hides the home screen header. */
  onHide?: () => void;
  /**
   * The headline under the mark. Home-level screens share this hero and each
   * asks its own question, so the three views read as one app rather than three
   * unrelated destinations.
   */
  title?: ReactNode;
}

export function DashboardHeader({
  onHide,
  title = 'What will you Ship today?',
}: DashboardHeaderProps) {
  const [clickPulseCount, setClickPulseCount] = useState(0);
  const [isHoverSuppressed, setIsHoverSuppressed] = useState(false);

  return (
    <header className="dashboard-hero">
      {onHide && (
        <IconButton
          variant="ghost"
          className="dashboard-hero-hide"
          icon={<EyeOffIcon size={14} />}
          onClick={onHide}
          title="Hide home screen header"
          aria-label="Hide home screen header"
        />
      )}
      <button
        type="button"
        className={`dashboard-hero-icon-button${isHoverSuppressed ? ' dashboard-hero-icon-button--hover-suppressed' : ''}`}
        aria-label="Pulse Ship Studio logo"
        onClick={() => {
          setIsHoverSuppressed(true);
          setClickPulseCount((count) => count + 1);
        }}
        onMouseLeave={() => setIsHoverSuppressed(false)}
      >
        <img
          key={clickPulseCount}
          src="/ShipStudio_IconBrand.png"
          alt="Ship Studio"
          className={`dashboard-hero-icon${clickPulseCount > 0 ? ' dashboard-hero-icon--click-pulsing' : ''}`}
          onAnimationEnd={() => {
            if (clickPulseCount > 0) setClickPulseCount(0);
          }}
        />
      </button>
      <h1 className="dashboard-hero-title text-style-h1">{title}</h1>
    </header>
  );
}
