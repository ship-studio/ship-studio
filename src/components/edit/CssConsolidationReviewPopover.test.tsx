import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CssConsolidationCandidate,
  CssConsolidationReview,
  CascadeRow,
} from '../../lib/cssCascade';
import type { CascadeSelection } from '../../hooks/useCssCascadeEditor';

const { commandsRef } = vi.hoisted(() => ({
  commandsRef: {
    current: [] as Array<{ id: string; title: string; run: () => void | Promise<void> }>,
  },
}));

vi.mock('../../commands/useCommands', () => ({
  useCommands: (
    factory: () => Array<{ id: string; title: string; run: () => void | Promise<void> }>
  ) => {
    commandsRef.current = factory();
  },
}));

vi.mock('../../lib/cssCascade', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/cssCascade')>();
  return {
    ...actual,
    reviewCssConsolidations: vi.fn(),
    applyCssConsolidation: vi.fn(),
  };
});

import { applyCssConsolidation, reviewCssConsolidations } from '../../lib/cssCascade';
import { CssConsolidationReviewPopover } from './CssConsolidationReviewPopover';

const candidate: CssConsolidationCandidate = {
  file: 'src/styles/site.css',
  before: '.card, .card--active { color: red; }\n.card, .card--active { background: white; }',
  after: '.card, .card--active { color: red; background: white; }',
  sourceVersion: 'version-1',
  first: {
    sourcePath: 'src/styles/site.css',
    sourceVersion: 'version-1',
    selectorOffset: 10,
    selector: '.card, .card--active',
    selectorMemberIndex: 0,
    matchedSelector: '.card',
    selectorMembers: ['.card', '.card--active'],
    innerText: 'color: red;',
    contextPath: [],
  },
  second: {
    sourcePath: 'src/styles/site.css',
    sourceVersion: 'version-1',
    selectorOffset: 48,
    selector: '.card, .card--active',
    selectorMemberIndex: 0,
    matchedSelector: '.card',
    selectorMembers: ['.card', '.card--active'],
    innerText: 'background: white;',
    contextPath: [],
  },
};

const reviewWithCandidate: CssConsolidationReview = {
  candidates: [candidate],
  unavailableReason: null,
};

function makeSelection(selectionId = 'selection-1'): CascadeSelection {
  return {
    selectionId,
    signature: {
      domPath: 'html/body/main/div',
      tagName: 'div',
      className: 'card',
      ancestorClasses: [],
    },
    instanceCount: 1,
  };
}

function makeRow(selectorOffset = 10): CascadeRow {
  return {
    index: 0,
    selector: '.card, .card--active',
    declarations: [],
    specificity: [0, 2, 0],
    sourceOrder: 0,
    mediaText: null,
    mediaMinPx: null,
    inactiveMedia: false,
    layer: null,
    origin: 'author',
    editable: true,
    file: 'src/styles/site.css',
    sourceIdentity: {
      ...candidate.first,
      selectorOffset,
    },
  };
}

function renderReview(options?: {
  selection?: CascadeSelection;
  rows?: CascadeRow[];
  hasPendingWrites?: boolean;
  onRefreshCascade?: () => void;
}) {
  const onRefreshCascade = options?.onRefreshCascade ?? vi.fn();
  const view = render(
    <CssConsolidationReviewPopover
      projectPath="/project"
      selection={options?.selection ?? makeSelection()}
      rows={options?.rows ?? [makeRow()]}
      bodies={{}}
      searchTerm=""
      loading={false}
      hasPendingWrites={options?.hasPendingWrites}
      onRefreshCascade={onRefreshCascade}
    />
  );
  return { ...view, onRefreshCascade };
}

afterEach(() => {
  vi.clearAllMocks();
  commandsRef.current = [];
});

describe('CssConsolidationReviewPopover', () => {
  it('shows no review link or palette action when the backend returns no safe plan', async () => {
    vi.mocked(reviewCssConsolidations).mockResolvedValue({
      candidates: [],
      unavailableReason: 'No safe adjacent rules were found.',
    });

    renderReview();

    await waitFor(() => expect(reviewCssConsolidations).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Review safe consolidations' })).toBeNull();
    expect(commandsRef.current).toEqual([]);
  });

  it('opens the shared review popover from the link or Cmd+K and applies only on explicit action', async () => {
    const user = userEvent.setup();
    vi.mocked(reviewCssConsolidations)
      .mockResolvedValueOnce(reviewWithCandidate)
      .mockResolvedValue({ candidates: [], unavailableReason: null });
    vi.mocked(applyCssConsolidation).mockResolvedValue(undefined);
    const { onRefreshCascade } = renderReview();

    const trigger = await screen.findByRole('button', { name: 'Review safe consolidations' });
    expect(reviewCssConsolidations).toHaveBeenCalledTimes(1);
    await user.click(trigger);

    const popover = screen.getByRole('dialog', { name: 'Safe CSS consolidations' });
    expect(popover).toBeInTheDocument();
    await user.click(screen.getByText('.card, .card--active'));
    const previews = popover.querySelectorAll('pre');
    expect(previews[0]?.textContent).toBe(candidate.before);
    expect(previews[1]?.textContent).toBe(candidate.after);

    fireEvent.keyDown(popover, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      await commandsRef.current.find((command) => command.id === 'css.reviewConsolidations')?.run();
    });
    expect(screen.getByRole('dialog', { name: 'Safe CSS consolidations' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply consolidation' }));
    await waitFor(() => expect(applyCssConsolidation).toHaveBeenCalledWith('/project', candidate));
    expect(onRefreshCascade).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Review safe consolidations' })).toBeNull()
    );
    expect(reviewCssConsolidations).toHaveBeenCalledTimes(2);
  });

  it('waits for pending CSS writes before enabling explicit apply', async () => {
    vi.mocked(reviewCssConsolidations).mockResolvedValue(reviewWithCandidate);
    const user = userEvent.setup();
    renderReview({ hasPendingWrites: true });

    await user.click(await screen.findByRole('button', { name: 'Review safe consolidations' }));
    expect(
      screen.getByText(
        'Wait for current CSS edits to finish saving before applying a consolidation.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply consolidation' })).toBeDisabled();
    expect(applyCssConsolidation).not.toHaveBeenCalled();
  });

  it('discards an availability response when the selection changes in flight', async () => {
    let resolveFirst!: (value: CssConsolidationReview) => void;
    let resolveSecond!: (value: CssConsolidationReview) => void;
    vi.mocked(reviewCssConsolidations)
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

    const view = renderReview();
    view.rerender(
      <CssConsolidationReviewPopover
        projectPath="/project"
        selection={makeSelection('selection-2')}
        rows={[makeRow(90)]}
        bodies={{}}
        searchTerm=""
        loading={false}
        onRefreshCascade={vi.fn()}
      />
    );

    await act(async () => {
      resolveFirst(reviewWithCandidate);
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Review safe consolidations' })).toBeNull();

    const nextCandidate: CssConsolidationCandidate = {
      ...candidate,
      first: { ...candidate.first, selectorOffset: 90 },
    };
    await act(async () => {
      resolveSecond({ candidates: [nextCandidate], unavailableReason: null });
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('button', { name: 'Review safe consolidations' })
    ).toBeInTheDocument();
  });
});
