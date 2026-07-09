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
}

export function CelebrationScreen({ onContinue, hostingConnected }: CelebrationScreenProps) {
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
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
            <circle cx="40" cy="40" r="40" fill="var(--success)" />
            <path
              d="M24 40l10 10 22-24"
              stroke="white"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1 className="celebration-title">You're all set!</h1>
        <p className="celebration-subtitle">
          {hostingConnected
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
