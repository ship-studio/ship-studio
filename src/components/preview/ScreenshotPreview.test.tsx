import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScreenshotPreviewModal } from './ScreenshotPreview';

// Plain function (not vi.fn) so the global afterEach vi.restoreAllMocks()
// can't strip the implementation between tests.
vi.mock('../../lib/ide', () => ({
  getScreenshotBase64: () => Promise.resolve(null),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('ScreenshotPreviewModal filename display', () => {
  it('shows only the basename for POSIX paths', () => {
    render(
      <ScreenshotPreviewModal
        filePath="/Users/dev/project/.shipstudio/screenshots/shot.png"
        onClose={() => {}}
      />
    );
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });

  it('shows only the basename for Windows paths', () => {
    render(
      <ScreenshotPreviewModal
        filePath="C:\\Users\\dev\\project\\.shipstudio\\screenshots\\shot.png"
        onClose={() => {}}
      />
    );
    expect(screen.getByText('shot.png')).toBeInTheDocument();
  });
});
