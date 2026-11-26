/** Populated Pages panel reached through its Cmd+K action. */

import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';

export const pagesScenarios: Scenario[] = [
  {
    id: 'pages-populated',
    command: 'pages.toggle',
    requires: '[data-testid="pages-panel"] [data-page-route="/about"]',
    clipSelector: '[data-testid="pages-panel"]',
    title: 'Pages — routes from the active project',
    looksRightWhen:
      'The Pages panel opens from Cmd+K, shows the active route and a populated route list, and keeps its dock controls in the panel header.',
    project: WORKSPACE_PROJECT,
    commands: {
      ...workspaceCommands,
      detect_project_type_command: 'astro',
      list_pages: [
        { route: '/', file_path: 'src/pages/index.astro' },
        { route: '/about', file_path: 'src/pages/about.astro' },
        { route: '/blog/launch-notes', file_path: 'src/pages/blog/launch-notes.astro' },
        { route: '/contact', file_path: 'src/pages/contact.astro' },
      ],
    },
  },
];
