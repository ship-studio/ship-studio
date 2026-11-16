import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { _reset, getSnapshot } from '../../commands/registry';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { ElementSignature } from '../../lib/edit';
import { ElementSettingsPanel } from './ElementSettingsPanel';

function makeSettings(overrides: Partial<ElementSettings> = {}): ElementSettings {
  return {
    selectionKey: 'selected-element',
    tag: 'p',
    tagOptions: [{ tag: 'p', label: 'Paragraph' }],
    canEditTag: false,
    setTag: vi.fn().mockResolvedValue(true),
    classes: ['ss-div-c098'],
    attributes: [],
    text: 'Saved source text',
    textReason: null,
    canEditText: true,
    setText: vi.fn().mockResolvedValue(true),
    addClass: vi.fn(),
    renameClass: vi.fn(),
    removeClass: vi.fn(),
    setAttribute: vi.fn(),
    renameAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    canEditAttributes: true,
    sourceMarkupStatus: 'resolved',
    location: null,
    busy: false,
    ...overrides,
  };
}

it('renames a class chip inline', () => {
  const renameClass = vi.fn();
  const settings = makeSettings({ renameClass });
  render(<ElementSettingsPanel settings={settings} />);

  fireEvent.click(screen.getByRole('button', { name: '.ss-div-c098' }));
  const input = screen.getByRole('textbox', { name: 'Rename .ss-div-c098' });
  fireEvent.change(input, { target: { value: 'content-panel' } });
  fireEvent.blur(input);

  expect(renameClass).toHaveBeenCalledWith('ss-div-c098', 'content-panel');
});

it('commits the full text field on blur', () => {
  const setText = vi.fn().mockResolvedValue(true);
  render(<ElementSettingsPanel settings={makeSettings({ setText })} />);

  const field = screen.getByRole('textbox', { name: 'Text content' });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'A longer source-backed headline' } });
  fireEvent.blur(field);

  expect(setText).toHaveBeenCalledWith('A longer source-backed headline');
});

it('commits on Cmd+Enter and cancels on Escape without writing', () => {
  const setText = vi.fn().mockResolvedValue(true);
  const { rerender } = render(<ElementSettingsPanel settings={makeSettings({ setText })} />);
  const field = screen.getByRole('textbox', { name: 'Text content' });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'Saved with shortcut' } });
  fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

  expect(setText).toHaveBeenCalledWith('Saved with shortcut');

  setText.mockClear();
  rerender(<ElementSettingsPanel settings={makeSettings({ setText, text: 'Original' })} />);
  const cancelField = screen.getByRole('textbox', { name: 'Text content' });
  fireEvent.focus(cancelField);
  fireEvent.change(cancelField, { target: { value: 'Discard this edit' } });
  fireEvent.keyDown(cancelField, { key: 'Escape' });

  expect(setText).not.toHaveBeenCalled();
  expect(cancelField).toHaveValue('Original');
});

it('discards a dirty draft when the selected element changes with identical text', () => {
  const setText = vi.fn().mockResolvedValue(true);
  const { rerender } = render(
    <ElementSettingsPanel settings={makeSettings({ setText, selectionKey: 'first' })} />
  );
  const field = screen.getByRole('textbox', { name: 'Text content' });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'Unsaved text from first element' } });

  rerender(<ElementSettingsPanel settings={makeSettings({ setText, selectionKey: 'second' })} />);
  const secondField = screen.getByRole('textbox', { name: 'Text content' });
  expect(secondField).not.toHaveFocus();
  fireEvent.blur(secondField);

  expect(setText).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Text content' })).toHaveValue('Saved source text');
});

it('offers compatible tags from the tag menu', () => {
  const setTag = vi.fn().mockResolvedValue(true);
  render(
    <ElementSettingsPanel
      settings={makeSettings({
        tag: 'h4',
        tagOptions: [
          { tag: 'h4', label: 'H4' },
          { tag: 'h5', label: 'H5' },
        ],
        canEditTag: true,
        setTag,
      })}
    />
  );

  const trigger = screen.getByRole('button', { name: 'Change element tag' });
  expect(trigger.querySelector('.ss-cascade-chip[data-tone="selector"]')).not.toBeNull();
  expect(trigger).toHaveTextContent('h4');
  expect(trigger.querySelectorAll('svg')).toHaveLength(1);
  fireEvent.click(trigger);
  expect(screen.getByText('Swap tag type')).toBeInTheDocument();
  const headingOption = screen.getByRole('menuitem', { name: 'H5' });
  expect(headingOption.querySelector('svg')).not.toBeNull();
  fireEvent.click(headingOption);

  expect(setTag).toHaveBeenCalledWith('h5');
});

