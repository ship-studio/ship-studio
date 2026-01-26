/**
 * "You're all set!" celebration screen shown after setup completes.
 *
 * Shows a brief success message with a button to continue to projects.
 */

import { useEffect, useState } from 'react';

interface CelebrationScreenProps {
  /** Called when user clicks to continue */
  onContinue: () => void;
}

export function CelebrationScreen({ onContinue }: CelebrationScreenProps) {
  const [showContent, setShowContent] = useState(false);

  // Animate in the content
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Auto-continue after a brief delay
  useEffect(() => {
    const timer = setTimeout(() => onContinue(), 2500);
    return () => clearTimeout(timer);
  }, [onContinue]);

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
        <p className="celebration-subtitle">Everything is installed and connected</p>
        <button className="btn-primary celebration-btn" onClick={onContinue}>
          Get Started
        </button>
      </div>
    </div>
  );
}
