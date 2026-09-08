/**
 * One screen of the conversational onboarding: a question, a beat of work, or
 * a handoff to the user. Never two of them at once.
 *
 * The frame exists so every step in the flow shares one rhythm — same optical
 * centre, same type ramp, same enter animation — and so a new step is a body
 * and two strings rather than another bespoke layout.
 *
 * `stepKey` drives the transition: change it and the screen re-enters. That is
 * why the animation is keyed off a prop rather than mount, since the flow
 * keeps one `FlowScreen` alive and swaps its contents.
 */

import { ReactNode } from 'react';

interface FlowScreenProps {
  /** Changing this replays the enter animation. Use the step's id. */
  stepKey: string;
  /** The question, in the second person. One line. */
  title: ReactNode;
  /** Optional supporting line. Plain language — no jargon, no mechanics. */
  subtitle?: ReactNode;
  /** Options, progress, whatever this step is actually made of. */
  children: ReactNode;
  /** Pinned under the body: primary action, skip link, reassurance. */
  footer?: ReactNode;
  /** 0–1. Renders the hairline progress bar; omit on terminal screens. */
  progress?: number;
}

export function FlowScreen({
  stepKey,
  title,
  subtitle,
  children,
  footer,
  progress,
}: FlowScreenProps) {
  return (
    <div className="flow-screen">
      {progress !== undefined && (
        <div
          className="flow-progress"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
        >
          <div className="flow-progress-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      )}

      {/* key= restarts the CSS animation on every step change. */}
      <div className="flow-screen-inner" key={stepKey}>
        <header className="flow-screen-header">
          <h1 className="flow-screen-title">{title}</h1>
          {subtitle && <p className="flow-screen-subtitle">{subtitle}</p>}
        </header>

        <div className="flow-screen-body">{children}</div>

        {footer && <footer className="flow-screen-footer">{footer}</footer>}
      </div>
    </div>
  );
}
