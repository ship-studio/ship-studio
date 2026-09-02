import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ElementSettings } from '../../hooks/useElementSettings';
import { ElementSettingsPanel } from './ElementSettingsPanel';

it('renames a class chip inline', () => {
  const renameClass = vi.fn();
  const settings: ElementSettings = {
    tag: 'div',
    classes: ['ss-div-c098'],
    attributes: [],
    addClass: vi.fn(),
    renameClass,
    removeClass: vi.fn(),
    setAttribute: vi.fn(),
    renameAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    canEditAttributes: true,
    location: null,
    busy: false,
  };
  render(<ElementSettingsPanel settings={settings} />);

  fireEvent.click(screen.getByRole('button', { name: '.ss-div-c098' }));
  const input = screen.getByRole('textbox', { name: 'Rename .ss-div-c098' });
  fireEvent.change(input, { target: { value: 'content-panel' } });
  fireEvent.blur(input);

  expect(renameClass).toHaveBeenCalledWith('ss-div-c098', 'content-panel');
});
