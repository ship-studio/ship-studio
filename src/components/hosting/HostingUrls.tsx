/**
 * The addresses a deployment produced, each said plainly.
 *
 * Two URLs matter and they are not interchangeable:
 *
 * - **Site** — the project's production domain. What people visit, and what
 *   the owner would call "the site". It is a property of the *project* and on
 *   Vercel lives on a different endpoint from the deployment entirely.
 * - **Build** — this deployment's immutable permalink. Always resolves to this
 *   exact commit even after newer deploys, which is what makes it useful for
 *   checking what you just shipped, and what makes it wrong to present as the
 *   site's address.
 *
 * Showing one unlabelled URL meant showing a per-build permalink and calling
 * it the site. Each row is labelled so it is never ambiguous which is which,
 * and each gets its own open control so "open" always has one meaning.
 */

import { MiddleTruncate } from '../primitives/MiddleTruncate';
import { ExternalLinkIcon } from '@/components/icons';
import type { Deployment } from '../../lib/hosting';

interface Row {
  label: string;
  url: string;
  /** Read out to screen readers, where the visual label isn't enough. */
  description: string;
}

function rowsFor(deployment?: Deployment): Row[] {
  if (!deployment) return [];
  const rows: Row[] = [];

  if (deployment.urls.site) {
    rows.push({
      label: 'Site',
      url: deployment.urls.site,
      description: 'Open the live site',
    });
  }

  // Only worth its own row when it is actually a different address. On a
  // project with no custom domain these can coincide.
  if (deployment.urls.deployment && deployment.urls.deployment !== deployment.urls.site) {
    rows.push({
      label: 'Build',
      url: deployment.urls.deployment,
      description: 'Open this exact build',
    });
  }

  return rows;
}

/** Strip the scheme for display. The value opened is still the full URL. */
function displayHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

interface Props {
  deployment?: Deployment;
  onOpen: (url: string) => void;
}

export function HostingUrls({ deployment, onOpen }: Props) {
  const rows = rowsFor(deployment);
  if (rows.length === 0) return null;

  return (
    <div className="hosting-urls">
      {rows.map((row) => (
        /* The whole row is the control. An address that looks like a link
           should open when you click it, rather than sending you hunting for
           a small icon at the end of the line. */
        <button
          type="button"
          className="hosting-url"
          key={row.label}
          onClick={() => onOpen(row.url)}
          aria-label={`${row.description} — ${displayHost(row.url)}`}
        >
          <span className="hosting-url-label">{row.label}</span>
          {/* Middle-truncated, not end-truncated: a build permalink's tail
              carries the domain, so cutting the end leaves an address you
              can't identify at all. */}
          <MiddleTruncate className="hosting-url-value" text={displayHost(row.url)} />
          {/* Decorative: the row itself is the button, so this must not be a
              second tab stop announcing the same action twice. */}
          <span className="hosting-url-open" aria-hidden="true">
            <ExternalLinkIcon size={12} />
          </span>
        </button>
      ))}
    </div>
  );
}
