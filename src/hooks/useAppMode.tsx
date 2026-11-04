/**
 * Projects | Agents: the app's two modes, and where each one picks up.
 *
 * Switching to Projects returns to the last place you were on that side: the
 * dashboard, Workflows, the Inbox, or the project you had open (re-entered
 * the way a sidebar click does, so its hot session is reattached rather than
 * remounted under it). Switching to Agents returns to the last conversation,
 * or Team, which AgentsView remembers itself.
 *
 * ⌘⇧A flips between them from anywhere a mode is showing; it is also
 * `agents.toggleMode` in the palette, beside the rest of the Agents
 * navigation commands registered here.
 *
 * Returns the sidebar's `onGoProjects` / `onGoAgents`, stable between renders.
 *
 * @module hooks/useAppMode
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AgentsIcon, FolderOpenIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';
import { useAgentsNavCommands } from '../commands/useAgentsCommands';
import { MODE_TOGGLE_SHORTCUT } from '../components/workspace/ModeToggle';
import type { AppView } from '../lib/types';

const PROJECTS_SIDE: readonly AppView[] = [
  'projects',
  'workflows',
  'inbox',
  'workspace',
  'project-loading',
];

interface Place {
  view: AppView;
  projectPath: string | null;
}

interface UseAppModeParams {
  view: AppView;
  setView: (view: AppView) => void;
  currentProjectPath: string | null;
  /** Re-enter a project, as clicking its sidebar row does. */
  openProject: (projectPath: string) => void;
}

export function useAppMode({ view, setView, currentProjectPath, openProject }: UseAppModeParams) {
  useAgentsNavCommands({ setView });
  const lastProjectsPlace = useRef<Place>({ view: 'projects', projectPath: null });
  useEffect(() => {
    if (!PROJECTS_SIDE.includes(view)) return;
    lastProjectsPlace.current =
      view === 'workspace' || view === 'project-loading'
        ? { view: 'workspace', projectPath: currentProjectPath }
        : { view, projectPath: null };
  }, [view, currentProjectPath]);

  const goProjects = useCallback(() => {
    const { view: last, projectPath } = lastProjectsPlace.current;
    if (last !== 'workspace') setView(last);
    else if (projectPath) openProject(projectPath);
    else setView('projects');
  }, [setView, openProject]);

  const goAgents = useCallback(() => setView('agents'), [setView]);

  const inAgents = view === 'agents';
  const inMode = inAgents || PROJECTS_SIDE.includes(view);
  const toggle = useCallback(
    () => (inAgents ? goProjects() : goAgents()),
    [inAgents, goProjects, goAgents]
  );

  const latest = useRef({ inMode, toggle });
  useEffect(() => {
    latest.current = { inMode, toggle };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.code !== 'KeyA' || event.repeat) return;
      if (!latest.current.inMode) return;
      // A dialog owns the keyboard; switching the window under it would strand it.
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      latest.current.toggle();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  useCommands(
    () => [
      {
        id: 'agents.toggleMode',
        title: inAgents ? 'Switch to Projects' : 'Switch to Agents',
        icon: inAgents ? <FolderOpenIcon size={14} /> : <AgentsIcon size={14} />,
        category: 'navigation',
        keywords: ['mode', 'toggle', 'projects', 'agents', 'switch'],
        shortcut: MODE_TOGGLE_SHORTCUT,
        when: () => inMode,
        run: toggle,
      },
    ],
    [inAgents, inMode, toggle]
  );

  return useMemo(
    () => ({ onGoProjects: goProjects, onGoAgents: goAgents }),
    [goProjects, goAgents]
  );
}
