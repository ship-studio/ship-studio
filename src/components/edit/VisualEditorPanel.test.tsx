import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VisualEditorPanel } from './VisualEditorPanel';
import {
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
  type Breakpoint,
  type UsageReport,
} from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';

const BREAKPOINTS: Breakpoint[] = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];
const MD = BREAKPOINTS.find((b) => b.name === 'md')!;

const resolvedSelection: Selection = {
  signature: { className: 'p-3', tagName: 'div', ancestorClasses: [] },
  resolution: {
    status: 'resolved',
    file: 'components/Hero.tsx',
    line: 11,
    column: 1,
    class_name: 'p-3',
    confidence: 'unique',
  },
  instanceCount: 1,
};

function renderPanel(
  selection: Selection | null,
  currentClass = 'p-3',
  activeBreakpoint: Breakpoint = BASE_BREAKPOINT,
  onSelectBreakpoint = vi.fn(),
  breakpointTooWide = false,
  autoSave = false,
  onToggleAutoSave = vi.fn(),
  onApplyEnum = vi.fn(),
  onSetSide = vi.fn(),
  onReset = vi.fn()
) {
  return render(
    <VisualEditorPanel
      selection={selection}
      projectPath="/Users/test/ShipStudio/demo"
      onReplaceImage={vi.fn(async () => {})}
      currentClass={currentClass}
      breakpoints={BREAKPOINTS}
      activeBreakpoint={activeBreakpoint}
      breakpointTooWide={breakpointTooWide}
      onSelectBreakpoint={onSelectBreakpoint}
      autoSave={autoSave}
      onToggleAutoSave={onToggleAutoSave}
      onStepGap={vi.fn()}
      onSetSide={onSetSide}
      onApplyEnum={onApplyEnum}
      onReset={onReset}
      multiTarget="all"
      onMultiTargetChange={vi.fn()}
      usage={null}
      onCommit={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

const multiSelection: Selection = {
  signature: { className: 'flex p-4', tagName: 'div', ancestorClasses: [] },
  resolution: {
    status: 'multi',
    class_name: 'flex p-4',
    locations: [
      { file: 'components/Hero.tsx', line: 11, column: 1 },
      { file: 'components/Footer.tsx', line: 9, column: 1 },
    ],
  },
  instanceCount: 2,
};

describe('VisualEditorPanel', () => {
  it('renders every control for a resolved element', () => {
    renderPanel(resolvedSelection);
    // Source line
    expect(screen.getByText('components/Hero.tsx:11')).toBeInTheDocument();
    // Box-model spacing editor with per-side fields
    expect(screen.getByTestId('spacing-box')).toBeInTheDocument();
    expect(screen.getByLabelText('Padding top')).toBeInTheDocument();
    expect(screen.getByLabelText('Margin left')).toBeInTheDocument();
    // Gap stepper + enum controls
    expect(screen.getByText('Gap')).toBeInTheDocument();
    expect(screen.getByText('Align')).toBeInTheDocument();
    expect(screen.getByText('Weight')).toBeInTheDocument();
    // Align renders icon buttons ("Left" is unique to Align)
    expect(screen.getByRole('button', { name: 'Left' })).toBeInTheDocument();
    // New properties
    expect(screen.getByText('Opacity')).toBeInTheDocument();
    // Color controls render as swatch buttons that open the picker popover
    expect(screen.getByRole('button', { name: 'Text color' })).toBeInTheDocument();
    // Save button
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows read-only reason and no controls for a read-only element', () => {
    renderPanel({
      signature: { className: 'x', tagName: 'div', ancestorClasses: [] },
      resolution: { status: 'read_only', reason: 'Dynamic classes.' },
      instanceCount: 1,
    });
    expect(screen.getByText('Dynamic classes.')).toBeInTheDocument();
    expect(screen.queryByTestId('spacing-box')).not.toBeInTheDocument();
  });

  it('warns when multiple elements share the source', () => {
    renderPanel({ ...resolvedSelection, instanceCount: 4 });
    expect(screen.getByText(/Editing 4 elements/)).toBeInTheDocument();
  });

  it('shows the manual Save button when auto-save is off and there are edits', () => {
    renderPanel(resolvedSelection, 'p-9'); // dirty (≠ source p-3), auto-save off
    expect(screen.getByRole('button', { name: 'Save to source' })).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: /auto-save/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling auto-save calls the handler', () => {
    const onToggle = vi.fn();
    renderPanel(resolvedSelection, 'p-9', BASE_BREAKPOINT, vi.fn(), false, false, onToggle);
    screen.getByRole('switch', { name: /auto-save/i }).click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('hides the Save button and shows "Saving…" while auto-save has pending edits', () => {
    renderPanel(resolvedSelection, 'p-9', BASE_BREAKPOINT, vi.fn(), false, true);
    expect(screen.queryByRole('button', { name: 'Save to source' })).not.toBeInTheDocument();
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /auto-save/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('renders the breakpoint dropdown showing the active breakpoint', () => {
    renderPanel(resolvedSelection, 'p-3', MD);
    const trigger = screen.getByRole('button', { name: 'Breakpoint' });
    expect(trigger).toHaveTextContent('md · ≥768px');
  });

  it('explains the mobile-first cascade contextually for the active breakpoint', () => {
    renderPanel(resolvedSelection, 'p-3', BASE_BREAKPOINT);
    expect(screen.getByText(/apply to every screen size/i)).toBeInTheDocument();
    renderPanel(resolvedSelection, 'p-3', MD);
    expect(screen.getByText(/from 768px wide and up/i)).toBeInTheDocument();
  });

  it('selecting a breakpoint from the dropdown asks to resize the canvas to that layer', () => {
    const onSelect = vi.fn();
    renderPanel(resolvedSelection, 'p-3', BASE_BREAKPOINT, onSelect);
    fireEvent.click(screen.getByRole('button', { name: 'Breakpoint' })); // open
    fireEvent.click(screen.getByRole('option', { name: 'lg · ≥1024px' }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'lg', minPx: 1024 }));
  });

  it('shows the "preview too narrow" note when the breakpoint exceeds the canvas', () => {
    renderPanel(
      resolvedSelection,
      'p-3',
      BREAKPOINTS.find((b) => b.name === 'xl'),
      vi.fn(),
      true
    );
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/too narrow to show/i);
    expect(note).toHaveTextContent('xl');
  });

  it('shows a value as inherited when only a smaller breakpoint defines it', () => {
    // gap-4 is set at base; viewing md, the panel reads 4 (inherited from Base).
    renderPanel(resolvedSelection, 'p-3 gap-4', MD);
    expect(screen.getByLabelText<HTMLInputElement>('Gap').value).toBe('4');
    // The Gap label carries an "inherited" indicator pointing at Base.
    expect(screen.getByLabelText('Inherited from Base')).toBeInTheDocument();
  });

  it('reads the active breakpoint value over the base one', () => {
    // base gap-2, md:gap-8 → at md the panel shows 8 (set here, not inherited).
    renderPanel(resolvedSelection, 'gap-2 md:gap-8', MD);
    expect(screen.getByLabelText<HTMLInputElement>('Gap').value).toBe('8');
    expect(screen.getByLabelText('Set on md')).toBeInTheDocument();
  });

  it('reads an arbitrary (free-form) value into the box field', () => {
    renderPanel(resolvedSelection, 'pt-[10rem]');
    expect(screen.getByLabelText<HTMLInputElement>('Padding top').value).toBe('10rem');
  });

  it('flags an invalid typed value and does not apply it', () => {
    const onApplyEnum = vi.fn();
    renderPanel(
      resolvedSelection,
      'gap-4',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      onApplyEnum
    );
    const gap = screen.getByLabelText('Gap');
    fireEvent.change(gap, { target: { value: '40xyz' } });
    fireEvent.keyDown(gap, { key: 'Enter' });
    expect(gap).toHaveAttribute('aria-invalid', 'true');
    expect(onApplyEnum).not.toHaveBeenCalled();
  });

  it('reveals "Reset" when clicking a set value name, and resets on confirm', () => {
    const onReset = vi.fn();
    // gap-4 is set on Base → the Gap label is a clickable reset trigger.
    renderPanel(
      resolvedSelection,
      'gap-4',
      BASE_BREAKPOINT,
      vi.fn(), // onSelectBreakpoint
      false, // breakpointTooWide
      false, // autoSave
      vi.fn(), // onToggleAutoSave
      vi.fn(), // onApplyEnum
      vi.fn(), // onSetSide
      onReset
    );
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Gap/ })); // click the name
    fireEvent.click(screen.getByRole('button', { name: 'Reset' })); // confirm
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows a usage scope line and opens a modal listing render sites', () => {
    const usage: UsageReport = {
      component: 'Header',
      selfKind: 'component',
      sites: [
        { file: 'app/about/page.tsx', line: 4, kind: 'page' },
        { file: 'app/blog/page.tsx', line: 6, kind: 'page' },
        { file: 'components/Nav.tsx', line: 9, kind: 'component' },
      ],
    };
    render(
      <VisualEditorPanel
        selection={resolvedSelection}
        currentClass="p-3"
        projectPath="/Users/test/ShipStudio/demo"
        onReplaceImage={vi.fn(async () => {})}
        breakpoints={BREAKPOINTS}
        activeBreakpoint={BASE_BREAKPOINT}
        breakpointTooWide={false}
        onSelectBreakpoint={vi.fn()}
        autoSave={false}
        onToggleAutoSave={vi.fn()}
        onStepGap={vi.fn()}
        onSetSide={vi.fn()}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        multiTarget="all"
        onMultiTargetChange={vi.fn()}
        usage={usage}
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const scope = screen.getByRole('button', { name: /used in 3 places/i });
    fireEvent.click(scope);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Header')).toBeInTheDocument(); // component name in the title
    // Rows are grouped by file (full path on the row's title).
    expect(screen.getByTitle('app/about/page.tsx')).toBeInTheDocument();
    expect(screen.getByTitle('components/Nav.tsx')).toBeInTheDocument();
  });

  it('warns when editing a layout (every page)', () => {
    renderPanel(resolvedSelection); // usage defaults to null → no scope line
    // With a layout usage, the panel surfaces the every-page warning.
    render(
      <VisualEditorPanel
        selection={resolvedSelection}
        currentClass="p-3"
        projectPath="/Users/test/ShipStudio/demo"
        onReplaceImage={vi.fn(async () => {})}
        breakpoints={BREAKPOINTS}
        activeBreakpoint={BASE_BREAKPOINT}
        breakpointTooWide={false}
        onSelectBreakpoint={vi.fn()}
        autoSave={false}
        onToggleAutoSave={vi.fn()}
        onStepGap={vi.fn()}
        onSetSide={vi.fn()}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        multiTarget="all"
        onMultiTargetChange={vi.fn()}
        usage={{ component: null, selfKind: 'layout', sites: [] }}
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getAllByText(/applies to/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('every page').length).toBeGreaterThan(0);
  });

  // Default props for inline renders that need to override a specific handler.
  const mk = () => ({
    projectPath: '/Users/test/ShipStudio/demo',
    onReplaceImage: vi.fn(async () => {}),
    breakpoints: BREAKPOINTS,
    activeBreakpoint: BASE_BREAKPOINT,
    breakpointTooWide: false,
    onSelectBreakpoint: vi.fn(),
    autoSave: false,
    onToggleAutoSave: vi.fn(),
    onStepGap: vi.fn(),
    onSetSide: vi.fn(),
    onApplyEnum: vi.fn(),
    onReset: vi.fn(),
    multiTarget: 'all' as const,
    onMultiTargetChange: vi.fn(),
    usage: null,
    onCommit: vi.fn(),
    onClose: vi.fn(),
  });

  it('jumps to the Code tab from the source badge', () => {
    const onOpenInCode = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="p-3"
        onOpenInCode={onOpenInCode}
      />
    );
    fireEvent.click(screen.getByTitle('Open in the Code tab'));
    expect(onOpenInCode).toHaveBeenCalledWith('components/Hero.tsx', 11);
  });

  it('jumps to the Code tab from a usage-modal line chip', () => {
    const onOpenInCode = vi.fn();
    const usage: UsageReport = {
      component: 'Header',
      selfKind: 'component',
      sites: [
        { file: 'app/about/page.tsx', line: 42, kind: 'page' },
        { file: 'app/blog/page.tsx', line: 7, kind: 'page' },
      ],
    };
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="p-3"
        usage={usage}
        onOpenInCode={onOpenInCode}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /used in 2 places/i })); // open modal
    fireEvent.click(screen.getByRole('button', { name: '42' })); // the line chip
    expect(onOpenInCode).toHaveBeenCalledWith('app/about/page.tsx', 42);
  });

  it('renders a multi-location element as editable, defaulting to edit-all', () => {
    renderPanel(multiSelection, 'flex p-4');
    expect(screen.getByTestId('spacing-box')).toBeInTheDocument(); // editable, not read-only
    expect(screen.getByText(/Editing 2 places that share these classes/)).toBeInTheDocument();
  });

  it('lets you narrow a multi edit to a single source location', () => {
    const onMultiTargetChange = vi.fn();
    render(
      <VisualEditorPanel
        selection={multiSelection}
        currentClass="flex p-4"
        projectPath="/Users/test/ShipStudio/demo"
        onReplaceImage={vi.fn(async () => {})}
        breakpoints={BREAKPOINTS}
        activeBreakpoint={BASE_BREAKPOINT}
        breakpointTooWide={false}
        onSelectBreakpoint={vi.fn()}
        autoSave={false}
        onToggleAutoSave={vi.fn()}
        onStepGap={vi.fn()}
        onSetSide={vi.fn()}
        onApplyEnum={vi.fn()}
        onReset={vi.fn()}
        multiTarget="all"
        onMultiTargetChange={onMultiTargetChange}
        usage={null}
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Just one/ }));
    fireEvent.click(screen.getByRole('option', { name: 'components/Hero.tsx:11' }));
    expect(onMultiTargetChange).toHaveBeenCalledWith(0);
  });

  it('does not offer Reset for an inherited value (only set-here)', () => {
    // gap-4 at Base, viewing md → inherited; the Gap label is plain text, no button.
    renderPanel(resolvedSelection, 'gap-4', MD);
    expect(screen.queryByRole('button', { name: /Gap/ })).not.toBeInTheDocument();
    expect(screen.getByText('Gap')).toBeInTheDocument();
  });

  it('applies a valid typed unit as an arbitrary gap value', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const onApplyEnum = vi.fn();
    renderPanel(
      resolvedSelection,
      'gap-4',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      onApplyEnum
    );
    const gap = screen.getByLabelText('Gap');
    fireEvent.change(gap, { target: { value: '10rem' } });
    fireEvent.keyDown(gap, { key: 'Enter' });
    expect(onApplyEnum).toHaveBeenCalledWith('gap-[10rem]', { gap: '10rem' });
    vi.unstubAllGlobals();
  });

  // ── Image section (asset replacement) ──

  const imgSelection: Selection = {
    signature: {
      className: '',
      tagName: 'img',
      ancestorClasses: [],
      attrSrc: '/hero.png',
      currentSrc: 'http://localhost:3000/hero.png',
    },
    // A classless image: the CLASS resolver has nothing static to offer…
    resolution: {
      status: 'read_only',
      reason: 'These classes aren’t a static string in source (dynamic or generated).',
    },
    instanceCount: 1,
  };

  it('shows the Image section with Replace for a resolved image src', () => {
    render(
      <VisualEditorPanel
        {...mk()}
        selection={imgSelection}
        currentClass=""
        imageResolution={{
          status: 'resolved',
          file: 'app/page.tsx',
          line: 3,
          column: 11,
          src: '/hero.png',
          confidence: 'src',
        }}
      />
    );
    expect(screen.getByText('Image')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Replace image/ })).toBeInTheDocument();
    expect(screen.getByText('/hero.png')).toBeInTheDocument();
    // …and that class verdict is expected for a classless image, so the generic
    // read-only banner is suppressed (the Image section carries the state).
    expect(screen.queryByText(/aren’t a static string/)).not.toBeInTheDocument();
  });

  it('shows the reason instead of Replace when the image src is dynamic', () => {
    render(
      <VisualEditorPanel
        {...mk()}
        selection={imgSelection}
        currentClass=""
        imageResolution={{ status: 'read_only', reason: 'This image’s source is set in code.' }}
      />
    );
    expect(screen.getByText('This image’s source is set in code.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replace image/ })).not.toBeInTheDocument();
  });

  it('keeps the class read-only banner for an image that HAS classes', () => {
    render(
      <VisualEditorPanel
        {...mk()}
        selection={{
          ...imgSelection,
          signature: { ...imgSelection.signature, className: 'h-12 w-auto' },
        }}
        currentClass="h-12 w-auto"
        imageResolution={{ status: 'read_only', reason: 'This image’s source is set in code.' }}
      />
    );
    // Styles genuinely aren't editable here — that's worth surfacing alongside Image.
    expect(screen.getByText(/aren’t a static string/)).toBeInTheDocument();
    expect(screen.getByText('Image')).toBeInTheDocument();
  });
});
