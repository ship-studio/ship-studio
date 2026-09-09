/**
 * Arranging the workspace from the command palette.
 *
 * Everything the drag does, and the two things it cannot: making the current
 * arrangement the default, and giving a project back to it. Registered here
 * because the palette is the contract — a feature that is only reachable by
 * dragging a header is a feature most people never find.
 *
 * @module commands/useLayoutCommands
 */

import { PinIcon, SplitViewIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import { useOptionalToast } from '../contexts/ToastContext';
import { usePanelDock } from '../contexts/PanelDockContext';
import { LAYOUT_PRESETS, PANEL_IDS, PANEL_META, isDocked, sideOf } from '../lib/workspaceLayout';

export function useLayoutCommands(): void {
  const {
    layout,
    isCustomised,
    differsFromDefault,
    nudge,
    setDocked,
    applyPreset,
    saveAsDefault,
    resetToDefault,
  } = usePanelDock();
  const { showToast } = useOptionalToast();

  useCommands(
    () => [
      ...PANEL_IDS.flatMap((panel) => {
        const label = PANEL_META[panel].label;
        const docked = isDocked(layout, panel);
        return [
          {
            id: `layout.dock.${panel}`,
            title: docked ? `Float ${label} panel` : `Dock ${label} panel`,
            icon: <PinIcon size={14} />,
            category: 'action' as const,
            when: 'project' as const,
            keywords: ['layout', 'panel', 'pin', 'dock', 'float', label.toLowerCase()],
            run: () => setDocked(panel, !docked),
          },
          {
            id: `layout.move.${panel}`,
            title: `Move ${label} panel ${sideOf(layout, panel) === 'left' ? 'right' : 'left'}`,
            icon: <SplitViewIcon size={14} />,
            category: 'action' as const,
            when: 'project' as const,
            keywords: ['layout', 'arrange', 'reorder', 'move', label.toLowerCase()],
            // One step towards the preview, which is the move somebody reaching
            // for a command wants: it is what changes which side you are on.
            run: () => nudge(panel, sideOf(layout, panel) === 'left' ? 1 : -1),
          },
        ];
      }),
      ...LAYOUT_PRESETS.map((preset) => ({
        id: `layout.preset.${preset.id}`,
        title: `Layout: ${preset.label}`,
        icon: <SplitViewIcon size={14} />,
        category: 'action' as const,
        when: 'project' as const,
        keywords: ['layout', 'preset', 'arrange', 'panels', preset.label.toLowerCase()],
        run: () => {
          applyPreset(preset);
          showToast(`${preset.label} layout applied to this project.`, 'success');
        },
      })),
      {
        id: 'layout.saveDefault',
        title: 'Save this layout as my default',
        icon: <SplitViewIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && differsFromDefault,
        keywords: ['layout', 'default', 'save', 'panels', 'arrange'],
        run: () => {
          saveAsDefault();
          showToast('Saved. New projects will open like this.', 'success');
        },
      },
      {
        id: 'layout.reset',
        title: 'Reset panel layout',
        icon: <SplitViewIcon size={14} />,
        category: 'action' as const,
        when: ({ kind }: { kind: string }) => kind === 'project' && isCustomised,
        keywords: ['layout', 'reset', 'default', 'panels', 'arrange'],
        run: () => {
          resetToDefault();
          showToast('This project follows your default layout again.', 'success');
        },
      },
    ],
    [
      layout,
      isCustomised,
      differsFromDefault,
      nudge,
      setDocked,
      applyPreset,
      saveAsDefault,
      resetToDefault,
      showToast,
    ]
  );
}
