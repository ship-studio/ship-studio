import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { CssEditorPanel } from './CssEditorPanel';
import type { CssSelection } from '../../hooks/useCssEditor';

// jsdom has no CSS.supports — stub it so the value-validation path is exercised.
beforeAll(() => {
  if (typeof CSS === 'undefined') {
    (globalThis as unknown as { CSS: unknown }).CSS = {};
  }
  (CSS as unknown as { supports: (p: string, v: string) => boolean }).supports = (
    _p: string,
    v: string
  ) => v.trim() !== '' && !v.includes('@@');
});

const sig = (className: string) => ({ className, tagName: 'div', ancestorClasses: [] });

function renderPanel(
  selection: CssSelection | null,
  overrides: Partial<Parameters<typeof CssEditorPanel>[0]> = {}
) {
  const props = {
    selection,
    authoredSheets: ['src/styles/main.css'],
    saving: false,
    onPreview: vi.fn(),
    onSave: vi.fn(),
    onSaveMany: vi.fn(),
    onCreateRule: vi.fn(),
    targetClass: null,
    pseudo: null,
    allClasses: [],
    breakpointMinPx: null,
    onSelectClass: vi.fn(),
    onAddClass: vi.fn(),
    onRemoveClass: vi.fn(),
    onSetPseudo: vi.fn(),
    onSetBreakpoint: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<CssEditorPanel {...props} />);
  return props;
}

describe('CssEditorPanel', () => {
  it('shows the empty state before a selection', () => {
    renderPanel(null);
    expect(screen.getByText(/click an element to edit its styles/i)).toBeInTheDocument();
  });

  const resolved = (declarations: { property: string; value: string; important: boolean }[]) =>
    ({
      signature: sig('hero-title'),
      resolution: {
        status: 'resolved',
        file: 'src/styles/main.css',
        selector: '.hero-title',
        line: 4,
        media_min_px: null,
        declarations,
      },
      instanceCount: 1,
    }) as CssSelection;

  it('renders a resolved rule with the selector and Visual/Code toggle', () => {
    renderPanel(resolved([{ property: 'color', value: 'red', important: false }]));
    expect(
      screen.getByText('.hero-title', { selector: 'code.ss-css-selector' })
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Visual' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Code' })).toBeInTheDocument();
    // Default Visual view shows the Layout category controls.
    expect(screen.getByText('Display')).toBeInTheDocument();
  });

  it('class bar selects/removes a class and the state switcher sets a pseudo', () => {
    const onSelectClass = vi.fn();
    const onRemoveClass = vi.fn();
    const onSetPseudo = vi.fn();
    renderPanel(resolved([{ property: 'color', value: 'red', important: false }]), {
      onSelectClass,
      onRemoveClass,
      onSetPseudo,
    });
    fireEvent.click(screen.getByRole('button', { name: '.hero-title' }));
    expect(onSelectClass).toHaveBeenCalledWith('hero-title');
    fireEvent.click(screen.getByRole('button', { name: 'Remove .hero-title' }));
    expect(onRemoveClass).toHaveBeenCalledWith('hero-title');
    fireEvent.click(screen.getByRole('button', { name: 'Hover' }));
    expect(onSetPseudo).toHaveBeenCalledWith('hover');
  });

  it('the breakpoint switcher targets a media layer', () => {
    const onSetBreakpoint = vi.fn();
    renderPanel(resolved([{ property: 'color', value: 'red', important: false }]), {
      onSetBreakpoint,
    });
    fireEvent.click(screen.getByRole('button', { name: 'MD' }));
    expect(onSetBreakpoint).toHaveBeenCalledWith(768);
  });

  it('a structured control saves a single property', () => {
    const onSave = vi.fn();
    renderPanel(resolved([{ property: 'display', value: 'block', important: false }]), { onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Flex' }));
    expect(onSave).toHaveBeenCalledWith('display', 'flex');
  });

  it('renders accordion sections and adds a typed property', () => {
    const onSave = vi.fn();
    renderPanel(resolved([{ property: 'color', value: 'red', important: false }]), { onSave });
    // Sections are present (collapsible <details>), not tabs.
    expect(screen.getByText('Layout')).toBeInTheDocument();
    expect(screen.getByText('Effects')).toBeInTheDocument();
    // The always-available add row writes any property.
    fireEvent.change(screen.getByPlaceholderText('property'), { target: { value: 'opacity' } });
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSave).toHaveBeenCalledWith('opacity', '0.5');
  });

  it('clicking a set property label resets it', () => {
    const onSave = vi.fn();
    renderPanel(resolved([{ property: 'opacity', value: '0.5', important: false }]), { onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Opacity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onSave).toHaveBeenCalledWith('opacity', null);
  });

  it('Code view shows raw CSS and saves the diff', () => {
    const onSaveMany = vi.fn();
    renderPanel(resolved([{ property: 'color', value: 'red', important: false }]), { onSaveMany });
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }));
    // The Code view is a CodeMirror editor (contenteditable), not a textarea —
    // assert it shows the serialized rule, then drive an edit through the view.
    const editor = document.querySelector('.cm-editor') as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor.textContent).toContain('color: red;');
    const view = EditorView.findFromDOM(editor)!;
    act(() => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'color: blue;\npadding: 8px;' },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSaveMany).toHaveBeenCalledWith([
      { property: 'color', value: 'blue' },
      { property: 'padding', value: '8px' },
    ]);
  });

  it('offers to create a rule when none is found', () => {
    const onCreateRule = vi.fn();
    const selection: CssSelection = {
      signature: sig('hero'),
      resolution: { status: 'not_found', selector: '.hero' },
      instanceCount: 1,
    };
    renderPanel(selection, { onCreateRule });
    fireEvent.click(screen.getByRole('button', { name: /create \.hero/i }));
    expect(onCreateRule).toHaveBeenCalledWith('src/styles/main.css', '.hero', []);
  });

  it('opens the agent-prep prompt from the empty state and pastes it', () => {
    const onSendToClaude = vi.fn();
    renderPanel(null, { onSendToClaude });
    fireEvent.click(screen.getByRole('button', { name: /prepare this project/i }));
    // The review view shows the prompt and a paste action.
    expect(screen.getByText(/refactor this project's styling/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    expect(onSendToClaude).toHaveBeenCalledTimes(1);
    expect(onSendToClaude.mock.calls[0][0]).toMatch(/multiple classes/i);
  });

  it('shows read-only guidance for a multiply-defined class', () => {
    const selection: CssSelection = {
      signature: sig('hero'),
      resolution: {
        status: 'multiple',
        selector: '.hero',
        locations: [
          { file: 'a.css', line: 1, column: 1 },
          { file: 'b.css', line: 2, column: 1 },
        ],
      },
      instanceCount: 1,
    };
    renderPanel(selection);
    expect(screen.getByText(/isn't safe to edit automatically/i)).toBeInTheDocument();
    expect(screen.getByText('a.css:1')).toBeInTheDocument();
  });
});