it('orders Text after Classes and before Attributes', () => {
  const { container } = render(<ElementSettingsPanel settings={makeSettings()} />);

  expect(
    [...container.querySelectorAll('.ss-edit-panel__section-title')].map(
      (heading) => heading.textContent
    )
  ).toEqual(['Element', 'Attributes']);
  expect(
    screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)
  ).toEqual(['Tag', 'Classes', 'Text']);
});

it('places Image Settings between the Element and Attributes sections', () => {
  const signature: ElementSignature = {
    className: 'hero',
    tagName: 'img',
    ancestorClasses: [],
  };
  const { container } = render(
    <ElementSettingsPanel
      settings={makeSettings({ tag: 'img' })}
      signature={signature}
      projectPath="/project"
    />
  );

  expect(
    [...container.querySelectorAll('.ss-edit-panel__section-title')].map(
      (heading) => heading.textContent
    )
  ).toEqual(['Element', 'Image Settings', 'Attributes']);
});

it('places Add attribute directly underneath the empty attributes message', () => {
  const { container } = render(
    <ElementSettingsPanel settings={makeSettings({ attributes: [] })} />
  );

  const section = [...container.querySelectorAll('details')].find((item) =>
    item.querySelector('.ss-edit-panel__section-title')?.textContent?.includes('Attributes')
  );
  const body = section?.querySelector('.ss-edit-panel__section-body');
  expect(body?.children[0]).toHaveClass('ss-settings__empty');
  expect(body?.children[1]).toHaveTextContent('Add attribute');
});

it('saves a named attribute with an empty value from the icon button', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  render(<ElementSettingsPanel settings={makeSettings({ setAttribute })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'aria-hidden' },
  });
  expect(screen.getByRole('textbox', { name: 'Attribute value' })).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Save attribute' }));

  expect(setAttribute).toHaveBeenCalledWith('aria-hidden', '');
  expect(screen.getByRole('button', { name: 'Add attribute' })).toBeInTheDocument();
});

it('saves a valid draft when a pointer lands on nonfocusable text outside the row', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  render(<ElementSettingsPanel settings={makeSettings({ setAttribute })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'data-mode' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute value' }), {
    target: { value: 'compact' },
  });
  fireEvent.pointerDown(screen.getByText('No other attributes.'));

  expect(setAttribute).toHaveBeenCalledWith('data-mode', 'compact');
  expect(screen.getByRole('button', { name: 'Add attribute' })).toBeInTheDocument();
});

it('keeps focus transitions inside the draft row from saving before cancel', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  render(<ElementSettingsPanel settings={makeSettings({ setAttribute })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'data-draft' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute value' }), {
    target: { value: 'discard me' },
  });
  const cancel = screen.getByRole('button', { name: 'Cancel adding attribute' });
  fireEvent.blur(screen.getByRole('textbox', { name: 'Attribute value' }), {
    relatedTarget: cancel,
  });

  expect(screen.getByRole('textbox', { name: 'Attribute name' })).toBeInTheDocument();
  expect(setAttribute).not.toHaveBeenCalled();
  fireEvent.click(cancel);

  expect(setAttribute).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Add attribute' })).toBeInTheDocument();
});

it('closes an outside-clicked draft without writing an empty attribute name', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  render(<ElementSettingsPanel settings={makeSettings({ setAttribute })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute value' }), {
    target: { value: 'orphaned value' },
  });
  fireEvent.pointerDown(screen.getByText('No other attributes.'));

  expect(setAttribute).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Add attribute' })).toBeInTheDocument();
});

it('registers palette actions to focus text and open the compatible tag menu', () => {
  _reset();
  render(
    <ElementSettingsPanel
      settings={makeSettings({
        canEditTag: true,
        tagOptions: [
          { tag: 'div', label: 'Div' },
          { tag: 'a', label: 'Link block' },
        ],
      })}
    />
  );

  const commands = getSnapshot();
  const focusText = commands.find((command) => command.id === 'elementSettings.focusText');
  const openTagMenu = commands.find((command) => command.id === 'elementSettings.openTagMenu');
  expect(focusText?.title).toBe('Edit selected element text');
  expect(openTagMenu?.title).toBe('Change selected element tag');

  act(() => void focusText?.run());
  expect(screen.getByRole('textbox', { name: 'Text content' })).toHaveFocus();
  act(() => void openTagMenu?.run());
  expect(screen.getByRole('menuitem', { name: 'Link block' })).toBeInTheDocument();
});
