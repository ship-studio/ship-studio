/** Standalone project-level CSS variables panel. */

import { CloseIcon, PinIcon } from '@/components/icons';
import type { useCssVariables } from '../../hooks/useCssVariables';
import { IconButton } from '../primitives/IconButton';
import { ToggleButton } from '../primitives/ToggleButton';
import { CssVariablesPanel } from './CssVariablesPanel';

interface VariablesPanelProps {
  variablesState: ReturnType<typeof useCssVariables>;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}

/** Shared panel chrome for the project-wide Variables editor. */
export function VariablesPanel({
  variablesState,
  onClose,
  pinned = false,
  onTogglePin,
}: VariablesPanelProps) {
  const variableNames = [...new Set(variablesState.variables.map((variable) => variable.name))];

  return (
    <div
      className={`ss-edit-panel ss-variables-panel ss-variables-panel--dockable${
        pinned ? ' ss-edit-panel--pinned' : ''
      }`}
      data-testid="variables-panel"
    >
      <div className="ss-edit-panel__header" data-dockable-drag-handle>
        <span className="ss-edit-panel__title">Variables</span>
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
        />
      </div>
    </div>
  );
}
