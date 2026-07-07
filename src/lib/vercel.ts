/**
 * Vercel project domain lookup.
 *
 * Ship Studio publishes via Vercel's GitHub integration and only ever knew the
 * git push — never the deployed domain. This reads the production custom domain
 * Vercel actually has configured so the UI can show the real site address.
 *
 * @module lib/vercel
 */

import { invoke } from '@tauri-apps/api/core';

/** Production domains Vercel reports for a linked project (snake_case from Rust). */
export interface VercelDomainInfo {
  /** Verified production custom domain (e.g. "pop.bimbi.co"), or null. */
  custom_domain: string | null;
  /** System `*.vercel.app` URL, used as a fallback display, or null. */
  system_url: string | null;
}

/**
 * Fetch a project's production custom domain, matched by its GitHub repo
 * (`owner/name`) across the user's personal scope and every Vercel team. Returns
 * null when there's no repo, the CLI isn't authenticated, no Vercel project is
 * linked to the repo, or there's no domain to report — never a constructed URL.
 */
export async function getVercelProductionDomain(
  projectPath: string,
  githubRepo: string | null
): Promise<VercelDomainInfo | null> {
  return invoke<VercelDomainInfo | null>('get_vercel_production_domain', {
    projectPath,
    githubRepo,
  });
}

/** The single address to show/open: the custom domain if any, else the system url. */
export function liveSiteHost(domain: VercelDomainInfo | null): string | null {
  return domain?.custom_domain ?? domain?.system_url ?? null;
}
