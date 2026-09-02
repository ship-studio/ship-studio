import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RefObject } from 'react';
import {
  CloudflareIcon,
  CopyIcon,
  FolderOpenIcon,
  ImageUploadIcon,
  NestRuleIcon,
  SearchIcon,
  TemplateIcon,
  VariablesIcon,
} from './index';
import { getGalleryIcons } from './IconGallery';

describe('shared icons', () => {
  it('renders SearchIcon metadata, currentColor artwork, and decorative accessibility defaults', () => {
    const { container } = render(<SearchIcon />);
    const icon = container.querySelector('svg');

    expect(icon).toHaveAttribute('data-icon-name', 'SearchIcon');
    expect(icon).toHaveAttribute('data-icon-kind', 'ui');
    expect(icon).toHaveAttribute('data-icon-source', 'icons/search.svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('stroke-width', '1px');
    expect(icon?.innerHTML).toContain('currentColor');
  });

  it('registers the Variables icon from the imported design-system asset', () => {
    const { container } = render(<VariablesIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/import/variables.svg'
    );
  });

  it('registers imported project-action icons with currentColor artwork', () => {
    const { container, rerender } = render(<ImageUploadIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/image-upload.svg'
    );
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');

    rerender(<TemplateIcon />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'data-icon-source',
      'icons/template.svg'
    );
    expect(container.querySelector('svg')?.innerHTML).toContain('currentColor');
  });

  it('keeps the legacy standard-size compatibility result for size 14', () => {
    const { container } = render(<SearchIcon size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '16');
  });

  it('keeps compact icons at 14px for requests of 12 or 14', () => {
    const { container, rerender } = render(<CopyIcon size={12} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
    rerender(<CopyIcon size={14} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });

  it('labels icons as images and preserves caller props and refs', () => {
    const ref = { current: null } as RefObject<SVGSVGElement | null>;
    const { container } = render(
      <SearchIcon ref={ref} title="Search" className="test-icon" fill="none" aria-label="Search" />
    );
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('role', 'img');
    expect(icon).not.toHaveAttribute('aria-hidden');
    expect(icon).toHaveClass('test-icon');
    expect(icon).toHaveAttribute('fill', 'none');
    expect(ref.current).toBe(icon);
  });

  it('preserves non-square viewBoxes and extracted artwork attributes', () => {
    const { container, rerender } = render(<FolderOpenIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '0 0 25 24');
    rerender(<NestRuleIcon />);
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '2');
  });

  it('preserves fixed brand colour artwork', () => {
    const { container } = render(<CloudflareIcon />);
    expect(container.querySelector('path')).toHaveAttribute('fill', '#f38020');
  });

  it('discovers shared icons from iconMeta and sorts by semantic name', () => {
    const icons = getGalleryIcons();
    const names = icons.map((icon) => icon.iconMeta.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain('SearchIcon');
    expect(icons.find((icon) => icon.iconMeta.name === 'SearchIcon')?.iconMeta.source).toBe(
      'icons/search.svg'
    );
  });
});
