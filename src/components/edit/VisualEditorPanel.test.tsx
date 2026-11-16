import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { VisualEditorPanel } from './VisualEditorPanel';
import { DockablePanel } from '../primitives/DockablePanel';
import { useImageSourceResolution } from '../../hooks/useImageSourceEditing';
import type { ElementSettings } from '../../hooks/useElementSettings';
import {
  BASE_BREAKPOINT,
  DEFAULT_BREAKPOINTS,
  type ResetSpec,
  type Breakpoint,
  type UsageReport,
} from '../../lib/edit';
import type { Selection } from '../../hooks/useVisualEditor';
import type { ValueFieldVariable } from '../primitives/ValueField';

vi.mock('../../hooks/useImageSourceEditing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useImageSourceEditing')>();
  return { ...actual, useImageSourceResolution: vi.fn() };
});

const BREAKPOINTS: Breakpoint[] = [BASE_BREAKPOINT, ...DEFAULT_BREAKPOINTS];
const MD = BREAKPOINTS.find((b) => b.name === 'md')!;

const resolvedImageSource = {
  status: 'resolved' as const,
  file: 'components/Hero.tsx',
  line: 12,
  column: 4,
  src: '/hero.png',
  confidence: 'src',
};

function imageElementSettings(overrides: Partial<ElementSettings> = {}): ElementSettings {
  return {
    selectionKey: 'image-selection',
    tag: 'img',
    tagOptions: [{ tag: 'img', label: 'Image' }],
    canEditTag: false,
    setTag: vi.fn().mockResolvedValue(true),
    classes: ['hero'],
    attributes: [
      { name: 'src', value: '/hero.png' },
      { name: 'alt', value: 'Hero' },
      { name: 'width', value: '320' },
      { name: 'height', value: '180' },
    ],
    text: '',
    textReason: null,
    canEditText: false,
    setText: vi.fn().mockResolvedValue(true),
    addClass: vi.fn(),
    renameClass: vi.fn(),
    removeClass: vi.fn(),
    setAttribute: vi.fn().mockResolvedValue(true),
    renameAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    canEditAttributes: true,
    sourceMarkupStatus: 'resolved',
    imageAttributeEditBlockReason: null,
    location: { file: 'components/Hero.tsx', line: 12 },
    busy: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(useImageSourceResolution).mockReturnValue({
    resolution: resolvedImageSource,
    setResolution: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  onReset = vi.fn(),
  editTarget: import('../../hooks/useVisualEditor').EditTarget = { kind: 'element' },
  onSetPositionSide = vi.fn(),
  variables: ValueFieldVariable[] = []
) {
  return render(
    <VisualEditorPanel
      selection={selection}
      projectPath="/Users/test/ShipStudio/demo"
      onReplaceImage={vi.fn(async () => {})}
      currentClass={currentClass}
      variables={variables}
      breakpoints={BREAKPOINTS}
      activeBreakpoint={activeBreakpoint}
      breakpointTooWide={breakpointTooWide}
      onSelectBreakpoint={onSelectBreakpoint}
      autoSave={autoSave}
      onToggleAutoSave={onToggleAutoSave}
      onStepGap={vi.fn()}
      onSetSide={onSetSide}
      onSetPositionSide={onSetPositionSide}
      onApplyEnum={onApplyEnum}
      onReset={onReset}
      multiTarget="all"
      onMultiTargetChange={vi.fn()}
      editTarget={editTarget}
      customClasses={[]}
      onEditElement={vi.fn()}
      onEditClass={vi.fn()}
      onApplyClass={vi.fn()}
      onUnapplyClass={vi.fn()}
      onCreateClass={vi.fn()}
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
    expect(document.querySelectorAll('.ss-box__band')).toHaveLength(8);
    expect(screen.getByLabelText('Padding top')).toBeInTheDocument();
    expect(screen.getByLabelText('Margin left')).toBeInTheDocument();
    // Gap stepper + enum controls
    expect(screen.getByText('Gap')).toBeInTheDocument();
    expect(screen.getByText('Align')).toBeInTheDocument();
    expect(screen.getByText('Font')).toBeInTheDocument();
    expect(screen.getByText('Weight')).toBeInTheDocument();
    // Align renders icon buttons ("Left" is unique to Align)
    expect(screen.getByRole('button', { name: 'Left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Uppercase' })).toHaveAttribute('title', 'Uppercase');
    // New properties
    expect(screen.getByText('Opacity')).toBeInTheDocument();
    // Color controls render as swatch buttons that open the picker popover
    expect(screen.getByRole('button', { name: 'Text color' })).toBeInTheDocument();
    // Save button
    expect(screen.getByText('Saved')).toBeInTheDocument();
    const classesSection = document.querySelector<HTMLElement>('.ss-edit-panel__section--classes');
    expect(classesSection).not.toBeNull();
    expect(classesSection).toHaveTextContent('Applied classes');
    expect(classesSection).toHaveAttribute('open');
    expect(classesSection).toHaveTextContent('p-3');

    const customSection = document.querySelector<HTMLElement>('.ss-edit-panel__section--custom');
    expect(customSection).toHaveAttribute('open');
  });

  it('groups Position and Z-index under their own section', () => {
    renderPanel(resolvedSelection);

    const positionSection = document.querySelector<HTMLElement>(
      '.ss-edit-panel__section--position'
    );
    const layoutSection = document.querySelector<HTMLElement>('.ss-edit-panel__section--layout');

    expect(positionSection).not.toBeNull();
    expect(layoutSection).not.toBeNull();
    expect(positionSection).toHaveAttribute('open');
    expect(layoutSection).toHaveAttribute('open');
    expect(positionSection).toHaveTextContent('Position');
    expect(positionSection).toHaveTextContent('Z-index');
    expect(layoutSection).not.toHaveTextContent('Position');
    expect(layoutSection).not.toHaveTextContent('Z-index');
  });

  it('renders the four-sided offset box for a positioned element', () => {
    const selection: Selection = {
      signature: { className: 'relative top-4 inset-x-2', tagName: 'div', ancestorClasses: [] },
      resolution: {
        status: 'resolved',
        file: 'components/Hero.tsx',
        line: 11,
        column: 1,
        class_name: 'relative top-4 inset-x-2',
        confidence: 'unique',
      },
      instanceCount: 1,
    };

    renderPanel(selection, 'relative top-4 inset-x-2');

    const box = screen.getByTestId('position-box');
    expect(box.querySelectorAll('.ss-box__band')).toHaveLength(4);
    expect(within(box).getByRole('button', { name: 'Top' })).toHaveTextContent('4');
    expect(within(box).getByRole('button', { name: 'Bottom' })).toHaveTextContent('Auto');
    expect(within(box).getByRole('button', { name: 'Left' })).toHaveTextContent('2');
    expect(within(box).getByRole('button', { name: 'Right' })).toHaveTextContent('2');
  });

  it('keeps the offset box hidden while Position is Static', () => {
    renderPanel(resolvedSelection, 'static p-3');
    expect(screen.queryByTestId('position-box')).not.toBeInTheDocument();
  });

  it('commits a manually entered position offset from the popup', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const onSetPositionSide = vi.fn();
    const selection: Selection = {
      signature: { className: 'relative', tagName: 'div', ancestorClasses: [] },
      resolution: {
        status: 'resolved',
        file: 'components/Hero.tsx',
        line: 11,
        column: 1,
        class_name: 'relative',
        confidence: 'unique',
      },
      instanceCount: 1,
    };

    renderPanel(
      selection,
      'relative',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { kind: 'element' },
      onSetPositionSide
    );
    fireEvent.click(screen.getByRole('button', { name: 'Top' }));

    const input = within(screen.getByRole('dialog', { name: 'Top' })).getByRole('textbox', {
      name: 'Top',
    });
    expect(input).toHaveValue('auto');
    fireEvent.change(input, { target: { value: '10rem' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSetPositionSide).toHaveBeenLastCalledWith('top', {
      kind: 'arbitrary',
      raw: '10rem',
    });
    vi.unstubAllGlobals();
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

  it('settles to "Saved" for a class edit once the @apply bag matches its baseline', () => {
    // Regression: dirty used to compare the class's @apply tokens (currentClass)
    // to the ELEMENT's className (resolution.class_name) — never equal — pinning
    // "Saving…" on forever for every class edit.
    const classTarget = {
      kind: 'class' as const,
      name: 'tall-lh',
      baseline: 'text-[var(--muted)]  mb-10', // extra space — must still read clean
    };
    renderPanel(
      resolvedSelection,
      'text-[var(--muted)] mb-10', // live @apply bag, normalized — matches baseline
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      true, // auto-save on
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      classTarget
    );
    expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
  });

  it('shows "Saving…" for a class edit whose @apply bag diverges from its baseline', () => {
    const classTarget = { kind: 'class' as const, name: 'tall-lh', baseline: 'mb-10' };
    renderPanel(
      resolvedSelection,
      'mb-10 mt-5', // edited — diverges from baseline
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      true,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      classTarget
    );
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  it('renders the breakpoint dropdown showing the active breakpoint', () => {
    renderPanel(resolvedSelection, 'p-3', MD);
    const trigger = screen.getByRole('button', { name: 'Breakpoint' });
    expect(trigger).toHaveTextContent('md · ≥768px');
  });

  it('lists breakpoints from largest to smallest with their device icons', () => {
    renderPanel(resolvedSelection, 'p-3', BASE_BREAKPOINT);
    fireEvent.click(screen.getByRole('button', { name: 'Breakpoint' }));
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '2xl · ≥1536px',
      'xl · ≥1280px',
      'lg · ≥1024px',
      'md · ≥768px',
      'sm · ≥640px',
      'Base',
    ]);
    expect(options.every((option) => option.querySelector('svg'))).toBe(true);
  });

  it('renders typography dimensions as editable value fields', () => {
    renderPanel(resolvedSelection, 'text-xl leading-tight tracking-wide');
    expect(screen.getByRole('textbox', { name: 'Size' })).toHaveValue('1.25');
    expect(screen.getByRole('button', { name: 'Size format' })).toHaveTextContent('REM');
    expect(screen.getByRole('textbox', { name: 'Line height' })).toHaveValue('1.25');
    expect(screen.getByRole('textbox', { name: 'Letter spacing' })).toHaveValue('0.025');
    expect(screen.getByRole('button', { name: 'Letter spacing format' })).toHaveTextContent('EM');
  });

  it('splits unit-bearing typography defaults between the placeholder and format trigger', () => {
    renderPanel(resolvedSelection);

    expect(screen.getByRole('textbox', { name: 'Size' })).toHaveAttribute('placeholder', '1');
    expect(screen.getByRole('button', { name: 'Size format' })).toHaveTextContent('REM');
    expect(screen.getByRole('textbox', { name: 'Letter spacing' })).toHaveAttribute(
      'placeholder',
      '0'
    );
    expect(screen.getByRole('button', { name: 'Letter spacing format' })).toHaveTextContent('EM');
  });

  it('surfaces an active overflowed Display value and moves None into the menu', () => {
    renderPanel(resolvedSelection, 'inline-flex');

    expect(screen.getByRole('button', { name: 'Inline flex' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Display' })).queryByRole('button', {
        name: 'None',
      })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More display options' }));
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Inline block' })).toBeInTheDocument();
  });

  it('explains the mobile-first cascade contextually for the active breakpoint', () => {
    renderPanel(resolvedSelection, 'p-3', BASE_BREAKPOINT);
    expect(screen.getByRole('img', { name: /apply to every screen size/i })).toHaveAttribute(
      'data-tooltip-content',
      expect.stringMatching(/apply to every screen size/i)
    );
    renderPanel(resolvedSelection, 'p-3', MD);
    expect(screen.getByRole('img', { name: /from 768px wide and up/i })).toHaveAttribute(
      'data-tooltip-content',
      expect.stringMatching(/from 768px wide and up/i)
    );
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

  it('opens the full property editor for an arbitrary box value', () => {
    renderPanel(resolvedSelection, 'pt-[10rem]');
    fireEvent.click(screen.getByRole('button', { name: 'Padding top' }));

    const popover = screen.getByRole('dialog', { name: 'Padding Top' });
    expect(popover).toHaveTextContent('Padding Top');
    expect(within(popover).getByRole('textbox', { name: 'Padding Top' })).toHaveValue('10');
    expect(within(popover).getByRole('button', { name: 'Padding Top format' })).toHaveTextContent(
      'REM'
    );
    expect(within(popover).getByRole('textbox', { name: 'Padding Top' })).toHaveFocus();
  });

  it('opens the variable picker from a box-model value field after typing --', () => {
    const variables = [{ name: '--margin-gutter', value: '24px' }];
    renderPanel(
      resolvedSelection,
      'p-3',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { kind: 'element' },
      vi.fn(),
      variables
    );

    fireEvent.click(screen.getByRole('button', { name: 'Margin left' }));
    const input = within(screen.getByRole('dialog', { name: 'Margin Left' })).getByRole(
      'combobox',
      { name: 'Margin Left' }
    );
    fireEvent.change(input, { target: { value: '--' } });

    expect(screen.getByRole('listbox', { name: 'Margin Left variables' })).toHaveTextContent(
      '--margin-gutter'
    );
  });

  it('uses the variable presentation for compact box-model values', () => {
    renderPanel(
      resolvedSelection,
      'm-(--margin-gutter)',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { kind: 'element' },
      vi.fn(),
      [{ name: '--margin-gutter', value: '24px' }]
    );

    const field = screen.getByRole('button', { name: 'Margin left' });
    expect(field).toHaveClass('ss-box__field--variable');
    expect(field).not.toHaveClass('ss-box__field--modified');
    expect(field).toHaveTextContent('--margin-gutter');
  });

  it('styles box-model value triggers by cascade state', () => {
    renderPanel(resolvedSelection, 'p-3 md:pt-6', MD);
    const modified = screen.getByRole('button', { name: 'Padding top' });
    const inherited = screen.getByRole('button', { name: 'Padding right' });

    expect(modified).toHaveClass('ss-box__field--modified');
    expect(inherited).toHaveClass('ss-box__field--inherited');
    expect(modified).toHaveTextContent('6');
    expect(inherited).toHaveTextContent('3');
  });

  it('Alt-clicking a modified spacing value resets its box utility', () => {
    const onReset = vi.fn<(spec: ResetSpec) => void>();
    renderPanel(
      resolvedSelection,
      'p-3 md:pt-6',
      MD,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      onReset
    );

    fireEvent.click(screen.getByRole('button', { name: 'Padding top' }), { altKey: true });

    expect(onReset).toHaveBeenCalledTimes(1);
    const spec = onReset.mock.calls[0][0];
    expect(spec.match('pt-6')).toBe(true);
    expect(spec.match('py-6')).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Alt-clicking a modified position value resets its offset utility', () => {
    const onReset = vi.fn<(spec: ResetSpec) => void>();
    const selection: Selection = {
      signature: { className: 'relative top-4 inset-x-2', tagName: 'div', ancestorClasses: [] },
      resolution: {
        status: 'resolved',
        file: 'components/Hero.tsx',
        line: 11,
        column: 1,
        class_name: 'relative top-4 inset-x-2',
        confidence: 'unique',
      },
      instanceCount: 1,
    };

    renderPanel(
      selection,
      'relative top-4 inset-x-2',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      onReset
    );
    fireEvent.click(screen.getByTestId('position-box').querySelector('[aria-label="Top"]')!, {
      altKey: true,
    });

    expect(onReset).toHaveBeenCalledTimes(1);
    const spec = onReset.mock.calls[0][0];
    expect(spec.match('top-4')).toBe(true);
    expect(spec.match('inset-y-4')).toBe(true);
    expect(spec.match('inset-x-2')).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a box-model value from its full grabbable panel', () => {
    renderPanel(resolvedSelection, 'p-3');
    const box = screen.getByTestId('spacing-box');
    const marginTopPanel = box.querySelector<HTMLElement>('.ss-box__margin .ss-box__band--top');

    expect(marginTopPanel).not.toBeNull();
    fireEvent.click(marginTopPanel!);
    const popover = screen.getByRole('dialog', { name: 'Margin Top' });
    expect(within(popover).getByRole('textbox', { name: 'Margin Top' })).toHaveFocus();
  });

  it('sizes the popup from the box and places bottom values below it', () => {
    renderPanel(resolvedSelection, 'p-3');
    const box = screen.getByTestId('spacing-box');
    const boxRect = {
      top: 100,
      right: 300,
      bottom: 212,
      left: 100,
      width: 200,
      height: 112,
    } as DOMRect;
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(boxRect);

    fireEvent.click(screen.getByRole('button', { name: 'Padding bottom' }));

    const popover = screen.getByRole('dialog', { name: 'Padding Bottom' });
    const popupTop = Number.parseFloat(popover.style.top);
    const popupWidth = Number.parseFloat(popover.style.width);
    const popupHeight = Number.parseFloat(popover.style.height);

    expect(popupTop).toBeGreaterThanOrEqual(boxRect.bottom);
    expect(popupTop).toBeCloseTo(boxRect.bottom + 8);
    expect(popupWidth).toBeCloseTo(boxRect.width * 0.78);
    expect(popupHeight).toBeCloseTo(boxRect.height * 0.37);

    vi.restoreAllMocks();
  });

  it('commits a manually entered spacing value from the popup', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const onSetSide = vi.fn();
    renderPanel(
      resolvedSelection,
      'p-3',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      onSetSide
    );

    fireEvent.click(screen.getByRole('button', { name: 'Padding top' }));
    const input = within(screen.getByRole('dialog', { name: 'Padding Top' })).getByRole('textbox', {
      name: 'Padding Top',
    });
    fireEvent.change(input, { target: { value: '10rem' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', {
      kind: 'arbitrary',
      raw: '10rem',
    });
    vi.unstubAllGlobals();
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
    expect(document.querySelector('.ss-reset-pop')).not.toBeInTheDocument();
    fireEvent.click(document.querySelector('.ss-edit-panel__labelbtn')!); // click the name
    const resetButton = document.querySelector('.ss-reset-pop');
    expect(resetButton).toBeInTheDocument();
    fireEvent.click(resetButton!); // confirm
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

  it('keeps the background layer popover above its raised floating panel', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('PointerEvent', MouseEvent);
    const backgroundSelection: Selection = {
      ...resolvedSelection,
      signature: {
        ...resolvedSelection.signature,
        className: 'bg-[image:url(/one.png)]',
        computedBackgroundImage: 'url(/one.png)',
      },
    };
    function StatefulPanel({ selectionKey }: { selectionKey: string }) {
      const [currentClass, setCurrentClass] = useState('bg-[image:url(/one.png)]');
      const [revision, setRevision] = useState(0);
      const selection: Selection = {
        ...backgroundSelection,
        signature: {
          ...backgroundSelection.signature,
          domPath: selectionKey,
          computedBackgroundSize: revision > 0 ? 'cover' : 'auto',
        },
      };
      return (
        <VisualEditorPanel
          {...mk()}
          selection={selection}
          currentClass={currentClass}
          onApplyEnum={(token) => {
            setCurrentClass((value) => `${value} ${token}`);
            setRevision((value) => value + 1);
          }}
        />
      );
    }
    const { rerender } = render(
      <DockablePanel
        docked={false}
        ariaLabel="Edit panel"
        positionKey="testEditPanelPosition"
        sizeKey="testEditPanelSize"
        floatingSize={{ width: 300, height: 600 }}
        initialPosition={() => ({ left: 10, top: 10 })}
        resizable={false}
      >
        <StatefulPanel selectionKey="one-element" />
      </DockablePanel>
    );

    const backgrounds = document.querySelector<HTMLElement>('.ss-edit-panel__section--backgrounds');
    expect(backgrounds).not.toHaveAttribute('open');
    fireEvent.click(backgrounds?.querySelector('summary') as HTMLElement);
    expect(backgrounds).toHaveAttribute('open');

    const layer = screen.getByRole('button', { name: 'Edit one.png layer 1' });
    fireEvent.pointerDown(layer, { pointerId: 22 });
    const surface = screen.getByLabelText('Edit panel');
    expect(surface.style.zIndex).toMatch(/^calc\(var\(--z-floating-panel\) \+ [1-9]/);

    fireEvent.click(layer);
    const popover = screen.getByRole('dialog', { name: 'Image settings' });
    expect(popover.parentElement).toBe(document.body);
    expect(popover).toHaveClass('ss-background-layer-popover');

    const editPanel = document.querySelector('.ss-edit-panel');
    const panelScrim = editPanel?.querySelector('[data-testid="background-layer-panel-scrim"]');
    expect(panelScrim).toBeInTheDocument();
    expect(panelScrim?.parentElement).toBe(editPanel);

    act(() => {
      fireEvent.click(within(popover).getByRole('button', { name: 'Cover' }));
    });
    expect(screen.getByRole('dialog', { name: 'Image settings' })).toBeInTheDocument();

    // The real panel context recomputes its selection and computed-settings
    // objects as the live class changes. Selection identity remains stable, so
    // the selected row and its editor survive the rerender.
    const sameTargetRow = screen.getByRole('button', { name: 'Edit one.png layer 1' });
    expect(sameTargetRow).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <DockablePanel
        docked={false}
        ariaLabel="Edit panel"
        positionKey="testEditPanelPosition"
        sizeKey="testEditPanelSize"
        floatingSize={{ width: 300, height: 600 }}
        initialPosition={() => ({ left: 10, top: 10 })}
        resizable={false}
      >
        <StatefulPanel selectionKey="another-element" />
      </DockablePanel>
    );
    expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-testid="background-layer-panel-scrim"]')
    ).not.toBeInTheDocument();
  });

  it('dims only the Edit panel while the layer popover is open and clears on Escape or outside click', async () => {
    renderPanel(resolvedSelection, 'bg-[image:url(/one.png)]');
    const backgrounds = document.querySelector<HTMLElement>('.ss-edit-panel__section--backgrounds');
    fireEvent.click(backgrounds?.querySelector('summary') as HTMLElement);
    const layer = screen.getByRole('button', { name: 'Edit one.png layer 1' });
    fireEvent.click(layer);

    const editPanel = document.querySelector('.ss-edit-panel');
    expect(
      editPanel?.querySelector('[data-testid="background-layer-panel-scrim"]')
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Image settings' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
    expect(
      editPanel?.querySelector('[data-testid="background-layer-panel-scrim"]')
    ).not.toBeInTheDocument();

    fireEvent.click(layer);
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        })
    );
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Image settings' })).not.toBeInTheDocument();
    expect(
      editPanel?.querySelector('[data-testid="background-layer-panel-scrim"]')
    ).not.toBeInTheDocument();
  });

  it('keeps layer rows as the shared hover surface and disables active scaling only there', () => {
    const imageStyles = readFileSync(
      resolve('src/styles/features/visual-editor-image.css'),
      'utf8'
    );
    expect(imageStyles).toMatch(
      /\.ss-background-image-control__row:hover,\s*\.ss-background-image-control__row--selected\s*\{[^}]*background-color:\s*var\(--surface-control-hover\)/
    );
    expect(imageStyles).toMatch(
      /\.ss-background-image-control__row > \.button:active:not\(:disabled\)\s*\{\s*transform:\s*none;/
    );
    expect(imageStyles).toMatch(
      /\.ss-background-image-control__row > \.button--icon-only:hover:not\(:disabled\)\s*\{[^}]*background-color:\s*transparent/
    );
  });

  it('keeps the background popover controls compact and aligned at narrow panel widths', () => {
    const imageStyles = readFileSync(
      resolve('src/styles/features/visual-editor-image.css'),
      'utf8'
    );
    const panelStyles = readFileSync(
      resolve('src/styles/features/visual-editor/panel.css'),
      'utf8'
    );
    const typeRule =
      imageStyles.match(
        /\.ss-background-layer-popover__type-options > \.button\s*\{([^}]*)\}/
      )?.[1] ?? '';
    const colorRule =
      imageStyles.match(/\.ss-background-layer-popover__color-property\s*\{([^}]*)\}/)?.[1] ?? '';
    const swatchRule =
      imageStyles.match(/\.ss-background-layer-popover__color-swatch\s*\{([^}]*)\}/)?.[1] ?? '';
    const tileRule =
      imageStyles.match(/\.ss-background-layer-popover__repeat-presets\s*\{([^}]*)\}/)?.[1] ?? '';
    const scrimRule =
      imageStyles.match(/\.ss-background-image-control__panel-scrim\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(typeRule).toMatch(/height:\s*var\(--size-control-medium\)/);
    expect(imageStyles).toMatch(
      /grid-template-columns:\s*minmax\(calc\(var\(--spacing-2xl\) \* 2\), 0\.8fr\) minmax\(0, 2\.5fr\)/
    );
    expect(colorRule).toMatch(/height:\s*var\(--size-control-medium\)/);
    expect(colorRule).toMatch(/background:\s*var\(--surface-panel\)/);
    expect(swatchRule).toMatch(/width:\s*var\(--spacing-lg\)/);
    expect(tileRule).toMatch(/min-width:\s*0/);
    expect(panelStyles).toMatch(/\.ss-edit-panel__align-tabs > \.button\s*\{[^}]*flex:\s*1 1 0/);
    expect(imageStyles).toMatch(/\.ss-background-layer-popover__solid-icon\s*\{/);
    expect(scrimRule).toMatch(/position:\s*absolute/);
    expect(scrimRule).toMatch(/background:\s*var\(--overlay-30\)/);
  });

  it('reserves a z-index tier above raised panels and below modal overlays', () => {
    const tokens = readFileSync(resolve('src/styles/global/tokens-components.css'), 'utf8');
    const imageStyles = readFileSync(
      resolve('src/styles/features/visual-editor-image.css'),
      'utf8'
    );
    const panelSource = readFileSync(
      resolve('src/components/primitives/DockablePanel.tsx'),
      'utf8'
    );
    const popoverRule = imageStyles.match(/\.ss-background-layer-popover\s*\{([^}]*)\}/)?.[1] ?? '';
    const floatingZ = Number(tokens.match(/--z-floating-panel:\s*(\d+)/)?.[1]);
    const popoverOffset = Number(
      tokens.match(/--z-floating-panel-popover:\s*calc\(var\(--z-floating-panel\) \+ (\d+)\)/)?.[1]
    );
    const modalZ = Number(tokens.match(/--z-modal-overlay:\s*(\d+)/)?.[1]);
    const maxPanelOrder = Number(panelSource.match(/MAX_FLOATING_PANEL_STACK_ORDER = (\d+)/)?.[1]);

    expect(Number.isFinite(floatingZ + popoverOffset + modalZ + maxPanelOrder)).toBe(true);
    expect(popoverRule).toMatch(/z-index:\s*var\(--z-floating-panel-popover\)/);
    expect(floatingZ + maxPanelOrder).toBeLessThan(floatingZ + popoverOffset);
    expect(floatingZ + popoverOffset).toBeLessThan(modalZ);
  });

  it('uses the requested concise labels for the background image and colour controls', () => {
    renderPanel(resolvedSelection, 'bg-[image:url(/one.png)] bg-[#123456]');
    const backgrounds = document.querySelector<HTMLElement>('.ss-edit-panel__section--backgrounds');
    fireEvent.click(backgrounds?.querySelector('summary') as HTMLElement);

    expect(screen.getByText('Image, gradient, or color')).toBeInTheDocument();
    expect(screen.getByText('Color')).toBeInTheDocument();
    expect(screen.queryByText('Background')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Gap' })).not.toBeInTheDocument();
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

  // ── Arrow-key stepping (ArrowUp/Down; Shift ×10, Alt fine) ──

  it('steps a padding side with ArrowUp/ArrowDown (Shift ×10)', () => {
    const onSetSide = vi.fn();
    renderPanel(
      resolvedSelection,
      'p-3',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      onSetSide
    );
    fireEvent.click(screen.getByRole('button', { name: 'Padding top' }));
    const pt = within(screen.getByRole('dialog', { name: 'Padding Top' })).getByRole('textbox', {
      name: 'Padding Top',
    });
    fireEvent.keyDown(pt, { key: 'ArrowUp' });
    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', { kind: 'scale', n: 4 });
    fireEvent.keyDown(pt, { key: 'ArrowDown' });
    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', { kind: 'scale', n: 2 });
    fireEvent.keyDown(pt, { key: 'ArrowUp', shiftKey: true });
    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', { kind: 'scale', n: 13 });
  });

  it('clamps arrow-key stepping at zero for the spacing scale', () => {
    const onSetSide = vi.fn();
    renderPanel(
      resolvedSelection,
      'p-0',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      onSetSide
    );
    fireEvent.click(screen.getByRole('button', { name: 'Padding top' }));
    fireEvent.keyDown(
      within(screen.getByRole('dialog', { name: 'Padding Top' })).getByRole('textbox', {
        name: 'Padding Top',
      }),
      { key: 'ArrowDown' }
    );
    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', { kind: 'scale', n: 0 });
  });

  it('steps an arbitrary spacing value preserving its unit (Alt = fine step)', () => {
    const onSetSide = vi.fn();
    renderPanel(
      resolvedSelection,
      'pt-[10rem]',
      BASE_BREAKPOINT,
      vi.fn(),
      false,
      false,
      vi.fn(),
      vi.fn(),
      onSetSide
    );
    fireEvent.click(screen.getByRole('button', { name: 'Padding top' }));
    const pt = within(screen.getByRole('dialog', { name: 'Padding Top' })).getByRole('textbox', {
      name: 'Padding Top',
    });
    fireEvent.keyDown(pt, { key: 'ArrowUp' });
    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', {
      kind: 'arbitrary',
      raw: '11rem',
    });
    fireEvent.keyDown(pt, { key: 'ArrowUp', altKey: true });
    expect(onSetSide).toHaveBeenLastCalledWith('padding', 'top', {
      kind: 'arbitrary',
      raw: '10.1rem',
    });
  });

  it('steps the gap with arrow keys through the same stepper as the −/＋ buttons', () => {
    const onStepGap = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="gap-4"
        onStepGap={onStepGap}
      />
    );
    const gap = screen.getByLabelText('Gap');
    fireEvent.keyDown(gap, { key: 'ArrowUp' });
    expect(onStepGap).toHaveBeenLastCalledWith(1, 1);
    fireEvent.keyDown(gap, { key: 'ArrowDown' });
    expect(onStepGap).toHaveBeenLastCalledWith(-1, 1);
    fireEvent.keyDown(gap, { key: 'ArrowUp', shiftKey: true });
    expect(onStepGap).toHaveBeenLastCalledWith(1, 10);
  });

  it('steps a scale length (width) with arrow keys', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="w-64"
        onApplyEnum={onApplyEnum}
      />
    );
    fireEvent.keyDown(screen.getByLabelText('Width'), { key: 'ArrowUp' });
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-65', { width: '16.25rem' });
  });

  it('steps an arbitrary length preserving its unit', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="w-[480px]"
        onApplyEnum={onApplyEnum}
      />
    );
    const width = screen.getByLabelText('Width');
    fireEvent.keyDown(width, { key: 'ArrowUp' });
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-[481px]', { width: '481px' });
    fireEvent.keyDown(width, { key: 'ArrowUp', shiftKey: true });
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-[491px]', { width: '491px' });
    vi.unstubAllGlobals();
  });

  it('leaves keyword lengths alone on arrow keys', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="w-full"
        onApplyEnum={onApplyEnum}
      />
    );
    const width = screen.getByLabelText<HTMLInputElement>('Width');
    fireEvent.keyDown(width, { key: 'ArrowUp' });
    expect(onApplyEnum).not.toHaveBeenCalled();
    expect(width.value).toBe('full');
  });

  // ── Length value and format controls ──

  it('offers property-specific keywords in the format menu', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass=""
        onApplyEnum={onApplyEnum}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Width format' }));

    expect(screen.getByRole('listbox', { name: 'Width formats' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'AUTO' }));

    expect(onApplyEnum).toHaveBeenCalledWith('w-auto', { width: 'auto' });
  });

  it('accepts a Tailwind sizing keyword typed directly', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass=""
        onApplyEnum={onApplyEnum}
      />
    );
    const width = screen.getByLabelText<HTMLInputElement>('Width');
    fireEvent.change(width, { target: { value: 'full' } });
    fireEvent.keyDown(width, { key: 'Enter' });

    expect(onApplyEnum).toHaveBeenCalledWith('w-full', { width: '100%' });
  });

  it('applies a typed fraction as a fraction token, ignoring the active unit', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="w-[480px]"
        onApplyEnum={onApplyEnum}
      />
    );
    const width = screen.getByLabelText<HTMLInputElement>('Width');
    fireEvent.change(width, { target: { value: '1/2' } });
    fireEvent.keyDown(width, { key: 'Enter' });

    // `1/2` is a complete value: it must not pick up the field's `px` unit.
    expect(onApplyEnum).toHaveBeenCalledWith('w-1/2', { width: '50%' });
    vi.unstubAllGlobals();
  });

  it('offers the sizing presets (full, fractions) in the format menu', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass=""
        onApplyEnum={onApplyEnum}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Width format' }));
    fireEvent.click(screen.getByRole('option', { name: 'FULL' }));
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-full', { width: '100%' });

    fireEvent.click(screen.getByRole('button', { name: 'Width format' }));
    fireEvent.click(screen.getByRole('option', { name: '1/2' }));
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-1/2', { width: '50%' });
  });

  it('clamps arrow-key stepping of a length at zero', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="w-[0px]"
        onApplyEnum={onApplyEnum}
      />
    );
    fireEvent.keyDown(screen.getByLabelText('Width'), { key: 'ArrowDown' });
    expect(onApplyEnum).not.toHaveBeenCalledWith('w-[-1px]', expect.anything());
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-[0px]', { width: '0px' });
    vi.unstubAllGlobals();
  });

  // ── Opacity ──

  it('writes an off-scale opacity as an arbitrary value Tailwind can generate', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass=""
        onApplyEnum={onApplyEnum}
      />
    );
    const opacity = screen.getByLabelText<HTMLInputElement>('Opacity value');
    fireEvent.change(opacity, { target: { value: '37.5' } });
    fireEvent.keyDown(opacity, { key: 'Enter' });
    // `opacity-37.5` is never generated — the style would vanish on save.
    expect(onApplyEnum).toHaveBeenCalledWith('opacity-[0.375]', { opacity: '0.375' });

    fireEvent.change(opacity, { target: { value: '40' } });
    fireEvent.keyDown(opacity, { key: 'Enter' });
    expect(onApplyEnum).toHaveBeenLastCalledWith('opacity-40', { opacity: '0.4' });
  });

  it('reads an arbitrary opacity value back into the control', () => {
    render(
      <VisualEditorPanel {...mk()} selection={resolvedSelection} currentClass="opacity-[0.375]" />
    );
    expect(screen.getByLabelText<HTMLInputElement>('Opacity value').value).toBe('37.5');
    expect(screen.getByLabelText<HTMLInputElement>('Opacity').value).toBe('37.5');
  });

  it('suppresses the preset menu on numeric text so arrows keep stepping', () => {
    const onApplyEnum = vi.fn();
    render(
      <VisualEditorPanel
        {...mk()}
        selection={resolvedSelection}
        currentClass="w-64"
        onApplyEnum={onApplyEnum}
      />
    );
    const width = screen.getByLabelText<HTMLInputElement>('Width');
    fireEvent.focus(width);

    // Numeric value: no menu, arrows step the number instead of navigating.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(width, { key: 'ArrowUp' });
    expect(onApplyEnum).toHaveBeenLastCalledWith('w-65', { width: '16.25rem' });
  });

  // ── Element / Settings tabs ──

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

  it('keeps Settings available for a classless image and uses one shared image settings section', () => {
    const settings = imageElementSettings();
    const { container } = render(
      <VisualEditorPanel
        {...mk()}
        selection={imgSelection}
        currentClass=""
        imageSettings={settings}
      />
    );

    expect(screen.getByRole('tab', { name: 'Element' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeEnabled();
    expect(screen.queryByText('Image settings')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(screen.getByText('Tag')).toBeInTheDocument();
    expect(screen.getByText('Attributes')).toBeInTheDocument();
    expect(screen.getByText('Image Settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace image…' })).toBeInTheDocument();
    expect(screen.getAllByText('Image Settings')).toHaveLength(1);
    expect(container.querySelector('.ss-edit-image')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('/hero.png');
    // A classless image has no style controls, but markup settings remain available.
    expect(screen.queryByText(/aren’t a static string/)).not.toBeInTheDocument();
  });

  it('shows the shared image source guard for a dynamic image src', () => {
    vi.mocked(useImageSourceResolution).mockReturnValueOnce({
      resolution: { status: 'read_only', reason: 'This image’s source is set in code.' },
      setResolution: vi.fn(),
    });
    render(
      <VisualEditorPanel
        {...mk()}
        selection={imgSelection}
        currentClass=""
        imageSettings={imageElementSettings({
          attributes: [{ name: 'src', value: '{heroImage}', isExpression: true }],
        })}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Replace image…' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'URL' })).toBeDisabled();
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
        imageSettings={imageElementSettings()}
        imageResolution={{ status: 'read_only', reason: 'This image’s source is set in code.' }}
      />
    );
    // Styles genuinely aren't editable here — that's worth surfacing alongside Image.
    expect(screen.getByText(/aren’t a static string/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByText('Image Settings')).toBeInTheDocument();
  });

  it.each([
    ['tw-', 'tw-w-64 tw-h-40'],
    ['tw-', '!tw-w-64 !tw-h-40 hover:!tw-w-full'],
    ['tw:', 'tw:w-64! tw:h-40! tw:hover:w-full'],
  ])(
    'reads and writes image dimensions through %s utilities: %s',
    (utilityPrefix, currentClass) => {
      vi.stubGlobal('CSS', { supports: () => true });
      const onApplyEnum = vi.fn();
      const resetSpecs: ResetSpec[] = [];
      const settings = imageElementSettings();
      const selection: Selection = {
        signature: {
          ...imgSelection.signature,
          className: 'w-64 h-40',
        },
        resolution: {
          status: 'resolved',
          file: 'components/Hero.tsx',
          line: 12,
          column: 4,
          class_name: 'w-64 h-40',
          confidence: 'unique',
        },
        instanceCount: 1,
      };
      render(
        <VisualEditorPanel
          {...mk()}
          selection={selection}
          currentClass={currentClass}
          utilityPrefix={utilityPrefix}
          imageSettings={settings}
          onApplyEnum={onApplyEnum}
          onReset={(spec) => resetSpecs.push(spec)}
        />
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

      const width = screen.getByLabelText<HTMLInputElement>('Width');
      expect(width).toHaveValue('16');
      expect(width.closest('.value-field')).toHaveTextContent(/rem/i);
      fireEvent.change(width, { target: { value: '12' } });
      fireEvent.keyDown(width, { key: 'Enter' });

      expect(onApplyEnum).toHaveBeenCalledWith('w-[12rem]', { width: '12rem' });
      expect(settings.setAttribute).toHaveBeenCalledWith('width', null);
      fireEvent.change(width, { target: { value: '' } });
      fireEvent.keyDown(width, { key: 'Enter' });
      const resetSpec = resetSpecs[resetSpecs.length - 1];
      expect(resetSpec).toEqual(expect.objectContaining({ cssProps: ['width'] }));
      expect(resetSpec?.match(`${utilityPrefix}w-64`)).toBe(true);
      vi.unstubAllGlobals();
    }
  );

  // ── Class-less elements (no_class → Add class) ──

  const noClassSelection: Selection = {
    signature: { className: '', tagName: 'div', ancestorClasses: [] },
    resolution: { status: 'no_class' },
    instanceCount: 1,
  };

  it('offers "Add class" instead of a read-only dead end for a class-less element', () => {
    render(
      <VisualEditorPanel
        {...mk()}
        selection={noClassSelection}
        currentClass=""
        onAddFirstClass={vi.fn()}
      />
    );
    // The add-a-class state, not the misleading "dynamic classes" banner…
    expect(screen.getByText(/has no classes yet/)).toBeInTheDocument();
    expect(screen.queryByText(/aren’t a static string/)).not.toBeInTheDocument();
    // …and no style controls or footer (there's nothing to write to yet).
    expect(screen.queryByTestId('spacing-box')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /auto-save/i })).not.toBeInTheDocument();
    // The action is disabled until a name is typed.
    expect(screen.getByRole('button', { name: 'Add class' })).toBeDisabled();
  });

  it('submits the typed first class (leading dot stripped) via onAddFirstClass', async () => {
    const onAddFirstClass = vi.fn(async () => {});
    render(
      <VisualEditorPanel
        {...mk()}
        selection={noClassSelection}
        currentClass=""
        onAddFirstClass={onAddFirstClass}
      />
    );
    const input = screen.getByLabelText('First class name');
    fireEvent.change(input, { target: { value: '.hero-title' } });
    // Flush the async submit so the busy flag releases before the next attempt.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
      await Promise.resolve();
    });
    expect(onAddFirstClass).toHaveBeenCalledWith('hero-title');
    // Enter in the input submits too.
    fireEvent.change(input, { target: { value: 'flex gap-4' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(onAddFirstClass).toHaveBeenCalledWith('flex gap-4');
  });
});
