/**
 * One provider's status, in a row whose height never changes.
 *
 * That invariant is the whole point. The section this replaces swapped entire
 * DOM subtrees between states and grew ~85px when deployment data arrived a few
 * seconds after first paint, then another ~105px when the pointer touched it.
 * Here every state renders the same three slots — icon, two lines of text,
 * action — and an absent action reserves its width rather than collapsing.
 *
 * Nothing in this component or its stylesheet may change size on hover.
 */

import { Spinner } from '../primitives/Spinner';
import { Button } from '../primitives/Button';
import { VercelIcon, CloudflareIcon } from '../icons';
import type { HostingProvider, SectionState } from '../../lib/hosting';
import { copyFor } from '../../lib/hostingCopy';

/** Status dot appearance per state. Purely presentational. */
type DotTone = 'success' | 'progress' | 'error' | 'muted' | 'hollow' | 'none';

const DOT_TONES: Record<SectionState['kind'], DotTone> = {
  checking: 'muted',
  not_pushed: 'hollow',
  queued: 'muted',
  building: 'progress',
  publishing: 'progress',
  ready: 'success',
  failed: 'error',
  canceled: 'muted',
  skipped: 'muted',
  gated: 'progress',
  unknown: 'muted',
  not_found_yet: 'muted',
  not_found: 'hollow',
  no_token: 'none',
  token_rejected: 'error',
  no_link: 'none',
  offline: 'muted',
  rate_limited: 'muted',
};

/** States whose dot pulses because something is genuinely in motion. */
const PULSING = new Set<SectionState['kind']>([
  'checking',
  'queued',
  'building',
  'publishing',
  'not_found_yet',
]);

function ProviderMark({ provider }: { provider?: HostingProvider }) {
  switch (provider) {
    case 'vercel':
      return <VercelIcon size={14} />;
    case 'cloudflare':
      return <CloudflareIcon size={14} />;
    // Netlify has no brand mark in the icon set yet, and inventing one from a
    // raw SVG would break the icon rules. The neutral globe is honest until it
    // is imported properly.
    default:
      return <GlobeMark />;
  }
}

/** Neutral placeholder used before a provider is known. */
function GlobeMark() {
  return <span className="hosting-row-globe" aria-hidden="true" />;
}

interface Props {
  state: SectionState;
  commitSubject?: string | null;
  shortSha?: string;
  onAction?: () => void;
}

export function HostingRow({ state, commitSubject, shortSha, onAction }: Props) {
  const copy = copyFor(state, commitSubject, shortSha);
  const tone = DOT_TONES[state.kind];
  const pulsing = PULSING.has(state.kind);

  return (
    <div className="hosting-row" data-state={state.kind}>
      <div className="hosting-row-icon" data-slot="icon">
        <ProviderMark provider={state.provider} />
        {state.kind === 'checking' ? (
          <Spinner size="sm" className="hosting-row-spinner" />
        ) : tone === 'none' ? null : (
          <span
            className={`hosting-row-dot hosting-row-dot--${tone}${
              pulsing ? ' hosting-row-dot--pulsing' : ''
            }`}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="hosting-row-text" data-slot="text">
        <div className="hosting-row-title" title={copy.title}>
          {copy.title}
        </div>
        <div className="hosting-row-status" title={copy.status}>
          {copy.status}
          {state.isStale ? <span className="hosting-row-stale"> · not just checked</span> : null}
        </div>
      </div>

      {/* Always rendered so the column keeps its width in every state. */}
      <div className="hosting-row-action" data-slot="action" data-empty={!copy.action}>
        {copy.action ? (
          <Button size="compact" variant="secondary" onClick={onAction}>
            {copy.action}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The third line: hints and links, also a fixed height. */
export function HostingLinks({ state, hint }: { state: SectionState; hint?: string }) {
  return (
    <div className="hosting-links" data-state={state.kind}>
      {hint ? (
        <span className="hosting-links-hint" title={hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
