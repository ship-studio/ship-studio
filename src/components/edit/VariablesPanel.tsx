/** Standalone project-level CSS variables panel. */

import { useCallback, useEffect, useRef } from 'react';
import { CloseIcon, PinIcon } from '@/components/icons';
import { useOptionalToast } from '../../contexts/ToastContext';
import type { useCssVariables, VariableRow } from '../../hooks/useCssVariables';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { resolveCssSourceLine } from '../../lib/cssCascade';
import { cascadeSourceBackingFile } from '../../lib/cascadePresentation';
import { logger } from '../../lib/logger';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { CssVariablesPanel } from './CssVariablesPanel';

interface VariablesPanelProps {
  variablesState: ReturnType<typeof useCssVariables>;
  projectPath?: string;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenInCode?: (file: string, line: number) => void;
}

/** Shared panel chrome for the project-wide Variables editor. */
export function VariablesPanel({
  variablesState,
  projectPath,
  onClose,
  pinned = false,
  onTogglePin,
  onOpenInCode,
}: VariablesPanelProps) {
  const variableNames = [...new Set(variablesState.variables.map((variable) => variable.name))];
  const { showToast } = useOptionalToast();
  const sourceNavigationRequestRef = useRef(0);

  useEffect(
    () => () => {
      sourceNavigationRequestRef.current += 1;
    },
    [projectPath]
  );

  const openVariableSourceInCode = useCallback(
    async (source: Pick<VariableRow, 'file' | 'line' | 'selector'>) => {
      if (!onOpenInCode) return;
      const requestId = ++sourceNavigationRequestRef.current;
      if (!projectPath) {
        showToast(
          `Couldn't resolve the matching CSS rule in ${source.file}: project path is unavailable.`,
          'error'
        );
        return;
      }

      try {
        const line = await resolveCssSourceLine(
          projectPath,
          source.file,
          { selector: source.selector, mediaText: null, href: null },
          source.line
        );
        if (requestId !== sourceNavigationRequestRef.current) return;
        onOpenInCode(cascadeSourceBackingFile(source.file), line);
      } catch (error) {
        if (requestId !== sourceNavigationRequestRef.current) return;
        const detail = formatCommandError(asCommandError(error));
        logger.warn('Could not resolve CSS variable source navigation target', {
          file: source.file,
          selector: source.selector,
          line: source.line,
          error: detail,
        });
        showToast(`Couldn't resolve the matching CSS rule in ${source.file}: ${detail}`, 'error');
      }
    },
    [onOpenInCode, projectPath, showToast]
  );

  return (
    <div
      className={`ss-edit-panel ss-variables-panel ss-variables-panel--dockable${
        pinned ? ' ss-edit-panel--pinned' : ''
      }`}
      data-testid="variables-panel"
    >
      <div className="ss-edit-panel__header" data-dockable-drag-handle>
        <span className="ss-edit-panel__title workspace-panel-title">Variables</span>
        <span className="ss-edit-panel__header-actions">
          {onTogglePin && (
            <ToggleButton
              variant="ghost"
              size="compact"
              className="button--icon-only panel-pin-toggle"
              onClick={onTogglePin}
              title={pinned ? 'Unpin — float over the preview' : 'Pin to the window'}
              aria-label={pinned ? 'Unpin Variables panel' : 'Pin Variables panel to the window'}
              pressed={pinned}
              leftIcon={<PinIcon size={13} />}
            />
          )}
          <IconButton
            variant="ghost"
            size="compact"
            onClick={onClose}
            title="Close Variables panel"
            aria-label="Close Variables panel"
            icon={<CloseIcon size={14} />}
          />
        </span>
      </div>

      <div className="ss-edit-panel__body">
        <CssVariablesPanel
          variables={variablesState.variables}
          loading={variablesState.loading}
          variableNames={variableNames}
          onSetValue={variablesState.setValue}
          onAddVariable={(name, value) => void variablesState.addVariable(name, value)}
          onAnalyzeDelete={(variable) =>
            variablesState.analyzeDeletion(variable.name, variable.value)
          }
          onDeleteVariable={(variable, impact) =>
            variablesState.deleteVariable(variable.name, variable.value, impact)
          }
          onReorderVariables={variablesState.reorderVariables}
          projectPath={projectPath}
          onOpenSource={
            onOpenInCode
              ? (source) => {
                  void openVariableSourceInCode(source);
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}
