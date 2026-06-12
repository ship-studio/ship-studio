/**
 * Step3ImportProgress — third wizard step for ImportProject. Shows progress
 * while cloning, installing dependencies, and finalizing project setup.
 *
 * @module components/import-project/steps/Step3ImportProgress
 */

import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';

/** Import progress steps */
export type Step = 'clone' | 'install' | 'setup' | 'done';

/** Step definitions with display labels */
export const STEPS: { id: Step; label: string }[] = [
  { id: 'clone', label: 'Clone repository' },
  { id: 'install', label: 'Install dependencies' },
  { id: 'setup', label: 'Setup project' },
  { id: 'done', label: 'Done' },
];

/** User-facing status messages for each import step */
export const STATUS_MESSAGES: Record<Step, string> = {
  clone: 'Cloning repository...',
  install: 'Installing dependencies... This may take a minute.',
  setup: 'Setting up project...',
  done: 'Almost done...',
};

export interface Step3ImportProgressProps {
  repoName: string;
  currentStep: Step;
  error: string | null;
  importedProjectPath: string | null;
  onRetryInstall: () => void;
  onCancel: () => void;
}

export function Step3ImportProgress({
  repoName,
  currentStep,
  error,
  importedProjectPath,
  onRetryInstall,
  onCancel,
}: Step3ImportProgressProps) {
  const getStepStatus = (stepId: Step): 'pending' | 'active' | 'done' => {
    const stepOrder = STEPS.map((s) => s.id);
    const currentIndex = stepOrder.indexOf(currentStep);
    const stepIndex = stepOrder.indexOf(stepId);

    if (stepIndex < currentIndex) return 'done';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  return (
    <div className="create-modal-content creating">
      <h2>Importing "{repoName}"</h2>

      <Spinner size="lg" className="create-spinner" />

      <p className="create-status">{STATUS_MESSAGES[currentStep]}</p>

      <div className="create-checklist">
        {STEPS.slice(0, -1).map((step) => {
          const status = getStepStatus(step.id);
          return (
            <div key={step.id} className={`checklist-item ${status}`}>
              {status === 'done' ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : status === 'active' ? (
                <Spinner />
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                </svg>
              )}
              <span>{step.label}</span>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="create-error">
          <p style={{ whiteSpace: 'pre-line', maxHeight: '200px', overflowY: 'auto' }}>{error}</p>
          <div style={{ display: 'flex', gap: '8px' }}>
            {currentStep === 'install' && importedProjectPath && (
              <Button variant="primary" onClick={onRetryInstall}>
                Retry
              </Button>
            )}
            <Button variant="secondary" onClick={onCancel}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
