import { useCommands } from './useCommands';
import { useOpenModal } from '../contexts/ModalContext';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  getShopifyStore,
  buildSectionPrompt,
  buildPushPrompt,
  shopifyAdminUrl,
} from '../lib/shopify';
import type { ProjectType } from '../lib/static-server';

/**
 * Palette commands for Shopify theme projects. Called from `WorkspaceView`
 * (which owns `projectType` and the agent-terminal paste handler). All
 * commands are gated to Shopify theme projects only.
 */
export interface UseShopifyCommandsParams {
  projectType: ProjectType;
  projectPath: string;
  onSendToAgent: (prompt: string) => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const BagGlyph = () => (
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
    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <path d="M16 10a4 4 0 0 1-8 0" />
  </svg>
);

export function useShopifyCommands({
  projectType,
  projectPath,
  onSendToAgent,
  showToast,
}: UseShopifyCommandsParams) {
  const openModal = useOpenModal();
  const isTheme = projectType === 'shopifytheme';

  useCommands(
    () => [
      {
        id: 'shopify.buildSection',
        title: 'Build a new theme section with AI',
        icon: <BagGlyph />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'liquid', 'section', 'block'],
        run: () => {
          onSendToAgent(buildSectionPrompt());
          showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
        },
      },
      {
        id: 'shopify.pushTheme',
        title: 'Push theme to Shopify with AI',
        icon: <BagGlyph />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'deploy', 'publish', 'upload'],
        run: async () => {
          try {
            const store = await getShopifyStore(projectPath);
            if (!store) {
              showToast('Connect a Shopify store first (see the preview pane)', 'error');
              return;
            }
            onSendToAgent(buildPushPrompt(store));
            showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
          }
        },
      },
      {
        id: 'shopify.changeStore',
        title: 'Change Shopify store…',
        icon: <BagGlyph />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'store', 'connect', 'myshopify'],
        run: () => openModal('shopifyStore'),
      },
      {
        id: 'shopify.openAdmin',
        title: 'Open Shopify admin',
        icon: <BagGlyph />,
        category: 'project',
        when: ({ kind }) => kind === 'project' && isTheme,
        keywords: ['shopify', 'dashboard', 'admin'],
        run: async () => {
          try {
            const store = await getShopifyStore(projectPath);
            if (!store) {
              showToast('Connect a Shopify store first (see the preview pane)', 'error');
              return;
            }
            await openUrl(shopifyAdminUrl(store));
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
          }
        },
      },
    ],
    [isTheme, projectPath, onSendToAgent, showToast, openModal]
  );
}
