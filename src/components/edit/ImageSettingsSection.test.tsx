import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { ElementSignature } from '../../lib/edit';
import { ImageSettingsSection } from './ImageSettingsSection';

vi.mock('../workspace/AssetsPanel', () => ({ AssetsModal: () => null }));

function makeSettings(overrides: Partial<ElementSettings> = {}): ElementSettings {
  return {
    selectionKey: 'selected-image',
    tag: 'img',
    tagOptions: [{ tag: 'img', label: 'Image' }],
    canEditTag: false,
    setTag: vi.fn().mockResolvedValue(true),
    classes: ['hero'],
    attributes: [{ name: 'src', value: '/old.png' }],
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
    location: { file: 'src/Hero.tsx', line: 12 },
    busy: false,
    ...overrides,
  };
}

const signature: ElementSignature = {
  className: 'hero',
  tagName: 'img',
  ancestorClasses: [],
  currentSrc: 'https://preview.example/old.png',
};

it('cancels a URL draft on Escape without committing the blur', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  render(
    <ImageSettingsSection
      settings={makeSettings({ setAttribute })}
      signature={signature}
      projectPath="/project"
    />
  );

  const url = screen.getByRole('textbox', { name: 'URL' });
  fireEvent.change(url, { target: { value: '/draft.png' } });
  fireEvent.keyDown(url, { key: 'Escape' });

  expect(url).toHaveValue('/old.png');
  expect(setAttribute).not.toHaveBeenCalled();
});

it('commits the complete URL draft on Enter', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  const longUrl = `https://cdn.example/${'image-folder/'.repeat(12)}hero.webp`;
  render(
    <ImageSettingsSection
      settings={makeSettings({ setAttribute })}
      signature={signature}
      projectPath="/project"
    />
  );

  const url = screen.getByRole('textbox', { name: 'URL' });
  url.focus();
  fireEvent.change(url, { target: { value: longUrl } });
  fireEvent.keyDown(url, { key: 'Enter' });

  expect(setAttribute).toHaveBeenCalledWith('src', longUrl);
});

it('disables spread-backed image edits and provides a code handoff', () => {
  const onOpenInCode = vi.fn();
  render(
    <ImageSettingsSection
      settings={makeSettings({
        canEditAttributes: false,
        imageAttributeEditBlockReason: 'spread',
      })}
      signature={signature}
      projectPath="/project"
      onOpenInCode={onOpenInCode}
    />
  );

  expect(screen.getByRole('textbox', { name: 'URL' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Alt text' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Replace image…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Loading' })).toBeDisabled();
  expect(screen.getByText(/spread attribute may provide image values/i)).toBeInTheDocument();

  expect(screen.queryByRole('region', { name: 'Code details' })).not.toBeInTheDocument();
  const metadataDivider = screen.getByRole('separator');
  expect(metadataDivider).toBeVisible();
  expect(metadataDivider).toHaveAttribute('aria-orientation', 'horizontal');
  expect(screen.queryByRole('button', { name: 'Open code' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open src/Hero.tsx, line 12 in Code' }));
  expect(onOpenInCode).toHaveBeenCalledWith('src/Hero.tsx', 12);
});

it('shows the rendered preview while a dynamic source stays read-only', () => {
  const onOpenInCode = vi.fn();
  render(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [{ name: 'src', value: '{heroImage}', isExpression: true }],
      })}
      signature={{
        ...signature,
        attrSrc: 'https://preview.example/hero.png',
        currentSrc: 'https://preview.example/hero@2x.png',
      }}
      projectPath="/project"
      onOpenInCode={onOpenInCode}
    />
  );

  expect(screen.getByAltText('Selected image preview')).toHaveAttribute(
    'src',
    'https://preview.example/hero@2x.png'
  );
  expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('{heroImage}');
  expect(screen.getByRole('textbox', { name: 'URL' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Source' })).toHaveValue('src={heroImage}');
  expect(screen.getByRole('textbox', { name: 'Source' })).toBeDisabled();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Open selected image source in src/Hero.tsx, line 12',
    })
  );
  expect(onOpenInCode).toHaveBeenCalledWith('src/Hero.tsx', 12);
  expect(screen.getByRole('button', { name: 'Replace image…' })).toBeDisabled();

  fireEvent.error(screen.getByAltText('Selected image preview'));
  expect(screen.getByRole('status')).toHaveTextContent('Image preview failed to load.');
});

