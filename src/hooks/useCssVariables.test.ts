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
  reorderCssVariables: vi.fn(),
  setCssVariable: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getCssVariables } from '../lib/cssCascade';
import {
  addCssVariable,
  listStylesheets,
  reorderCssVariables,
  setCssVariable,
} from '../lib/edit-css';
import { useCssVariables } from './useCssVariables';

function fakeIframeRef() {
  const postMessage = vi.fn();
  return {
    ref: {
      current: { contentWindow: { postMessage } },
    } as unknown as React.RefObject<HTMLIFrameElement | null>,
    postMessage,
  };
}

function setup() {
  const onToast = vi.fn();
  const { ref: iframeRef, postMessage } = fakeIframeRef();
  const hook = renderHook(() =>
    useCssVariables({
      iframeRef,
      projectPath: '/proj',
      enabled: true,
      onToast,
    })
  );
  return { ...hook, iframeRef, onToast, postMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCssVariables).mockResolvedValue([
    { name: '--existing', value: 'red', selector: ':root', file: 'styles.css', line: 1 },
  ]);
  vi.mocked(addCssVariable).mockResolvedValue(undefined);
  vi.mocked(listStylesheets).mockResolvedValue(['styles.css']);
  vi.mocked(setCssVariable).mockResolvedValue(undefined);
  vi.mocked(reorderCssVariables).mockResolvedValue(undefined);
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

  it('shows "no stylesheet" as an expected error toast, not a bug (#1015)', async () => {
    vi.mocked(getCssVariables).mockResolvedValue([]);
    vi.mocked(listStylesheets).mockResolvedValue([]);
    const { result, onToast } = setup();
    await waitFor(() => expect(getCssVariables).toHaveBeenCalled());

    await act(async () => {
      await result.current.addVariable('new-token', '1rem');
    });

    expect(onToast).toHaveBeenCalledWith('No stylesheet found to add the variable to.', 'error', {
      expected: true,
    });
    expect(addCssVariable).not.toHaveBeenCalled();
  });

  it('persists a projected order for one exact source rule', async () => {
    vi.mocked(getCssVariables).mockResolvedValue([
      { name: '--first', value: 'red', selector: ':root', file: 'styles.css', line: 1 },
      { name: '--second', value: 'blue', selector: ':root', file: 'styles.css', line: 1 },
    ]);
    const { result } = setup();
    await waitFor(() => expect(result.current.variables).toHaveLength(2));

    await act(async () => {
      await result.current.reorderVariables([...result.current.variables].reverse());
    });

    expect(reorderCssVariables).toHaveBeenCalledWith('/proj', 'styles.css', ':root', 1, [
      { name: '--second', file: 'styles.css', selector: ':root', line: 1 },
      { name: '--first', file: 'styles.css', selector: ':root', line: 1 },
    ]);
    expect(result.current.variables.map((variable) => variable.name)).toEqual([
      '--second',
      '--first',
    ]);
  });

  it('serializes writes for one variable and coalesces the newest pending value', async () => {
    let resolveFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(setCssVariable).mockImplementationOnce(() => firstSave);
    const { result } = setup();
    await waitFor(() => expect(result.current.variables).toHaveLength(1));
    vi.useFakeTimers();
    const variable = result.current.variables[0];

    act(() => result.current.setValue(variable, 'blue'));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    act(() => result.current.setValue(variable, 'green'));
    expect(setCssVariable).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setCssVariable).toHaveBeenNthCalledWith(
      2,
      '/proj',
      'styles.css',
      ':root',
      1,
      '--existing',
      'green'
    );
  });

  it('blocks reorder when a required pending value save fails', async () => {
    const failure = {
      type: 'Validation',
      field: 'variable',
      reason: 'source changed',
    };
    vi.mocked(setCssVariable).mockRejectedValueOnce(failure);
    const { result, onToast, postMessage } = setup();
    await waitFor(() => expect(result.current.variables).toHaveLength(1));
    vi.useFakeTimers();
    const variable = result.current.variables[0];

    act(() => result.current.setValue(variable, 'blue'));
    await act(async () => {
      await result.current.reorderVariables([variable]);
    });

    expect(reorderCssVariables).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'ss:clearVar', name: '--existing' }, '*');
    expect(result.current.variables[0]?.value).toBe('red');
  });
});
