import { act, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppMode } from './useAppMode';
import { getSnapshot } from '../commands/registry';
import type { AppView } from '../lib/types';

function setup(initial: AppView, projectPath: string | null = null) {
  const setView = vi.fn();
  const openProject = vi.fn();
  const hook = renderHook(
    ({ view, path }: { view: AppView; path: string | null }) =>
      useAppMode({ view, setView, currentProjectPath: path, openProject }),
    { initialProps: { view: initial, path: projectPath } }
  );
  return { ...hook, setView, openProject };
}

const pressToggle = () =>
  fireEvent.keyDown(window, { key: 'A', code: 'KeyA', metaKey: true, shiftKey: true });

describe('useAppMode', () => {
  it('returns to the dashboard when that was the last Projects place', () => {
    const { result, rerender, setView } = setup('projects');
    rerender({ view: 'agents', path: null });
    act(() => result.current.onGoProjects());
    expect(setView).toHaveBeenLastCalledWith('projects');
  });

  it('re-enters the open project the way a sidebar click does', () => {
    const { result, rerender, setView, openProject } = setup('workspace', '/p/acme');
    rerender({ view: 'agents', path: '/p/acme' });
    act(() => result.current.onGoProjects());
    expect(openProject).toHaveBeenCalledWith('/p/acme');
    expect(setView).not.toHaveBeenCalled();
  });

  it('remembers Workflows and the Inbox too', () => {
    const { result, rerender, setView } = setup('inbox');
    rerender({ view: 'agents', path: null });
    act(() => result.current.onGoProjects());
    expect(setView).toHaveBeenLastCalledWith('inbox');
  });

  it('flips modes with ⌘⇧A', () => {
    const { rerender, setView } = setup('projects');
    pressToggle();
    expect(setView).toHaveBeenLastCalledWith('agents');
    rerender({ view: 'agents', path: null });
    pressToggle();
    expect(setView).toHaveBeenLastCalledWith('projects');
  });

  it('leaves ⌘⇧A alone outside the modes and under a dialog', () => {
    const { rerender, setView } = setup('onboarding');
    pressToggle();
    rerender({ view: 'projects', path: null });
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    pressToggle();
    dialog.remove();
    expect(setView).not.toHaveBeenCalled();
  });

  it('registers agents.toggleMode in the palette', () => {
    const { setView } = setup('projects');
    const command = getSnapshot().find((c) => c.id === 'agents.toggleMode');
    expect(command?.title).toBe('Switch to Agents');
    act(() => void command?.run());
    expect(setView).toHaveBeenCalledWith('agents');
  });
});