it('keeps disabled Source and References fields visible when source details are unavailable', () => {
  render(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [],
        canEditAttributes: false,
        sourceMarkupStatus: 'unavailable',
        location: null,
      })}
      signature={{ ...signature, attrSrc: '/rendered/hero.png' }}
      projectPath="/project"
    />
  );

  const source = screen.getByRole('textbox', { name: 'Source' });
  expect(source).toBeDisabled();
  expect(source).toHaveValue('');
  expect(source).toHaveAttribute('placeholder', 'Source unavailable');
  expect(screen.getByRole('textbox', { name: 'References' })).toHaveValue('Unavailable');
  expect(screen.getByRole('textbox', { name: 'References' })).toBeDisabled();
});

it('shows known rendered values when source markup is mismatched, without enabling writes', () => {
  const longUrl = `https://cdn.example/${'image-folder/'.repeat(12)}hero.webp`;
  render(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [],
        canEditAttributes: false,
        imageAttributeEditBlockReason: 'mismatch',
      })}
      signature={{
        ...signature,
        attrSrc: longUrl,
        attrAlt: 'Rendered hero',
        attrWidth: '640',
        attrHeight: '480',
      }}
      projectPath="/project"
    />
  );

  expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue(longUrl);
  expect(screen.getByRole('textbox', { name: 'Alt text' })).toHaveValue('Rendered hero');
  expect(screen.getByRole('textbox', { name: 'Width' })).toHaveValue('640');
  expect(screen.getByRole('textbox', { name: 'Height' })).toHaveValue('480');
  expect(screen.getByRole('textbox', { name: 'URL' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Replace image…' })).toBeDisabled();
  expect(
    screen.getByText(/rendered attributes do not match the source markup found/i)
  ).toBeInTheDocument();
});

it('shows returned rendered image attributes read-only when source markup is unavailable', () => {
  render(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [],
        canEditAttributes: false,
        sourceMarkupStatus: 'unavailable',
        location: null,
      })}
      signature={{
        ...signature,
        attrSrc: '/rendered/hero.png',
        attrAlt: 'Rendered hero',
        attrWidth: '640',
        attrHeight: '480',
      }}
      projectPath="/project"
    />
  );

  expect(screen.getByRole('textbox', { name: 'URL' })).toHaveValue('/rendered/hero.png');
  expect(screen.getByRole('textbox', { name: 'Alt text' })).toHaveValue('Rendered hero');
  expect(screen.getByRole('textbox', { name: 'Width' })).toHaveValue('640');
  expect(screen.getByRole('textbox', { name: 'Height' })).toHaveValue('480');
  expect(screen.getByRole('textbox', { name: 'Alt text' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Width' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Height' })).toBeDisabled();
  expect(screen.getByText(/values below come from the rendered image/i)).toBeInTheDocument();
});

