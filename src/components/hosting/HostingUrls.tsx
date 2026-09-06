/**
 * The addresses a deployment produced, named the way the provider names them.
 *
 * Vercel's own vocabulary: a project has a **production domain**, and each
 * deployment gets its own **deployment URL** ("Each time you deploy, Vercel
 * generates a unique URL"). "Site" and "Build" were words this app invented,
 * and neither told you which one had your change on it.
 *
 * What is shown depends on where the deployment went, because that is what
 * decides which address is worth clicking:
 *
 * - A **production** deploy shows the production domain first — your change is
 *   live there — with the commit permalink under it for pinning this exact
 *   version.
 * - A **preview** deploy shows only its own URL. The production domain does
 *   *not* contain this change, so offering it invites clicking the wrong one.
 *
 * There is deliberately no branch URL. Vercel documents the shape of one
 * (`<project>-git-<branch>-<scope>.vercel.app`) but does not return it on the
 * deployment, and the same docs note it is truncated past 63 characters and
 * mangled by anti-phishing rules — which is exactly why the previous
 * implementation's assembled preview links 404'd.
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

export function rowsFor(deployment?: Deployment): Row[] {
  if (!deployment) return [];

  // A preview never reached production, so the production domain would be a
  // link to somebody else's change sitting directly under yours.
  if (deployment.environment === 'preview') {
    return deployment.urls.deployment
      ? [
          {
            label: 'Deployment',
            url: deployment.urls.deployment,
            description: 'Open this preview deployment',
          },
        ]
      : [];
  }

  const rows: Row[] = [];

  if (deployment.urls.site) {
    rows.push({
      label: 'Domain',
      url: deployment.urls.site,
      description: 'Open the production domain',
    });
  }

  // Only worth its own row when it is a different address — a project with no
  // custom domain can have these coincide.
  if (deployment.urls.deployment && deployment.urls.deployment !== deployment.urls.site) {
    rows.push({
      label: 'Deployment',
      url: deployment.urls.deployment,
      description: 'Open this deployment',
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
