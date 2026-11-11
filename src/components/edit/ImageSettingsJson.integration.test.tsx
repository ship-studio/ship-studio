import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { ElementSignature, ImageResolution } from '../../lib/edit';
import { ImageSettingsSection } from './ImageSettingsSection';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../workspace/AssetsPanel', () => ({ AssetsModal: () => null }));

const jsonResolution: ImageResolution = {
  status: 'json_property',
  file: 'src/data/assets.json',
  line: 8,
  column: 17,
  src: '/images/members.jpg',
  expression: 'assets.updates.imgImage',
  property_path: ['updates', 'imgImage'],
  source_file: 'src/pages/index.astro',
  source_line: 72,
  source_column: 18,
  source_expression_start: 2412,
  source_expression_end: 2435,
  references: ['src/pages/index.astro:72:18', 'src/components/Updates.astro:14:24'],
  literal_references: ['scripts/build-report.mjs:20:18'],
  scope_known: true,
};

function makeSettings(overrides: Partial<ElementSettings> = {}): ElementSettings {
  return {
    selectionKey: 'classless-astro-image',
    tag: 'img',
    tagOptions: [{ tag: 'img', label: 'Image' }],
    canEditTag: false,
    setTag: vi.fn().mockResolvedValue(true),
    classes: [],
    attributes: [{ name: 'src', value: '{assets.updates.imgImage}', isExpression: true }],
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
    canEditAttributes: false,
    sourceMarkupStatus: 'unavailable',
    imageAttributeEditBlockReason: null,
    location: null,
    busy: false,
    ...overrides,
  };
}

const signature: ElementSignature = {
  className: '',
  tagName: 'img',
  ancestorClasses: [],
  attrSrc: '/images/members.jpg',
  attrAlt: 'Vinyl Alliance members meeting in a conference room',
  attrWidth: '451',
  attrHeight: '451',
  attrLoading: null,
  currentSrc: 'http://localhost:4321/images/members.jpg',
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(jsonResolution);
});

it('resolves and updates a classless Astro JSON image from CSS Settings with shared confirmation', async () => {
  const settings = makeSettings();
  const onOpenInCode = vi.fn();
  const { container } = render(
    <ImageSettingsSection
      settings={settings}
      signature={signature}
      projectPath="/project"
      onOpenInCode={onOpenInCode}
    />
  );

  await screen.findByRole('textbox', { name: 'URL' });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('/images/members.jpg')
  );
  const url = screen.getByRole('textbox', { name: 'URL' });
  expect(url).toBeEnabled();
  const source = await screen.findByRole('textbox', { name: 'Source' });
  expect(source).toHaveValue('src={assets.updates.imgImage}');
  expect(source).toBeDisabled();
  expect(source).toHaveAttribute('title', 'JSON value: src/data/assets.json › updates.imgImage');
  expect(screen.getByRole('button', { name: 'Replace image…' })).toBeEnabled();
  const openBinding = screen.getByRole('button', {
    name: 'Open image source binding in src/pages/index.astro, line 72',
  });
  fireEvent.click(openBinding);
  expect(onOpenInCode).toHaveBeenCalledWith('src/pages/index.astro', 72);
  expect(openBinding).toHaveAttribute(
    'title',
    'Open image source binding in src/pages/index.astro, line 72'
  );
  expect(screen.queryByRole('button', { name: /Open source expression/ })).not.toBeInTheDocument();
  expect(container.querySelector('.ss-settings-image__references li')).toBeNull();
  expect(container.querySelector('.ss-settings-image__literal-references li')).toBeNull();

  const resolveCall = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === 'resolve_image_source');
  expect(resolveCall).toBeDefined();
  expect(resolveCall?.[1]).toMatchObject({
    projectPath: '/project',
    signature: {
      className: '',
      tagName: 'img',
      attrSrc: '/images/members.jpg',
      attrAlt: 'Vinyl Alliance members meeting in a conference room',
      attrWidth: '451',
      attrHeight: '451',
      attrLoading: null,
    },
  });
  expect(resolveCall?.[1]).not.toHaveProperty('signature.sourceFile');

  fireEvent.change(url, { target: { value: '/images/replacement.jpg' } });
  fireEvent.blur(url);
  expect(await screen.findByRole('dialog', { name: 'Update shared image value?' })).toBeTruthy();
  expect(screen.getByText(/Matching URL literals \(not changed\)/)).toBeInTheDocument();
  expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('apply_json_image_edit', expect.anything());

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === 'apply_json_image_edit')
  ).toBe(false);

  fireEvent.change(url, { target: { value: '/images/replacement.jpg' } });
  fireEvent.blur(url);
  fireEvent.click(await screen.findByRole('button', { name: 'Update JSON value' }));
  await waitFor(() => {
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === 'apply_json_image_edit')
    ).toBe(true);
  });

  expect(invoke).toHaveBeenCalledWith(
    'apply_json_image_edit',
    expect.objectContaining({
      projectPath: '/project',
      sourceFile: 'src/pages/index.astro',
      sourceLine: 72,
      sourceColumn: 18,
      oldSrc: '/images/members.jpg',
      newSrc: '/images/replacement.jpg',
      expectedFile: 'src/data/assets.json',
      expectedPropertyPath: ['updates', 'imgImage'],
      expectedExpression: 'assets.updates.imgImage',
      expectedScopeKnown: true,
      confirmedShared: true,
    })
  );
  expect(settings.setAttribute).not.toHaveBeenCalled();
});
