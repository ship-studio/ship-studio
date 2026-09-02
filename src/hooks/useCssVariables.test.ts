import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/cssCascade', () => ({
  getCssVariables: vi.fn(),
}));

vi.mock('../lib/edit-css', () => ({
  addCssVariable: vi.fn(),
  analyzeCssVariableDeletion: vi.fn(),
  deleteCssVariable: vi.fn(),
  listStylesheets: vi.fn(),
  setCssVariable: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getCssVariables } from '../lib/cssCascade';
import { addCssVariable, listStylesheets, setCssVariable } from '../lib/edit-css';
import { useCssVariables } from './useCssVariables';

function fakeIframeRef() {
  return {
    current: { contentWindow: { postMessage: vi.fn() } },
  } as unknown as React.RefObject<HTMLIFrameElement | null>;
}

function setup() {
  const onToast = vi.fn();
  const hook = renderHook(() =>
    useCssVariables({
      iframeRef: fakeIframeRef(),
      projectPath: '/proj',
      enabled: true,
      onToast,
    })
  );
  return { ...hook, onToast };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCssVariables).mockResolvedValue([
    { name: '--existing', value: 'red', selector: ':root', file: 'styles.css', line: 1 },
  ]);
  vi.mocked(addCssVariable).mockResolvedValue(undefined);
  vi.mocked(listStylesheets).mockResolvedValue(['styles.css']);
  vi.mocked(setCssVariable).mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe('useCssVariables', () => {
  it('pins an existing variable edit to its exact source rule', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.variables).toHaveLength(1));
    const variable = result.current.variables[0];
    vi.useFakeTimers();

    act(() => result.current.setValue(variable, 'blue'));
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(setCssVariable).toHaveBeenCalledWith(
      '/proj',
      'styles.css',
      ':root',
      1,
      '--existing',
      'blue'
    );
  });

  it('uses the dedicated variable writer when adding a token', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.variables).toHaveLength(1));

    await act(async () => {
      await result.current.addVariable('new-token', '1rem');
    });

    expect(addCssVariable).toHaveBeenCalledWith('/proj', 'styles.css', '--new-token', '1rem');
    expect(setCssVariable).not.toHaveBeenCalled();
    expect(listStylesheets).not.toHaveBeenCalled();
  });

  it('reports one error when adding a token fails', async () => {
    vi.mocked(addCssVariable).mockRejectedValueOnce({
      type: 'Validation',
      field: 'selector',
      reason: 'class is defined by multiple rules — not editable',
    });
    const { result, onToast } = setup();
    await waitFor(() => expect(result.current.variables).toHaveLength(1));

    await act(async () => {
      await result.current.addVariable('new-token', '1rem');
    });

    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledWith(
      'Validation failed for `selector`: class is defined by multiple rules — not editable',
      'error'
    );
  });
});
