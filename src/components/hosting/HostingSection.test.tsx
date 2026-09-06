/**
 * The layout-shift invariant, plus the copy rules.
 *
 * jsdom has no layout engine, so "the row is always 56px" cannot be asserted
 * directly. It is pinned two ways instead:
 *
 * 1. **Structurally, here** — every state renders the same three slots, the
 *    action column is present in the DOM even when there is nothing to click,
 *    and a scripted transition preserves node identity rather than remounting.
 * 2. **In the stylesheet, by `pnpm check:patterns`** — the heights are
 *    token-driven and no rule inside the section may change box metrics on
 *    hover, which is what made the previous implementation grow ~105px under
 *    the cursor. That half lives with the other CSS policy checks because
 *    Vitest stubs CSS imports to an empty string, so asserting on stylesheet
 *    text from a unit test silently passes against nothing.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { HostingRow } from './HostingRow';
import { copyFor, BANNED_JARGON, titleFor } from '../../lib/hostingCopy';
import type { Deployment, SectionState, SectionStateKind } from '../../lib/hosting';

const ALL_KINDS: SectionStateKind[] = [
  'checking',
  'not_pushed',
  'queued',
  'building',
  'publishing',
  'ready',
  'failed',
  'canceled',
  'skipped',
  'gated',
  'unknown',
  'not_found_yet',
  'not_found',
  'no_token',
  'token_rejected',
  'no_link',
  'offline',
  'rate_limited',
];

function deployment(): Deployment {
  return {
    id: 'dpl_1',
    status_label: 'Ready',
    phase: { phase: 'ready' },
    environment: 'production',
    branch: 'main',
    commit_sha: 'abc123',
    urls: { aliases: [], primary: 'https://example.vercel.app' },
    dashboard_url: 'https://vercel.com/x/y',
    created_at: Date.now() - 60_000,
  };
}

function stateFor(kind: SectionStateKind): SectionState {
  return { kind, provider: 'vercel', deployment: deployment() };
}

describe('HostingRow geometry', () => {
  it.each(ALL_KINDS)('renders the same three slots in the %s state', (kind) => {
    const { container } = render(<HostingRow state={stateFor(kind)} commitSubject="Fix the nav" />);

    const row = container.querySelector('.hosting-row');
    expect(row).toBeInTheDocument();
    expect(row?.querySelector('[data-slot="icon"]')).toBeInTheDocument();
    expect(row?.querySelector('[data-slot="text"]')).toBeInTheDocument();
    // Present in every state — hidden, never removed, so the column keeps
    // its width and the text column never reflows.
    expect(row?.querySelector('[data-slot="action"]')).toBeInTheDocument();
  });

  it.each(ALL_KINDS)('always renders exactly two lines of text in %s', (kind) => {
    const { container } = render(<HostingRow state={stateFor(kind)} commitSubject="Fix the nav" />);

    expect(container.querySelectorAll('.hosting-row-title')).toHaveLength(1);
    expect(container.querySelectorAll('.hosting-row-status')).toHaveLength(1);
  });

  it('keeps the same DOM nodes across a full deployment lifecycle', () => {
    // A remount is a repaint, and a repaint is where a height jump hides.
    const { container, rerender } = render(
      <HostingRow state={stateFor('checking')} commitSubject="Fix the nav" />
    );
    const firstRow = container.querySelector('.hosting-row');
    const firstText = container.querySelector('.hosting-row-text');

    for (const kind of ['not_found_yet', 'queued', 'building', 'publishing', 'ready'] as const) {
      rerender(<HostingRow state={stateFor(kind)} commitSubject="Fix the nav" />);
      expect(container.querySelector('.hosting-row')).toBe(firstRow);
      expect(container.querySelector('.hosting-row-text')).toBe(firstText);
    }
  });

  it('shows exactly one indicator while checking', () => {
    // The loading state used to draw the provider mark *and* a spinner in the
    // same slot. With no provider known yet the mark is a bare outlined
    // circle, so it rendered as two concentric rings — read as a broken double
    // spinner rather than as loading.
    const { container } = render(<HostingRow state={{ kind: 'checking' }} />);
    const icon = container.querySelector('[data-slot="icon"]');

    expect(icon?.querySelectorAll('.hosting-row-globe')).toHaveLength(0);
    expect(icon?.querySelectorAll('.hosting-row-dot')).toHaveLength(0);
    expect(icon?.children).toHaveLength(1);
  });

  it('never uses native title tooltips, which paint over the row below', () => {
    for (const kind of ALL_KINDS) {
      const { container } = render(
        <HostingRow state={stateFor(kind)} commitSubject="Fix the nav" />
      );
      expect(container.querySelectorAll('[title]')).toHaveLength(0);
    }
  });

  it('hides an unavailable action rather than dropping the column', () => {
    const { container } = render(
      <HostingRow state={{ kind: 'not_found_yet', provider: 'vercel' }} />
    );
    const action = container.querySelector('[data-slot="action"]');
    expect(action).toBeInTheDocument();
    expect(action).toHaveAttribute('data-empty', 'true');
  });
});

describe('hosting copy', () => {
  /**
   * The row's text column is 184px: a 320px popover, less 24px of section
   * padding, less the 24px icon slot, less the 72px action column that stays
   * reserved in every state, less two 8px gaps. At 11px that is roughly 32
   * characters, and both upper lines are `text-overflow: ellipsis` with no
   * tooltip to recover what gets cut.
   *
   * The budget is approximate on purpose — it is a character count standing in
   * for a pixel measurement, so it is set where a real overflow trips it and a
   * merely long line does not. The UI harness measures the real thing and
   * reports every ellipsised element per scenario; this catches it at the point
   * someone edits the string.
   */
  const COLUMN_BUDGET = 34;

  /**
   * States whose line 1 is the user's own commit subject, which is theirs to
   * make as long as they like. Clipping that is legitimate; clipping a sentence
   * we wrote is not.
   */
  const OUR_OWN_TITLE = new Set<SectionStateKind>(['no_token', 'token_rejected', 'no_link']);

  it('writes both upper lines to fit the column they render in', () => {
    for (const kind of ALL_KINDS) {
      const copy = copyFor(stateFor(kind), 'Fix the nav', 'abc123a');
      expect(copy.status.length, `${kind} status: "${copy.status}"`).toBeLessThanOrEqual(
        COLUMN_BUDGET
      );
      if (OUR_OWN_TITLE.has(kind)) {
        expect(copy.title.length, `${kind} title: "${copy.title}"`).toBeLessThanOrEqual(
          COLUMN_BUDGET
        );
      }
    }
  });

  it('gives the informative half of a state its own full-width line', () => {
    // Everything below used to be appended to the status line after an em
    // dash, where it was the part the ellipsis ate.
    const skipped = copyFor(
      {
        kind: 'skipped',
        provider: 'vercel',
        deployment: deployment(),
        detail: { detail: 'skipped_because', reason: '[skip ci] in commit message' },
      },
      'Fix the nav'
    );
    expect(skipped.hint).toContain('[skip ci] in commit message');
    expect(skipped.status).not.toContain('[skip ci]');

    const canceled = copyFor(
      {
        kind: 'canceled',
        provider: 'vercel',
        deployment: deployment(),
        detail: { detail: 'superseded_by_newer' },
      },
      'Fix the nav'
    );
    expect(canceled.hint).toMatch(/newer push replaced it/);
    expect(canceled.status).not.toMatch(/newer push/);
  });

  it('never leaks provider jargon in any state', () => {
    for (const kind of ALL_KINDS) {
      const copy = copyFor(stateFor(kind), 'Fix the nav', 'abc123a');
      for (const line of [copy.title, copy.status, copy.hint, copy.action]) {
        if (!line) continue;
        expect(line, `${kind}: "${line}"`).not.toMatch(BANNED_JARGON);
      }
    }
  });

  it('never mentions plugins', () => {
    for (const kind of ALL_KINDS) {
      const copy = copyFor(stateFor(kind), 'Fix the nav');
      expect(`${copy.title} ${copy.status} ${copy.hint ?? ''}`).not.toMatch(/plugin/i);
    }
  });

  it('leads with what the user shipped, then what the provider says', () => {
    const copy = copyFor(stateFor('ready'), 'Fix the nav');
    expect(copy.title).toBe('Fix the nav');
    // Vercel's own word, not a synonym — so this and the Vercel dashboard
    // never disagree about what a deployment is called.
    expect(copy.status).toMatch(/^Ready · Production/);
  });

  it("uses the provider's status word rather than one of its own", () => {
    const building = {
      ...stateFor('building'),
      deployment: { ...deployment(), status_label: 'Building' },
    };
    expect(copyFor(building, 'Fix the nav').status).toMatch(/^Building/);

    const errored = {
      ...stateFor('failed'),
      deployment: { ...deployment(), status_label: 'Error' },
    };
    expect(copyFor(errored, 'Fix the nav').status).toMatch(/^Error/);
  });

  it('prefers the local commit subject over the provider message', () => {
    // Netlify returned null for both `commit_message` and `title` on a real
    // production deploy, so git is the reliable source.
    const withProviderMessage = { ...deployment(), commit_message: 'from the API' };
    expect(titleFor('from git', withProviderMessage)).toBe('from git');
    expect(titleFor(null, withProviderMessage)).toBe('from the API');
    expect(titleFor(null, undefined)).toBe('Your latest push');
  });

  it('describes a missing deployment without claiming it failed', () => {
    const copy = copyFor({ kind: 'not_found', provider: 'vercel' }, 'Fix the nav', '9f3c1ab');
    expect(copy.status).not.toMatch(/fail/i);
    expect(copy.hint).not.toMatch(/fail/i);
    expect(copy.status).toBe('No deploy reported yet');
    // And it names the commit it found nothing for, so "nothing reported" can
    // never be read as a verdict on some other push.
    expect(copy.hint).toMatch(/Vercel has nothing for commit 9f3c1ab/);
  });

  it('explains an expired CLI login in terms of the CLI', () => {
    const copy = copyFor(
      { kind: 'token_rejected', provider: 'vercel', tokenSource: 'cli_file' },
      'Fix the nav'
    );
    expect(copy.status).toMatch(/CLI login has expired/);
    // The title is the way out, not a restatement of the problem.
    expect(copy.title).toBe('Reconnect Vercel');
  });

  it('reassures that deploys still run when we simply cannot see them', () => {
    const copy = copyFor({ kind: 'no_token', provider: 'vercel' });
    expect(copy.hint).toMatch(/deploys run either way/i);
  });
});