it('distinguishes an absent attribute from unresolved markup and source expressions', () => {
  const { rerender } = render(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [],
        canEditAttributes: false,
        sourceMarkupStatus: 'unavailable',
      })}
      signature={{ ...signature, attrAlt: null, attrWidth: null, attrHeight: null }}
      projectPath="/project"
    />
  );

  expect(screen.getByRole('textbox', { name: 'Alt text' })).toHaveAttribute(
    'placeholder',
    'Source unavailable'
  );
  expect(screen.getByRole('textbox', { name: 'Width' })).toHaveAttribute(
    'placeholder',
    'Source unavailable'
  );

  rerender(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [
          { name: 'alt', value: '{imageAlt}', isExpression: true },
          { name: 'loading', value: '{loadBehavior}', isExpression: true },
        ],
        canEditAttributes: true,
        sourceMarkupStatus: 'resolved',
      })}
      signature={{ ...signature, attrAlt: 'Rendered hero', attrWidth: null, attrHeight: null }}
      projectPath="/project"
    />
  );

  expect(screen.getByRole('textbox', { name: 'Alt text' })).toHaveValue('{imageAlt}');
  expect(screen.getByRole('textbox', { name: 'Alt text' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Alt text' })).toHaveAttribute(
    'title',
    'This value is generated by code.'
  );
  expect(screen.getByRole('button', { name: 'Loading' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Width' })).toHaveAttribute('placeholder', 'Not set');
});

it('uses the Visual Editor field primitives for image attributes', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  render(
    <ImageSettingsSection
      settings={makeSettings({
        setAttribute,
        attributes: [
          { name: 'src', value: '/hero.png' },
          { name: 'alt', value: 'Hero' },
          { name: 'width', value: '640' },
          { name: 'height', value: '480' },
          { name: 'loading', value: 'lazy' },
        ],
      })}
      signature={signature}
      projectPath="/project"
    />
  );

  const url = screen.getByRole('textbox', { name: 'URL' });
  const alt = screen.getByRole('textbox', { name: 'Alt text' });
  const width = screen.getByRole('textbox', { name: 'Width' });
  expect(url).toHaveClass('ss-text-field');
  expect(url).not.toHaveClass('ss-text-field--multiline');
  expect(alt).toHaveClass('ss-text-field');
  expect(width.closest('.value-field')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Loading' })).toHaveClass('property-field--select');

  fireEvent.change(width, { target: { value: '800' } });
  fireEvent.keyDown(width, { key: 'Escape' });
  expect(width).toHaveValue('640');
  expect(setAttribute).not.toHaveBeenCalled();

  fireEvent.change(width, { target: { value: '' } });
  fireEvent.keyDown(width, { key: 'Enter' });
  expect(setAttribute).toHaveBeenCalledWith('width', null);

  const loading = screen.getByRole('button', { name: 'Loading' });
  expect(loading).toBeEnabled();
  fireEvent.click(loading);
  fireEvent.click(screen.getByRole('option', { name: 'Auto' }));
  expect(setAttribute).toHaveBeenCalledWith('loading', null);

  fireEvent.click(loading);
  fireEvent.click(screen.getByRole('option', { name: 'Eager' }));
  expect(setAttribute).toHaveBeenCalledWith('loading', 'eager');
});

it('shows only pixel units when dimensions can save only as HTML attributes', () => {
  render(
    <ImageSettingsSection
      settings={makeSettings({
        attributes: [
          { name: 'src', value: '/hero.png' },
          { name: 'width', value: '640' },
        ],
      })}
      signature={signature}
      projectPath="/project"
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Width format' }));

  expect(screen.getByRole('option', { name: 'PX' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: '%' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'EM' })).not.toBeInTheDocument();
});

it('keeps non-pixel unit choices when an editable CSS dimension rule is available', () => {
  render(
    <ImageSettingsSection
      settings={makeSettings({ attributes: [{ name: 'src', value: '/hero.png' }] })}
      signature={signature}
      projectPath="/project"
      onSetCssDimension={vi.fn().mockReturnValue(true)}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Width format' }));

  expect(screen.getByRole('option', { name: '%' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'EM' })).toBeInTheDocument();
});

it('writes non-pixel image dimensions to CSS and removes the HTML attribute', () => {
  const setAttribute = vi.fn().mockResolvedValue(true);
  const setCssDimension = vi.fn().mockReturnValue(true);
  render(
    <ImageSettingsSection
      settings={makeSettings({
        setAttribute,
        attributes: [
          { name: 'src', value: '/hero.png' },
          { name: 'width', value: '640' },
        ],
      })}
      signature={signature}
      projectPath="/project"
      onSetCssDimension={setCssDimension}
    />
  );

  const width = screen.getByRole('textbox', { name: 'Width' });
  fireEvent.change(width, { target: { value: '50%' } });
  fireEvent.keyDown(width, { key: 'Enter' });

  expect(setCssDimension).toHaveBeenCalledWith('width', '50%');
  expect(setAttribute).toHaveBeenCalledWith('width', null);
});

it('rejects unsafe rendered preview schemes', () => {
  render(
    <ImageSettingsSection
      settings={makeSettings()}
      signature={{ ...signature, currentSrc: 'javascript:alert(1)' }}
      projectPath="/project"
    />
  );

  expect(screen.queryByAltText('Selected image preview')).not.toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: 'Image preview unavailable for this source' })
  ).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Preview unavailable for this image source.'
  );
});

it('shows intrinsic dimensions from currentSrc instead of the rendered thumbnail', () => {
  const probes: Array<{
    src: string;
    naturalWidth: number;
    naturalHeight: number;
    onload: (() => void) | null;
  }> = [];
  class ImageProbe {
    src = '';
    naturalWidth = 0;
    naturalHeight = 0;
    complete = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      probes.push(this);
    }
  }
  vi.stubGlobal('Image', ImageProbe);

  try {
    render(
      <ImageSettingsSection
        settings={makeSettings({
          attributes: [
            { name: 'src', value: '/old.png' },
            { name: 'width', value: '640' },
            { name: 'height', value: '320' },
          ],
        })}
        signature={{
          ...signature,
          currentSrc: 'https://preview.example/original.png',
          currentPreview: 'data:image/png;base64,iVBORw0KGgo=',
          naturalWidth: null,
          naturalHeight: null,
        }}
        projectPath="/project"
      />
    );

    fireEvent.load(screen.getByAltText('Selected image preview'));
    expect(screen.getByText('Loading dimensions…')).toBeInTheDocument();
    expect(screen.queryByText('96 × 64 px')).not.toBeInTheDocument();

    const probe = probes[0];
    expect(probe?.src).toBe('https://preview.example/original.png');
    if (!probe) throw new Error('The original image URL was not probed.');
    probe.naturalWidth = 1600;
    probe.naturalHeight = 900;
    act(() => probe.onload?.());

    expect(screen.getByText('1600 × 900 px')).toBeInTheDocument();
    expect(screen.queryByText('96 × 64 px')).not.toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});
