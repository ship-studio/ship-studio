import { useCommands } from './useCommands';
import { EditIcon, SendIcon } from '../components/icons';

/**
 * Edit-mode palette commands for the selection-driven redline / change-request
 * mode.
 *
 * Two commands:
 *  - Toggle the edit & request mode on the live preview.
 *  - "Send requests to agent" — ships the pending change requests (screenshot +
 *    markdown) and self-clears the queue (gated on having pending requests). The
 *    Request-a-change section's button.
 *
 * Called from the workspace where the editor + redline handlers live (the
 * `useVisualEditor` / `useRedline` hooks + their host). The command palette picks
 * these up automatically via the global registry — no prop drilling to
 * `CommandPaletteHost` needed.
 *
 * Follows the "feature owns its commands" rule in CLAUDE.md.
 */
export interface UseRedlineCommandsParams {
  /** Enter/exit the redline & request mode on the live preview. */
  toggleEditMode: () => void;
  /** Ship the pending change requests to the agent (screenshot + markdown). */
  sendRequests: () => void;
  /** Whether edit mode is currently active (drives the toggle label). */
  editMode: boolean;
  /** Whether any change requests are staged — gates "Send requests to agent". */
  hasRequests: boolean;
}

export function useRedlineCommands({
  toggleEditMode,
  sendRequests,
  editMode,
  hasRequests,
}: UseRedlineCommandsParams) {
  useCommands(
    () => [
      {
        id: 'edit.toggle',
        title: editMode ? 'Exit edit & request mode' : 'Toggle edit & request mode',
        icon: <EditIcon size={14} />,
        category: 'action',
        when: 'project',
        keywords: ['edit', 'annotate', 'markup', 'redline', 'change request', 'visual editor'],
        run: toggleEditMode,
      },
      {
        id: 'edit.sendRequests',
        title: 'Send requests to agent',
        icon: <SendIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && hasRequests,
        keywords: ['send', 'requests', 'redline', 'change request', 'agent', 'annotate'],
        run: sendRequests,
      },
    ],
    [toggleEditMode, sendRequests, editMode, hasRequests]
  );
}
