/**
 * The addresses, and which is which.
 *
 * The bug these pin: the section showed one unlabelled URL, taken from the
 * deployment record. That record's `url` is a per-build permalink carrying a
 * generated hash and the account name — so the section displayed something
 * unrecognisable, never showed the address people actually visit, and gave no
 * way to tell which kind of URL it was.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HostingUrls } from './HostingUrls';
import type { Deployment } from '../../lib/hosting';

function deployment(
  urls: Partial<Deployment['urls']>,
  environment: Deployment['environment'] = 'production'
): Deployment {
  return {
    id: 'dpl_1',
    status_label: 'Ready',
    phase: { phase: 'ready' },
    environment,
    branch: 'main',
    commit_sha: 'abc1234',
    urls: { aliases: [], ...urls },
    created_at: Date.now(),
  };
}

const SITE = 'https://pepper-cayenne-accessories.vercel.app';
const BUILD = 'https://pepper-cayenne-accessories-myos1awic-juliangalluzzo.vercel.app';

describe('HostingUrls', () => {
  it('names the addresses the way Vercel names them', () => {
    // "Site" and "Build" were this app's own words. Vercel calls one the
    // production domain and the other the deployment URL.
    render(
      <HostingUrls deployment={deployment({ site: SITE, deployment: BUILD })} onOpen={vi.fn()} />
    );

    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.getByText('Deployment')).toBeInTheDocument();
  });

  it('never offers the production domain from a preview', () => {
    // The change isn't there. Showing production beside a preview is an
    // invitation to click the wrong one and conclude the deploy did nothing.
    render(
      <HostingUrls
        deployment={deployment({ site: SITE, deployment: BUILD }, 'preview')}
        onOpen={vi.fn()}
      />
    );

    expect(screen.queryByText('Domain')).not.toBeInTheDocument();
    expect(screen.getByText('Deployment')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('surfaces the site address, not just the build permalink', () => {
    // Asserted through the accessible name: the visible text goes through
    // MiddleTruncate, which measures with canvas and so collapses to an
    // ellipsis under jsdom's zero-width layout. The address itself is what
    // matters here, and it reaches the user either way.
    render(
      <HostingUrls deployment={deployment({ site: SITE, deployment: BUILD })} onOpen={vi.fn()} />
    );

    expect(
      screen.getByRole('button', {
        name: 'Open the production domain — pepper-cayenne-accessories.vercel.app',
      })
    ).toBeInTheDocument();
  });

  it('gives each address its own open control, each saying what it opens', () => {
    render(
      <HostingUrls deployment={deployment({ site: SITE, deployment: BUILD })} onOpen={vi.fn()} />
    );

    // A bare "Open" can't say which of two addresses it means.
    expect(screen.getByLabelText(/Open the production domain/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Open this deployment/)).toBeInTheDocument();
  });

  it('opens when the address text itself is clicked, not only the icon', () => {
    // The icon is a hover affordance. A row that reads like a link has to
    // behave like one when you click the part you were reading.
    const onOpen = vi.fn();
    render(<HostingUrls deployment={deployment({ site: SITE })} onOpen={onOpen} />);

    fireEvent.click(screen.getByText('Domain'));
    expect(onOpen).toHaveBeenCalledWith(SITE);
  });

  it('exposes one control per address, not two', () => {
    // The icon lives inside the row's button; announcing it separately would
    // give screen readers and keyboard users the same action twice.
    render(
      <HostingUrls deployment={deployment({ site: SITE, deployment: BUILD })} onOpen={vi.fn()} />
    );
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('opens the address its own control belongs to', () => {
    const onOpen = vi.fn();
    render(
      <HostingUrls deployment={deployment({ site: SITE, deployment: BUILD })} onOpen={onOpen} />
    );

    fireEvent.click(screen.getByLabelText(/Open the production domain/));
    expect(onOpen).toHaveBeenCalledWith(SITE);

    fireEvent.click(screen.getByLabelText(/Open this deployment/));
    expect(onOpen).toHaveBeenCalledWith(BUILD);
  });

  it('does not repeat one address under two labels', () => {
    // A project whose site domain is also the deployment URL should show one
    // row, not the same string twice.
    render(
      <HostingUrls deployment={deployment({ site: SITE, deployment: SITE })} onOpen={vi.fn()} />
    );

    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.queryByText('Deployment')).not.toBeInTheDocument();
  });

  it('shows the build alone when the site address is unknown', () => {
    // Honest degradation: if the project's domains couldn't be read, the
    // permalink is still real and still worth offering — but it is labelled
    // "Build", never presented as the site.
    render(<HostingUrls deployment={deployment({ deployment: BUILD })} onOpen={vi.fn()} />);

    expect(screen.queryByText('Domain')).not.toBeInTheDocument();
    expect(screen.getByText('Deployment')).toBeInTheDocument();
  });

  it('renders nothing rather than an empty frame when there are no addresses', () => {
    const { container } = render(<HostingUrls deployment={deployment({})} onOpen={vi.fn()} />);
    expect(container.querySelector('.hosting-urls')).not.toBeInTheDocument();

    const { container: noDeployment } = render(<HostingUrls onOpen={vi.fn()} />);
    expect(noDeployment.querySelector('.hosting-urls')).not.toBeInTheDocument();
  });

  it('strips the scheme for display but opens the full URL', () => {
    const onOpen = vi.fn();
    render(<HostingUrls deployment={deployment({ site: SITE })} onOpen={onOpen} />);

    // The label names the host without a scheme; the click still carries one.
    const button = screen.getByRole('button', {
      name: 'Open the production domain — pepper-cayenne-accessories.vercel.app',
    });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(SITE);
  });
});
