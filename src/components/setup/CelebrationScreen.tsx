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
          {/* Rocket (Lucide, ISC) in Ship Studio green — you're ready to ship. */}
          <svg
            width="80"
            height="80"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--action)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
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
