import { useCommands } from './useCommands';
import { useOpenModal } from '../contexts/ModalContext';
import {
  getHubspotDest,
  getHubspotThemeSrc,
  defaultThemeDest,
  buildHubspotPushPrompt,
} from '../lib/hubspot';
import type { ProjectType } from '../lib/static-server';
import { asCommandError, formatCommandError } from '../lib/errors';

/**
 * Palette commands for HubSpot CMS theme projects. Called from `WorkspaceView`
 * (which owns `projectType` and the agent-terminal paste handler). All
 * commands are gated to HubSpot theme projects only.
 */
export interface UseHubspotCommandsParams {
  projectType: ProjectType;
  projectPath: string;
  onSendToAgent: (prompt: string) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const SprocketGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="14" r="5" />
    <path d="M12 9V3" />
    <path d="M12 3l-4 3" />
    <path d="M12 3l4 3" />
  </svg>
);

export function useHubspotCommands({
  projectType,
  projectPath,
  onSendToAgent,
  showToast,
}: UseHubspotCommandsParams) {
  const openModal = useOpenModal();
  const isTheme = projectType === 'hubspotcms';

  useCommands(
    () => [
      {
        id: 'hubspot.pushTheme',
        title: 'Upload theme to HubSpot with AI',
        icon: <SprocketGlyph />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['hubspot', 'deploy', 'publish', 'upload', 'cms'],
        run: async () => {
          try {
            const src = (await getHubspotThemeSrc(projectPath).catch(() => null)) ?? '.';
            const dest =
              (await getHubspotDest(projectPath).catch(() => null)) ??
              defaultThemeDest(projectPath, src);
            onSendToAgent(buildHubspotPushPrompt(src, dest));
            showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
          } catch (err) {
            showToast(formatCommandError(asCommandError(err)), 'error');
          }
        },
      },
      {
        id: 'hubspot.changeTheme',
        title: 'Change HubSpot theme path…',
        icon: <SprocketGlyph />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['hubspot', 'theme', 'dest', 'design tools'],
        run: () => openModal('hubspotTheme'),
      },
    ],
    [isTheme, projectPath, onSendToAgent, showToast, openModal]
  );
}
