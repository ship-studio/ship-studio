import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContent, FileEntry } from '../../lib/code';
import type { VariableRow } from '../../hooks/useCssVariables';
import { VariablesPanel } from './VariablesPanel';
import { CodeTab } from '../code/CodeTab';
import { listProjectFiles, readProjectFile } from '../../lib/code';
import { resolveCssSourceLine } from '../../lib/cssCascade';

const { registeredCommands } = vi.hoisted(() => ({
  registeredCommands: [] as Array<{ id: string; run: () => void | Promise<void> }>,
}));

vi.mock('../../lib/code', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/code')>();
  return {
    ...actual,
    listProjectFiles: vi.fn(),
    readProjectFile: vi.fn(),
    saveProjectFile: vi.fn(),
  };
});

vi.mock('../../lib/cssCascade', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/cssCascade')>();
  return { ...actual, resolveCssSourceLine: vi.fn() };
});

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../commands/useCommands', () => ({
  useCommands: (factory: () => Array<{ id: string; run: () => void | Promise<void> }>) => {
    registeredCommands.push(...factory());
  },
}));
vi.mock('../code/CodeViewer', () => ({
  CodeViewer: ({
    filePath,
    revealLine,
    revealRequestId,
  }: {
    filePath: string | null;
    revealLine?: number | null;
    revealRequestId?: number | null;
  }) => (
    <div
      data-testid="code-viewer"
      data-file={filePath ?? ''}
      data-line={revealLine ?? ''}
      data-request={revealRequestId ?? ''}
    />
  ),
}));

const content: FileContent = {
  content: '<style>\n:root { --surface: white; }\n</style>',
  isBinary: false,
  isTruncated: false,
  size: 44,
  language: 'astro',
};

const entries: FileEntry[] = [
  { name: 'src', path: 'src', isDirectory: true, size: 0 },
  { name: 'components', path: 'src/components', isDirectory: true, size: 0 },
  {
    name: 'SiteFooter.astro',
    path: 'src/components/SiteFooter.astro',
    isDirectory: false,
    size: 44,
  },
];

const variable: VariableRow = {
  name: '--surface',
  value: 'white',
  selector: ':root',
  file: 'src/components/SiteFooter.astro?style=0',
  line: 2,
  editable: true,
};

const variablesState = {
  variables: [variable],
  loading: false,
  setValue: vi.fn(),
  addVariable: vi.fn(),
  analyzeDeletion: vi.fn(),
  deleteVariable: vi.fn(),
  reorderVariables: vi.fn(),
} as unknown as Parameters<typeof VariablesPanel>[0]['variablesState'];

function SourceNavigationHandoff() {
  const [workspaceTab, setWorkspaceTab] = useState<'preview' | 'code'>('preview');
  const [codeTarget, setCodeTarget] = useState<{
    file: string;
    line: number;
    requestId: number;
  } | null>(null);
  const requestIdRef = useRef(0);
  const openInCode = useCallback((file: string, line: number) => {
    requestIdRef.current += 1;
    setCodeTarget({ file, line, requestId: requestIdRef.current });
    setWorkspaceTab('code');
  }, []);

  return (
    <>
      <VariablesPanel
        variablesState={variablesState}
        projectPath="/project"
        onClose={vi.fn()}
        onOpenInCode={openInCode}
      />
      {workspaceTab === 'code' && <CodeTab projectPath="/project" revealTarget={codeTarget} />}
    </>
  );
}

describe('Variables source navigation handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredCommands.length = 0;
    vi.mocked(resolveCssSourceLine).mockResolvedValue(14);
    vi.mocked(readProjectFile).mockResolvedValue(content);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves an Astro virtual rule before mounting Code and reveals repeat requests', async () => {
    let finishTree!: (result: FileEntry[]) => void;
    vi.mocked(listProjectFiles).mockReturnValue(
      new Promise((resolve) => {
        finishTree = resolve;
      })
    );

    render(<SourceNavigationHandoff />);

    const sourceLink = screen.getByRole('button', {
      name: 'Open :root in src/components/SiteFooter.astro?style=0 at line 2 in Code tab',
    });
    fireEvent.click(sourceLink);

    await waitFor(() => expect(resolveCssSourceLine).toHaveBeenCalledTimes(1));
    expect(resolveCssSourceLine).toHaveBeenCalledWith(
      '/project',
      'src/components/SiteFooter.astro?style=0',
      { selector: ':root', mediaText: null, href: null },
      2
    );
    expect(await screen.findByTestId('code-viewer')).toHaveAttribute('data-file', '');

    await act(async () => {
      finishTree(entries);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(readProjectFile).toHaveBeenCalledWith('/project', 'src/components/SiteFooter.astro');
      expect(screen.getByTestId('code-viewer')).toHaveAttribute(
        'data-file',
        'src/components/SiteFooter.astro'
      );
      expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-line', '14');
      expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-request', '1');
    });

    fireEvent.click(sourceLink);
    await waitFor(() => {
      expect(resolveCssSourceLine).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-request', '2');
    });
    expect(screen.getByTestId('code-viewer')).toHaveAttribute('data-line', '14');
    expect(readProjectFile).toHaveBeenCalledTimes(1);
  });
});
