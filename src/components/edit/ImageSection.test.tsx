import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ElementSignature, ImageResolution } from '../../lib/edit';
import type { ElementSettings } from '../../hooks/useElementSettings';
import { ImageSection } from './ImageSection';

vi.mock('../workspace/AssetsPanel', () => ({ AssetsModal: () => null }));

const signature: ElementSignature = {
  className: '',
  tagName: 'img',
  ancestorClasses: [],
  domPath: '0.1',
  attrSrc: '/old.jpg',
  currentSrc: 'http://localhost/old.jpg',
  attrAlt: 'Cover',
  attrWidth: '640',
  attrHeight: '480',
};

const resolution: ImageResolution = {
  status: 'json_property',
  file: 'src/data/assets.json',
  line: 8,
  column: 17,
  src: '/old.jpg',
  expression: 'assets.updates.imgImage',
  property_path: ['updates', 'imgImage'],
  source_file: 'src/pages/index.astro',
  source_line: 64,
  source_column: 39,
  source_expression_start: 1820,
  source_expression_end: 1843,
  references: ['src/components/Hero.astro:17:19', 'src/pages/index.astro:64:39'],
  literal_references: ['scripts/process-hero-images.mjs:25:19'],
  scope_known: true,
};

it('requires an explicit shared JSON update and cancellation writes nothing', async () => {
  const onReplace = vi.fn().mockResolvedValue(undefined);
  render(
    <ImageSection
      signature={signature}
      resolution={resolution}
      projectPath="/project"
      onReplace={onReplace}
    />
  );

  const url = await screen.findByRole('textbox', { name: 'Image URL' });
  fireEvent.change(url, { target: { value: '/replacement.png' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  expect(await screen.findByRole('dialog', { name: 'Update shared image value?' })).toBeTruthy();
  expect(screen.getAllByText(/scripts\/process-hero-images\.mjs:25:19/)).toHaveLength(2);
  expect(screen.getAllByText(/Matching URL literals/)).toHaveLength(1);
  expect(onReplace).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onReplace).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Update JSON value' }));
  await waitFor(() => expect(onReplace).toHaveBeenCalledWith('/replacement.png', true));
});

it('drops a pending replacement when the selected source changes', async () => {
  const onReplace = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <ImageSection
      signature={signature}
      resolution={resolution}
      projectPath="/project"
      onReplace={onReplace}
    />
  );
  const url = await screen.findByRole('textbox', { name: 'Image URL' });
  fireEvent.change(url, { target: { value: '/replacement.png' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(await screen.findByRole('dialog', { name: 'Update shared image value?' })).toBeTruthy();

  rerender(
    <ImageSection
      signature={{ ...signature, domPath: '0.2', attrSrc: '/second.jpg' }}
      resolution={{ ...resolution, src: '/second.jpg', source_line: 70 }}
      projectPath="/project"
      onReplace={onReplace}
    />
  );

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onReplace).not.toHaveBeenCalled();
});

it('keeps Source plain and opens a file and line from References in Code', () => {
  const onOpenInCode = vi.fn();
  const { container } = render(
    <ImageSection
      signature={signature}
      resolution={resolution}
      projectPath="/project"
      onReplace={vi.fn().mockResolvedValue(undefined)}
      onOpenInCode={onOpenInCode}
    />
  );

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Open reference in src/components/Hero.astro, line 17',
    })
  );

  expect(onOpenInCode).toHaveBeenCalledWith('src/components/Hero.astro', 17);
  expect(
    screen.getByRole('button', {
      name: 'Open reference in src/pages/index.astro, line 64',
    })
  ).toHaveTextContent('src/pages/index.astro:64');
  expect(screen.queryByRole('button', { name: /Open source expression/ })).not.toBeInTheDocument();
  expect(container.querySelector('.ss-edit-image__references li')).toBeNull();
  expect(container.querySelector('.ss-edit-image__literal-references li')).toBeNull();
  expect(screen.getByText('src={assets.updates.imgImage}')).toBeInTheDocument();
});

it('edits loading behavior through resolved image settings', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  const settings = {
    sourceMarkupStatus: 'resolved',
    canEditAttributes: true,
    busy: false,
    imageAttributeEditBlockReason: null,
    attributes: [{ name: 'loading', value: 'lazy' }],
    setAttribute,
  } as unknown as ElementSettings;
  render(
    <ImageSection
      signature={signature}
      resolution={resolution}
      projectPath="/project"
      onReplace={vi.fn().mockResolvedValue(undefined)}
      settings={settings}
    />
  );

  const loading = screen.getByRole('button', { name: 'Loading behavior' });
  expect(loading).toBeEnabled();
  fireEvent.click(loading);
  fireEvent.click(screen.getByRole('option', { name: 'Eager' }));
  expect(setAttribute).toHaveBeenCalledWith('loading', 'eager');
});

it('keeps loading read-only when its source mapping is unsafe', () => {
  const settings = {
    sourceMarkupStatus: 'resolved',
    canEditAttributes: false,
    busy: false,
    imageAttributeEditBlockReason: 'spread',
    attributes: [{ name: 'loading', value: 'lazy', isExpression: true }],
    setAttribute: vi.fn().mockResolvedValue(true),
  } as unknown as ElementSettings;
  render(
    <ImageSection
      signature={signature}
      resolution={resolution}
      projectPath="/project"
      onReplace={vi.fn().mockResolvedValue(undefined)}
      settings={settings}
    />
  );

  expect(screen.getByRole('button', { name: 'Loading behavior' })).toBeDisabled();
});
