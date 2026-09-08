/**
 * One screen of the conversational onboarding: a question, a beat of work, or
 * a handoff to the user. Never two of them at once.
 *
 * The frame exists so every step in the flow shares one rhythm — same optical
 * centre, same type ramp, same enter animation — and so a new step is a body
 * and two strings rather than another bespoke layout.
 *
 * `stepKey` drives both the transition and the focus move: change it and the
 * screen re-enters *and* the new question is announced. The animation is keyed
 * off a prop rather than mount because the flow keeps one `FlowScreen` alive
 * and swaps its contents — which is also exactly why focus has to be moved by
 * hand. Nothing unmounts, so a screen reader would otherwise sit silently on
 * the previous question while the visible one changed underneath it.
 */

import { ReactNode, useEffect, useRef } from 'react';

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
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // `preventScroll` because the heading is already in view; without it the
    // browser scrolls the animating card and the entrance visibly jumps.
    headingRef.current?.focus({ preventScroll: true });
  }, [stepKey]);

  return (
    // The step is on the DOM so a capture, a test or a bug report can name
    // which screen it is looking at. Every screen otherwise renders the same
    // handful of classes, which made the back half of the flow unreachable by
    // the harness — the two `.button--primary` screens were indistinguishable.
    <div className="flow-screen" data-flow-step={stepKey}>
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
          {/* `tabIndex={-1}` makes it programmatically focusable without
              putting it in the tab order — the target of a focus move, not a
              stop on the way to the buttons. */}
          <h1 className="flow-screen-title" ref={headingRef} tabIndex={-1}>
            {title}
          </h1>
          {subtitle && <p className="flow-screen-subtitle">{subtitle}</p>}
        </header>

        <div className="flow-screen-body">{children}</div>

        {footer && <footer className="flow-screen-footer">{footer}</footer>}
      </div>
    </div>
  );
}
