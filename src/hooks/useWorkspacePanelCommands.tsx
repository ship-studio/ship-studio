import { VariablesIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';

interface Params {
  isAgentPanelHidden: boolean;
  toggleAgentPanel: () => void;
  agentPanelDocked: boolean;
  toggleAgentPanelDocked: () => void;
  elementTreeDocked: boolean;
  toggleElementTreeDocked: () => void;
  variablesPanelDocked: boolean;
  toggleVariablesPanelDocked: () => void;
  isWebProject: boolean;
  variablesPanelOpen: boolean;
  toggleVariablesPanel: () => void;
  showPreviewLogs: boolean;
  togglePreviewLogs: () => void;
}

/** Registers the workspace panel actions exposed by the Cmd+K palette. */
export function useWorkspacePanelCommands({
  isAgentPanelHidden,
  toggleAgentPanel,
  agentPanelDocked,
  toggleAgentPanelDocked,
  elementTreeDocked,
  toggleElementTreeDocked,
  variablesPanelDocked,
  toggleVariablesPanelDocked,
  isWebProject,
  variablesPanelOpen,
  toggleVariablesPanel,
  showPreviewLogs,
  togglePreviewLogs,
}: Params): void {
  useCommands(
    () => [
      {
        id: 'workspace.toggleAgentPanel',
        title: isAgentPanelHidden ? 'Show Agent panel' : 'Hide Agent panel',
        category: 'action',
        when: 'project',
        keywords: ['terminal', 'pane', 'sidebar'],
        run: toggleAgentPanel,
      },
      {
        id: 'workspace.toggleAgentPanelPin',
        title: agentPanelDocked ? 'Float Agent panel' : 'Dock Agent panel',
        category: 'action',
        when: 'project',
        keywords: ['terminal', 'pane', 'pin', 'float', 'dock'],
        run: toggleAgentPanelDocked,
      },
      {
        id: 'workspace.toggleElementTreePin',
        title: elementTreeDocked ? 'Float Elements panel' : 'Dock Elements panel',
        category: 'action',
        when: 'project',
        keywords: ['elements', 'tree', 'navigator', 'pin', 'float', 'dock'],
        run: toggleElementTreeDocked,
      },
      {
        id: 'workspace.toggleVariablesPanelPin',
        title: variablesPanelDocked ? 'Float Variables panel' : 'Dock Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['variables', 'css', 'token', 'pin', 'float', 'dock'],
        run: toggleVariablesPanelDocked,
      },
      {
        id: 'css.variables',
        title: variablesPanelOpen ? 'Hide Variables panel' : 'Show Variables panel',
        icon: <VariablesIcon size={14} />,
        category: 'action',
        when: ({ kind }) => kind === 'project' && isWebProject,
        keywords: ['css', 'variable', 'custom property', 'token', 'theme', '--'],
        run: toggleVariablesPanel,
      },
      {
        id: 'workspace.toggleInspector',
        title: showPreviewLogs ? 'Hide Inspector' : 'Show Inspector',
        category: 'action',
        when: 'project',
        keywords: ['preview', 'browser tools', 'logs', 'console', 'network'],
        run: togglePreviewLogs,
      },
    ],
    [
      isAgentPanelHidden,
      toggleAgentPanel,
      agentPanelDocked,
      toggleAgentPanelDocked,
      elementTreeDocked,
      toggleElementTreeDocked,
      variablesPanelDocked,
      toggleVariablesPanelDocked,
      isWebProject,
      variablesPanelOpen,
      toggleVariablesPanel,
      showPreviewLogs,
      togglePreviewLogs,
    ]
  );
}
