import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ElementTreePanel, treePlacementForTarget } from './ElementTreePanel';
import { projectElementTree } from '../../lib/element-tree-drag';
import { getSnapshot } from '../../commands/registry';
import { matchesContext } from '../../commands/types';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ToastContext')>()),
  useOptionalToast: () => ({ showToast }),
}));

function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

describe('ElementTreePanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps sibling zones broad and reserves a narrow center for nesting', () => {
    const target = {
      id: 2,
      group: 'elements',
      rect: { left: 0, top: 100, right: 240, bottom: 200, width: 240, height: 100 },
    };
    expect(treePlacementForTarget(target, { x: 10, y: 130 }, 'vertical')).toBe('before');
    expect(treePlacementForTarget(target, { x: 10, y: 140 }, 'vertical')).toBe('inside');
    expect(treePlacementForTarget(target, { x: 10, y: 160 }, 'vertical')).toBe('inside');
    expect(treePlacementForTarget(target, { x: 10, y: 170 }, 'vertical')).toBe('after');
    const tree = {
      id: 1,
      tag: 'body',
      cls: '',
      text: '',
      children: [
        {
          id: 2,
          tag: 'section',
          cls: '',
          text: '',
          children: [{ id: 3, tag: 'div', cls: '', text: '', children: [] }],
        },
        { id: 4, tag: 'main', cls: '', text: '', children: [] },
      ],
    };
    const expanded = () => true;
    expect(projectElementTree(tree, 2, 4, 'after', expanded).order).toEqual([1, 4, 2, 3]);
    const inside = projectElementTree(tree, 2, 4, 'inside', expanded);
    expect(inside.order).toEqual([1, 4, 2, 3]);
    expect(inside.rows.find((row) => row.node.id === 2)?.depth).toBe(2);
    expect(inside.rows.find((row) => row.node.id === 2)?.parentId).toBe(4);
    expect(projectElementTree(tree, 2, 3, 'inside', expanded).order).toEqual([1, 2, 3, 4]);
    const sameOrderReparent = projectElementTree(tree, 3, 4, 'before', expanded);
    expect(sameOrderReparent.order).toEqual([1, 2, 3, 4]);
    expect(sameOrderReparent.changed).toBe(true);
    expect(sameOrderReparent.rows.find((row) => row.node.id === 3)?.depth).toBe(1);
    expect(projectElementTree(tree, 2, 4, 'before', expanded).changed).toBe(false);
  });

  it('describes pinning the floating panel and unpinning the docked panel', () => {
    const onTogglePin = vi.fn();
    const props = {
      tree: { id: 1, tag: 'body', cls: '', text: '', children: [] },
      truncated: false,
      selectedId: 1,
      affectedIds: [],
      onSelect: vi.fn(),
      onHover: vi.fn(),
      projectPath: '/tmp/project',
      selectedSignature: null,
      onTogglePin,
    };

    const { rerender } = render(<ElementTreePanel {...props} pinned={false} />);
    const pinButton = screen.getByRole('button', { name: 'Pin Elements panel to the window' });
    expect(pinButton).toHaveAttribute('title', 'Pin to the window');
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    rerender(<ElementTreePanel {...props} pinned />);
    const unpinButton = screen.getByRole('button', { name: 'Unpin Elements panel' });
    expect(unpinButton).toHaveAttribute('title', 'Unpin — float over the workspace');
    expect(unpinButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows view-only state without a redundant Visual tab', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [{ id: 2, tag: 'div', cls: 'card', text: '', children: [] }],
        }}
        truncated={false}
        selectedId={1}
        affectedIds={[2]}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    expect(screen.getByText('View only')).toHaveAttribute(
      'data-tooltip-content',
      'Turn on edit mode to select and edit elements.'
    );
    expect(screen.queryByText('View-only mode')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Visual' })).not.toBeInTheDocument();
    const panel = screen.getByTestId('element-tree-panel');
    const header = panel.querySelector('.ss-tree-panel__header');
    const controls = panel.querySelector('.ss-tree-panel__controls');
    expect(controls).toBe(header?.nextElementSibling);
    expect(controls).toContainElement(screen.getByRole('button', { name: 'Use tag icons' }));
    expect(controls).toContainElement(screen.getByText('View only'));
    expect(header).not.toContainElement(screen.getByText('View only'));
    expect(panel.querySelector('[data-tree-id="2"]')).toHaveClass('affected');
  });

  it('collapses expanded branches in a partially expanded tree', async () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [
            {
              id: 2,
              tag: 'main',
              cls: '',
              text: '',
              children: [
                {
                  id: 3,
                  tag: 'section',
                  cls: '',
                  text: '',
                  children: [
                    {
                      id: 4,
                      tag: 'nav',
                      cls: '',
                      text: '',
                      children: [{ id: 5, tag: 'div', cls: '', text: '', children: [] }],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        truncated={false}
        selectedId={null}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    await waitFor(() => {
      const commands = getSnapshot();
      const expandAll = commands.find((command) => command.id === 'element.expandAll');
      const collapseAll = commands.find((command) => command.id === 'element.collapseAll');
      expect(expandAll).toBeDefined();
      expect(collapseAll).toBeDefined();
      expect(expandAll?.when).toBeTypeOf('function');
      expect(collapseAll?.when).toBeTypeOf('function');
      expect(matchesContext(expandAll?.when, { kind: 'project', currentProjectName: null })).toBe(
        true
      );
      expect(matchesContext(collapseAll?.when, { kind: 'project', currentProjectName: null })).toBe(
        true
      );
    });

    const panel = screen.getByTestId('element-tree-panel');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all elements' }));

    expect(screen.getByRole('button', { name: 'Expand all elements' })).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="1"]')).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="2"]')).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="3"]')).not.toBeInTheDocument();

    await waitFor(() => {
      const commands = getSnapshot();
      const expandAll = commands.find((command) => command.id === 'element.expandAll');
      const collapseAll = commands.find((command) => command.id === 'element.collapseAll');
      expect(expandAll).toBeDefined();
      expect(collapseAll).toBeDefined();
      expect(matchesContext(expandAll?.when, { kind: 'project', currentProjectName: null })).toBe(
        true
      );
      expect(matchesContext(collapseAll?.when, { kind: 'project', currentProjectName: null })).toBe(
        false
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand all elements' }));
    expect(panel.querySelector('[data-tree-id="5"]')).toBeInTheDocument();
  });

  it('renders sortable rows as siblings with whole-row activation', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [{ id: 2, tag: 'section', cls: 'hero', text: '', children: [] }],
        }}
        truncated={false}
        selectedId={1}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
        structure={{
          selectAndRun: vi.fn(),
          insert: vi.fn(),
          move: vi.fn(),
          duplicate: vi.fn(),
          remove: vi.fn(),
          copy: vi.fn(),
          cut: vi.fn(),
          paste: vi.fn(),
          hasClipboard: false,
          clipboardSourceNodeId: null,
        }}
      />
    );

    const panel = screen.getByTestId('element-tree-panel');
    const header = panel.querySelector('.ss-tree-panel__header');
    const controls = panel.querySelector('.ss-tree-panel__controls');
    expect(controls).toBe(header?.nextElementSibling);
    const item = panel.querySelector('[data-tree-id="2"]')?.closest('[data-drag-sort-item]');
    expect(item).toHaveAttribute('data-drag-sort-has-overlay', 'false');
    expect(item).toHaveAttribute('data-drag-sort-activation', 'item');
    expect(item?.querySelector('.drag-sort__handle')).not.toBeInTheDocument();
    expect(panel.querySelectorAll('[data-drag-sort-item]')).toHaveLength(2);
    expect(item?.querySelector('[data-drag-sort-item]')).not.toBeInTheDocument();
  });

  it('moves an element from its row', async () => {
    const move = vi.fn();
    const { container } = render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [
            { id: 2, tag: 'section', cls: 'first', text: '', children: [] },
            { id: 3, tag: 'section', cls: 'second', text: '', children: [] },
          ],
        }}
        truncated={false}
        selectedId={null}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
        structure={{
          selectAndRun: vi.fn(),
          insert: vi.fn(),
          move,
          duplicate: vi.fn(),
          remove: vi.fn(),
          copy: vi.fn(),
          cut: vi.fn(),
          paste: vi.fn(),
          hasClipboard: false,
          clipboardSourceNodeId: null,
        }}
      />
    );
    const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
    items.forEach((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: index * 30,
        right: 200,
        bottom: index * 30 + 24,
        width: 200,
        height: 24,
      } as DOMRect);
    });
    const row = container.querySelector('[data-tree-id="2"]')!;
    fireEvent(row, pointer('pointerdown', 20, 35));
    fireEvent(window, pointer('pointermove', 20, 82));
    expect(items[1]).toHaveAttribute('data-drag-sort-dragging', 'true');
    expect(document.querySelector('[data-drag-sort-overlay="true"]')).not.toBeInTheDocument();
    expect(items[2]).toHaveAttribute('data-drag-sort-target', 'true');
    expect(items[2]).toHaveAttribute('data-drag-sort-placement', 'after');
    fireEvent(window, pointer('pointerup', 20, 82));

    await waitFor(() => expect(move).toHaveBeenCalledWith(2, 3, 'after'));
  });

  it('requires a centered hold before nesting an element', async () => {
    vi.useFakeTimers();
    try {
      const move = vi.fn();
      const { container } = render(
        <ElementTreePanel
          tree={{
            id: 1,
            tag: 'body',
            cls: '',
            text: '',
            children: [
              { id: 2, tag: 'section', cls: 'source', text: '', children: [] },
              { id: 3, tag: 'section', cls: 'target', text: '', children: [] },
            ],
          }}
          truncated={false}
          selectedId={null}
          onSelect={vi.fn()}
          onHover={vi.fn()}
          projectPath="/tmp/project"
          selectedSignature={null}
          structure={{
            selectAndRun: vi.fn(),
            insert: vi.fn(),
            move,
            duplicate: vi.fn(),
            remove: vi.fn(),
            copy: vi.fn(),
            cut: vi.fn(),
            paste: vi.fn(),
            hasClipboard: false,
            clipboardSourceNodeId: null,
          }}
        />
      );
      const items = [...container.querySelectorAll<HTMLElement>('[data-drag-sort-item]')];
      items.forEach((item, index) => {
        vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
          left: 0,
          top: index * 30,
          right: 200,
          bottom: index * 30 + 24,
          width: 200,
          height: 24,
        } as DOMRect);
      });

      const source = container.querySelector('[data-tree-id="2"]')!;
      const sourceItem = source.closest<HTMLElement>('[data-drag-sort-item]')!;
      const target = items[2];
      fireEvent(source, pointer('pointerdown', 20, 35));
      fireEvent(window, pointer('pointermove', 20, 72));

      expect(target).toHaveAttribute('data-drag-sort-placement', 'inside');
      expect(target).toHaveAttribute('data-drag-sort-inside-hold', 'pending');
      expect(sourceItem).toHaveStyle({ '--element-tree-depth': '1' });
      expect(move).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTime(500));
      expect(target).toHaveAttribute('data-drag-sort-inside-hold', 'flashing');
      await act(() => vi.advanceTimersByTime(150));
      expect(target).toHaveAttribute('data-drag-sort-inside-hold', 'ready');
      expect(sourceItem).toHaveStyle({ '--element-tree-depth': '2' });
      expect(move).not.toHaveBeenCalled();

      fireEvent(window, pointer('pointercancel', 20, 72));
      expect(move).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('temporarily collapses a dragged parent and removes its descendants as targets', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [
            {
              id: 2,
              tag: 'section',
              cls: 'parent',
              text: '',
              children: [{ id: 3, tag: 'div', cls: 'child', text: '', children: [] }],
            },
            { id: 4, tag: 'section', cls: 'sibling', text: '', children: [] },
          ],
        }}
        truncated={false}
        selectedId={null}
        onSelect={onSelect}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
        structure={{
          selectAndRun: vi.fn(),
          insert: vi.fn(),
          move: vi.fn(),
          duplicate: vi.fn(),
          remove: vi.fn(),
          copy: vi.fn(),
          cut: vi.fn(),
          paste: vi.fn(),
          hasClipboard: false,
          clipboardSourceNodeId: null,
        }}
      />
    );
    const parentRow = container.querySelector('[data-tree-id="2"]')!;

    // A press that never crosses the activation threshold is still a normal
    // row gesture: it must not collapse the parent or swallow selection.
    fireEvent(parentRow, pointer('pointerdown', 20, 35));
    fireEvent(window, pointer('pointerup', 20, 35));
    fireEvent.click(parentRow);
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(container.querySelector('[data-tree-id="3"]')).toBeInTheDocument();

    // Only the actual manager activation (the threshold-crossing move) hides
    // descendants and removes them from the sortable target set.
    fireEvent(parentRow, pointer('pointerdown', 20, 35));
    fireEvent(window, pointer('pointermove', 20, 82));

    await waitFor(() => {
      expect(container.querySelector('[data-tree-id="3"]')).not.toBeInTheDocument();
      expect(container.querySelectorAll('[data-drag-sort-item]')).toHaveLength(3);
    });
    fireEvent(window, pointer('pointerup', 20, 35));
    return waitFor(() => expect(container.querySelector('[data-tree-id="3"]')).toBeInTheDocument());
  });

  it('mirrors a preview hover on the matching row', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [{ id: 2, tag: 'div', cls: 'card', text: '', children: [] }],
        }}
        truncated={false}
        selectedId={1}
        hoveredId={2}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    expect(
      screen.getByTestId('element-tree-panel').querySelector('[data-tree-id="2"]')
    ).toHaveClass('hovered');
  });

  it('swaps supported tag names for the Insert Element icons', () => {
    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [
            { id: 2, tag: 'div', cls: 'card', text: '', children: [] },
            { id: 3, tag: 'main', cls: '', text: '', children: [] },
            { id: 4, tag: 'header', cls: '', text: '', children: [] },
            { id: 5, tag: 'nav', cls: '', text: '', children: [] },
            { id: 6, tag: 'code', cls: '', text: '', children: [] },
          ],
        }}
        truncated={false}
        selectedId={1}
        onSelect={vi.fn()}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
      />
    );

    const panel = screen.getByTestId('element-tree-panel');
    const toggle = screen.getByRole('button', { name: 'Use tag icons' });
    expect(panel.querySelector('[data-tree-id="2"] .ss-tree-tag')).toHaveTextContent('div');

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Use tag names' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      panel.querySelector('[data-tree-id="2"] [data-icon-name="ElementDivIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="2"] .ss-tree-tag')).not.toBeInTheDocument();
    expect(
      panel.querySelector('[data-tree-id="3"] [data-icon-name="ElementMainIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="3"] .ss-tree-tag')).toHaveTextContent('main');
    expect(
      panel.querySelector('[data-tree-id="4"] [data-icon-name="ElementHeadIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="4"] .ss-tree-tag')).toHaveTextContent('header');
    expect(
      panel.querySelector('[data-tree-id="5"] [data-icon-name="ElementNavIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="5"] .ss-tree-tag')).toHaveTextContent('nav');
    expect(
      panel.querySelector('[data-tree-id="6"] [data-icon-name="ElementCodeBlockIcon"]')
    ).toBeInTheDocument();
    expect(panel.querySelector('[data-tree-id="6"] .ss-tree-tag')).toHaveTextContent('code');
  });

  it('remembers the tag icon preference when the panel remounts', () => {
    const props = {
      tree: { id: 1, tag: 'body', cls: '', text: '', children: [] },
      truncated: false,
      selectedId: 1,
      onSelect: vi.fn(),
      onHover: vi.fn(),
      projectPath: '/tmp/project',
      selectedSignature: null,
    };

    const { unmount } = render(<ElementTreePanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use tag icons' }));
    expect(localStorage.getItem('elementTreeShowTagIcons')).toBe('1');

    unmount();
    render(<ElementTreePanel {...props} />);

    expect(screen.getByRole('button', { name: 'Use tag names' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('remembers the tag font and color preferences when the panel remounts', () => {
    const props = {
      tree: {
        id: 1,
        tag: 'body',
        cls: 'page-shell',
        text: '',
        children: [],
      },
      truncated: false,
      selectedId: 1,
      onSelect: vi.fn(),
      onHover: vi.fn(),
      projectPath: '/tmp/project',
      selectedSignature: null,
    };

    const { unmount } = render(<ElementTreePanel {...props} />);
    const panel = screen.getByTestId('element-tree-panel');
    expect(panel).not.toHaveClass('ss-tree-panel--sans-serif');
    expect(panel).not.toHaveClass('ss-tree-panel--monochrome');

    fireEvent.click(screen.getByRole('button', { name: 'Mono font off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use shades of grey' }));

    expect(panel).toHaveClass('ss-tree-panel--sans-serif');
    expect(panel).toHaveClass('ss-tree-panel--monochrome');
    expect(localStorage.getItem('elementTreeShowTagSansSerif')).toBe('1');
    expect(localStorage.getItem('elementTreeShowTagColors')).toBe('0');

    unmount();
    render(<ElementTreePanel {...props} />);

    const remountedPanel = screen.getByTestId('element-tree-panel');
    expect(remountedPanel).toHaveClass('ss-tree-panel--sans-serif');
    expect(remountedPanel).toHaveClass('ss-tree-panel--monochrome');
    expect(screen.getByRole('button', { name: 'Mono font on' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Use color-coding' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('uses the native context menu for structural actions and copies the node selector', async () => {
    const onSelect = vi.fn();
    const selectAndRun = vi.fn((_id: number, action: () => void) => action());
    const duplicate = vi.fn();
    const remove = vi.fn();
    const copy = vi.fn();
    const cut = vi.fn();
    const paste = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <ElementTreePanel
        tree={{
          id: 1,
          tag: 'body',
          cls: '',
          text: '',
          children: [{ id: 2, tag: 'div', cls: 'card featured', text: '', children: [] }],
        }}
        truncated={false}
        selectedId={1}
        onSelect={onSelect}
        onHover={vi.fn()}
        projectPath="/tmp/project"
        selectedSignature={null}
        structure={{
          selectAndRun,
          insert: vi.fn(),
          duplicate,
          remove,
          copy,
          cut,
          paste,
          hasClipboard: true,
          clipboardSourceNodeId: 99,
        }}
      />
    );

    const row = screen.getByTestId('element-tree-panel').querySelector('[data-tree-id="2"]')!;
    fireEvent.contextMenu(row, { clientX: 80, clientY: 100 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const menu = screen.getByRole('menu');
    expect(
      Array.from(menu.children).map((child) =>
        child.getAttribute('role') === 'separator'
          ? 'divider'
          : (child.textContent ?? '').replace(/\s+/g, ' ').trim()
      )
    ).toEqual([
      'Insert element…',
      'Copy ID',
      // Carried over from main's ElementTreeContextMenu (#856) when that
      // component was replaced by the ContextMenu primitive.
      'Copy selector',
      'Duplicate⌘D',
      'divider',
      'Cut⌘X',
      'Copy⌘C',
      'Paste⌘V',
      'divider',
      'Delete⌫',
    ]);
    expect(screen.getByText('⌘D')).toBeInTheDocument();
    expect(screen.getByText('⌫')).toBeInTheDocument();
    expect(screen.getByText('⌘X')).toBeInTheDocument();
    expect(screen.getByText('⌘C')).toBeInTheDocument();
    expect(screen.getByText('⌘V')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /^Duplicate ⌘D$/ }));
    expect(selectAndRun).toHaveBeenCalledWith(2, duplicate);

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Cut/ }));
    expect(selectAndRun).toHaveBeenCalledWith(2, cut);

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy ⌘C$/ }));
    expect(selectAndRun).toHaveBeenCalledWith(2, copy);

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Paste ⌘V$/ }));
    expect(selectAndRun).toHaveBeenCalledWith(2, paste);

    fireEvent.contextMenu(row);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy ID' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('div.card.featured');

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Delete ⌫$/ }));
    expect(selectAndRun).toHaveBeenCalledWith(2, remove);
  });

  describe('right-click menu — Copy selector (#856)', () => {
    const structure = {
      selectAndRun: vi.fn((_nodeId: number, run: () => void) => run()),
      insert: vi.fn(),
      duplicate: vi.fn(),
      remove: vi.fn(),
      // Clipboard actions arrived with the new ContextMenu (PR #881); this
      // suite predates them and only exercises "Copy selector".
      copy: vi.fn(),
      cut: vi.fn(),
      paste: vi.fn(),
      hasClipboard: false,
      clipboardSourceNodeId: null,
    };

    function renderTreeWithMenu() {
      render(
        <ElementTreePanel
          tree={{
            id: 1,
            tag: 'body',
            cls: '',
            text: '',
            children: [
              {
                id: 2,
                tag: 'div',
                cls: 'process-engagements__visual-collection',
                text: '',
                children: [],
              },
            ],
          }}
          truncated={false}
          selectedId={null}
          onSelect={vi.fn()}
          onHover={vi.fn()}
          projectPath="/tmp/project"
          selectedSignature={null}
          structure={structure}
        />
      );
      const panel = screen.getByTestId('element-tree-panel');
      const row = panel.querySelector('[data-tree-id="2"]');
      if (!row) throw new Error('row not found');
      fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    }

    it('offers a "Copy selector" action that puts the row\'s tag+class on the clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      renderTreeWithMenu();

      // The menu renders through a portal to document.body — `screen` (not a
      // local `container`) is what actually sees it. Confirm it's really
      // there before trusting the click below reached anything.
      const copyItem = screen.getByText('Copy selector');
      expect(copyItem).toBeInTheDocument();

      fireEvent.click(copyItem);

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith('div.process-engagements__visual-collection')
      );
    });

    it('names the reason when copying the selector fails (#1049)', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard write failed')) },
        configurable: true,
      });
      renderTreeWithMenu();

      fireEvent.click(screen.getByText('Copy selector'));

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          'Could not copy the selector (Clipboard write failed)',
          'error'
        )
      );
    });

    it('still offers Insert/Duplicate/Delete alongside Copy selector', () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
      renderTreeWithMenu();

      expect(screen.getByText('Insert element…')).toBeInTheDocument();
      expect(screen.getByText('Duplicate')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });
  });
});
