import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPane } from './SplitPane';

describe('SplitPane', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the shared panel resize handle for the workspace divider', () => {
    render(
      <SplitPane
        defaultSplit={29}
        minLeft={20}
        minRight={35}
        persistenceKey="workspaceSplit"
        left={<div>Agent</div>}
        right={<div>Preview</div>}
      />
    );

    const handle = screen.getByRole('separator', { name: 'Resize workspace panels' });

    expect(handle).toHaveClass('panel-resize-handle', 'panel-resize-handle--vertical');
    expect(handle).toHaveAttribute('aria-valuemin', '20');
    expect(handle).toHaveAttribute('aria-valuemax', '65');
    expect(handle).toHaveAttribute('aria-valuenow', '29');
  });

  it('persists keyboard resizing within the split bounds', () => {
    render(
      <SplitPane
        defaultSplit={29}
        minLeft={20}
        minRight={35}
        persistenceKey="workspaceSplit"
        left={<div>Agent</div>}
        right={<div>Preview</div>}
      />
    );

    const handle = screen.getByRole('separator', { name: 'Resize workspace panels' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(handle).toHaveAttribute('aria-valuenow', '39');
    expect(localStorage.getItem('workspaceSplit')).toBe('39');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(handle).toHaveAttribute('aria-valuenow', '65');
    expect(localStorage.getItem('workspaceSplit')).toBe('65');
  });

  it('uses the shared pixel minimum for the Agent panel', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });

    render(
      <SplitPane
        defaultSplit={10}
        minLeft={20}
        minLeftWidthPx={180}
        minRight={35}
        persistenceKey="workspaceSplit"
        left={<div>Agent</div>}
        right={<div>Preview</div>}
      />
    );

    const handle = screen.getByRole('separator', { name: 'Resize workspace panels' });

    expect(handle).toHaveAttribute('aria-valuemin', '180');
    expect(handle).toHaveAttribute('aria-valuemax', '650');
    expect(handle).toHaveAttribute('aria-valuenow', '180');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '180');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '190');
    expect(localStorage.getItem('workspaceSplit')).toBe('19');
  });
});
