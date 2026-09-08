/**
 * "You're all set!" celebration screen shown after setup completes.
 *
 * Shows a brief success message with a button to continue to projects.
 * Both a 2.5s auto-advance timer and the "Get Started" button lead onward;
 * a ref guard makes sure `onContinue` fires exactly once no matter which
 * (or both) trigger.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';

interface CelebrationScreenProps {
  /** Called when user clicks to continue */
  onContinue: () => void;
  /**
   * Whether the (optional) hosting step actually completed. Drives honest
   * copy: "everything is connected" would be a lie when hosting was skipped.
   */
  hostingConnected: boolean;
  /**
   * Tools the user ended up without — skipped, failed, or abandoned.
   *
   * Same rule as `hostingConnected`, and the one that matters more: a machine
   * missing Git is not "all set", and telling someone it is means they find
   * out later, on their own, in the middle of something else. Naming it here
   * costs one line and buys the whole screen its credibility.
   */
  missing?: string[];
}

export function CelebrationScreen({
  onContinue,
  hostingConnected,
  missing = [],
}: CelebrationScreenProps) {
  const [showContent, setShowContent] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const firedRef = useRef(false);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fireContinue = useCallback(
    (fromClick: boolean) => {
      if (firedRef.current) return;
      firedRef.current = true;
      if (autoTimerRef.current !== null) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
      // Completion can take a few seconds (persisting setup state, loading the
      // dashboard) — a click with zero feedback reads as a broken button.
      if (fromClick) setIsContinuing(true);
      onContinue();
    },
    [onContinue]
  );

  // Animate in the content
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Auto-continue after a brief delay
  useEffect(() => {
    autoTimerRef.current = setTimeout(() => fireContinue(false), 2500);
    return () => {
      if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current);
    };
  }, [fireContinue]);

  return (
    <div className={`celebration-screen ${showContent ? 'visible' : ''}`}>
      <div className="celebration-content">
        <div className="celebration-icon">
          {/* The app's own mark, at the size the dashboard uses it — this is
              the first time the user meets the product rather than the setup,
              so the last screen of onboarding should look like the first
              screen of the app. */}
          <img
            src="/ShipStudio_IconBrand.png"
            alt=""
            className="celebration-logo"
            aria-hidden="true"
          />
        </div>
        <h1 className="celebration-title">
          {missing.length > 0 ? "You're ready to start" : "You're all set!"}
        </h1>
        <p className="celebration-subtitle">
          {missing.length > 0
            ? `Set up without ${listOut(missing)} — you can add ${
                missing.length === 1 ? 'it' : 'them'
              } any time from Settings.`
            : hostingConnected
              ? 'Everything is installed and connected'
              : 'Your dev environment is ready'}
        </p>
        <Button
          variant="primary"
          className="celebration-btn"
          onClick={() => fireContinue(true)}
          disabled={isContinuing}
        >
          {isContinuing ? <Spinner size="sm" /> : 'Get Started'}
        </Button>
      </div>
    </div>
  );
}

/** "A", "A and B", "A, B and C" — the way a person would say it. */
function listOut(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
