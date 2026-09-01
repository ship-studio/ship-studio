/**
 * The gallery's three "nothing to show" states must stay distinguishable
 * (issue #754): loading skeletons, a search that matched nothing, and a fetch
 * that failed — the last one with a working retry.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateGallery } from './TemplateGallery';

const noop = () => {};

function renderGallery(props: Partial<React.ComponentProps<typeof TemplateGallery>> = {}) {
  return render(
    <TemplateGallery
      templates={[]}
      loading={false}
      onSelect={noop}
      selectedId={null}
      searchQuery=""
      onSearchChange={noop}
      {...props}
    />
  );
}

describe('TemplateGallery empty states', () => {
  it('shows "no templates" only when the fetch succeeded', () => {
    renderGallery();
    expect(screen.getByText('No templates found')).toBeTruthy();
  });

  it('shows neither empty nor error copy while loading', () => {
    renderGallery({ loading: true });
    expect(screen.queryByText('No templates found')).toBeNull();
    expect(screen.queryByText(/Couldn't load templates/)).toBeNull();
  });

  it('shows the load error with a retry button instead of "no templates"', () => {
    const onRetry = vi.fn();
    renderGallery({ loadError: 'offline', onRetry });

    expect(screen.queryByText('No templates found')).toBeNull();
    expect(screen.getByText(/Couldn't load templates\. offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
