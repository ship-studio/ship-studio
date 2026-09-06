/** Preview diagnostics, kept mounted while switching tabs. */
import { forwardRef, useState, type RefObject } from 'react';
import { DevServerLogs } from '../terminal/DevServerLogs';
import { BrowserTools } from './BrowserTools';
import { HealthTabPanel, type HealthTabPanelRef } from '../code/HealthTabPanel';
import { IconButton } from '../primitives/IconButton';
import { CloseIcon } from '@/components/icons';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
export type InspectTab = 'logs' | 'browser' | 'health';

interface InspectPanelProps {
  hidden: boolean;
  projectPath: string;
  devServerOutput: string;
  devServerOutputVersion: number;
  onClose?: () => void;
  onSendToAgent?: (text: string) => void;
  /** Controlled tab. When set, the component is fully controlled. */
  activeTab?: InspectTab;
  onActiveTabChange?: (tab: InspectTab) => void;
  healthPanelRef?: RefObject<HealthTabPanelRef | null>;
  onHealthOutput?: (data: string) => void;
  /** Type into the dev-server PTY — answers interactive CLI prompts. */
  onDevServerInput?: (data: string) => void;
  /** Sync the dev-server PTY size to the logs terminal. */
  onDevServerResize?: (cols: number, rows: number) => void;
}

export const InspectPanel = forwardRef<HTMLDivElement, InspectPanelProps>(function InspectPanel(
  {
    hidden,
    projectPath,
    devServerOutput,
    devServerOutputVersion,
    onClose,
    onSendToAgent,
    activeTab: activeTabProp,
    onActiveTabChange,
    healthPanelRef,
    onHealthOutput,
    onDevServerInput,
    onDevServerResize,
  },
  ref
) {
  const [activeTabLocal, setActiveTabLocal] = useState<InspectTab>('logs');
  const activeTab = activeTabProp ?? activeTabLocal;
  const setActiveTab = onActiveTabChange ?? setActiveTabLocal;

  return (
    <div ref={ref} className="preview-logs-panel" aria-hidden={hidden}>
      <Tabs value={activeTab} onValueChange={(next) => setActiveTab(next as InspectTab)}>
        <div className="preview-logs-header">
          {/* The underline appearance is the primitive's own — the strip used
              to be a segmented pill list with a hand-rolled underline layered
              over it, which is why the active tab never matched its
              neighbours. */}
          <TabsList
            className="preview-logs-tabs"
            variant="stretch"
            appearance="underline"
            aria-label="Preview diagnostics"
          >
            <TabsTab value="logs" className="preview-logs-tab">
              Server Logs
            </TabsTab>
            <TabsTab value="browser" className="preview-logs-tab">
              Browser Tools
            </TabsTab>
            <TabsTab value="health" className="preview-logs-tab">
              Health
            </TabsTab>
          </TabsList>
          {onClose && (
            <IconButton
              variant="ghost"
              size="compact"
              className="preview-logs-close"
              icon={<CloseIcon size={14} />}
              onClick={onClose}
              title="Hide panel"
              aria-label="Hide panel"
            />
          )}
        </div>
        {/* Both tab contents stay mounted and stack in the same grid cell.
            Toggling `is-active` swaps visibility via CSS (opacity) so
            DevServerLogs doesn't re-init xterm and BrowserTools keeps its
            scroll/state; TabsPanel makes inactive slots inert. */}
        <div className="preview-logs-body">
          <TabsPanel
            value="logs"
            keepMounted
            className={`preview-logs-slot ${activeTab === 'logs' ? 'is-active' : ''}`}
          >
            <DevServerLogs
              output={devServerOutput}
              outputVersion={devServerOutputVersion}
              onSendToAgent={onSendToAgent}
              onInput={onDevServerInput}
              onResize={onDevServerResize}
            />
          </TabsPanel>
          <TabsPanel
            value="browser"
            keepMounted
            className={`preview-logs-slot ${activeTab === 'browser' ? 'is-active' : ''}`}
          >
            <BrowserTools
              onSendToAgent={onSendToAgent}
              active={!hidden && activeTab === 'browser'}
            />
          </TabsPanel>
          <TabsPanel
            value="health"
            keepMounted
            className={`preview-logs-slot ${activeTab === 'health' ? 'is-active' : ''}`}
          >
            <HealthTabPanel
              ref={healthPanelRef}
              projectPath={projectPath}
              onAskClaude={onSendToAgent}
              onHealthOutput={onHealthOutput}
            />
          </TabsPanel>
        </div>
      </Tabs>
    </div>
  );
});
