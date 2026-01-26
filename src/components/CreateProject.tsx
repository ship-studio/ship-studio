/**
 * CreateProject component that provides a wizard for creating new projects.
 *
 * This is a multi-step wizard that:
 * 1. Lets user select a project template
 * 2. Lets user enter a project name
 * 3. Shows progress while cloning, initializing, and installing dependencies
 *
 * Uses Tauri PTY for running git clone and npm install with progress events.
 *
 * @module components/CreateProject
 */

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

/** Props for the CreateProject component */
interface CreateProjectProps {
  /** Callback when project creation completes successfully */
  onComplete: (projectPath: string) => void;
  /** Callback when user cancels the wizard */
  onCancel: () => void;
}

/** Template definition for project scaffolding */
interface Template {
  /** Unique identifier for the template */
  id: string;
  /** Display name */
  name: string;
  /** Short description of what the template includes */
  description: string;
  /** GitHub repository URL to clone */
  repo: string;
}

/** Available project templates */
const TEMPLATES: Template[] = [
  {
    id: 'nextjs-basic',
    name: 'Next.js Basic',
    description: 'A minimal Next.js starter with Tailwind CSS',
    repo: 'https://github.com/ship-studio/static-marketing-site-starter',
  },
];

/** Form wizard steps before creation starts */
type FormStep = 'select-template' | 'enter-name';
/** Creation progress steps */
type Step = 'clone' | 'init' | 'install' | 'done';

/** Step definitions with display labels */
const STEPS: { id: Step; label: string }[] = [
  { id: 'clone', label: 'Clone template' },
  { id: 'init', label: 'Initialize project' },
  { id: 'install', label: 'Install dependencies' },
  { id: 'done', label: 'Done' },
];

/** User-facing status messages for each creation step */
const STATUS_MESSAGES: Record<Step, string> = {
  clone: 'Downloading template...',
  init: 'Setting up project...',
  install: 'Installing dependencies... This may take a minute.',
  done: 'Almost done...',
};

export function CreateProject({ onComplete, onCancel }: CreateProjectProps) {
  const [formStep, setFormStep] = useState<FormStep>('select-template');
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [projectName, setProjectName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [currentStep, setCurrentStep] = useState<Step>('clone');
  const [error, setError] = useState<string | null>(null);

  const waitForPtyExit = async (targetId: number): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      let unlisten: UnlistenFn | null = null;

      void listen<{ id: number; code: number | null }>('pty-exit', (event) => {
        if (event.payload.id === targetId) {
          unlisten?.();
          if (event.payload.code === 0 || event.payload.code === null) {
            resolve(event.payload.code);
          } else {
            reject(new Error(`Process exited with code ${event.payload.code}`));
          }
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });
  };

  const handleCreate = async () => {
    if (!selectedTemplate) {
      setError('Please select a template');
      return;
    }

    if (!projectName.trim()) {
      setError('Please enter a project name');
      return;
    }

    const safeName = projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!safeName) {
      setError('Invalid project name');
      return;
    }

    // Check for duplicate project names
    try {
      const existingProjects = await invoke<{ name: string; path: string }[]>('list_projects');
      const duplicate = existingProjects.find(
        (p) => p.name.toLowerCase() === safeName.toLowerCase()
      );
      if (duplicate) {
        setError(`A project named "${safeName}" already exists`);
        return;
      }
    } catch {
      // If we can't check, proceed anyway
    }

    setIsCreating(true);
    setError(null);
    setCurrentStep('clone');

    try {
      // Ensure ShipStudio directory exists
      const shipstudioDir = await invoke<string>('ensure_shipstudio_dir');
      const projectPath = `${shipstudioDir}/${safeName}`;

      // Clone template
      const cloneId = await invoke<number>('spawn_pty', {
        options: {
          cwd: shipstudioDir,
          command: 'git',
          args: ['clone', selectedTemplate.repo, safeName],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(cloneId);

      // Remove .git folder so project starts fresh (not connected to template repo)
      setCurrentStep('init');
      const rmGitId = await invoke<number>('spawn_pty', {
        options: {
          cwd: projectPath,
          command: 'rm',
          args: ['-rf', '.git'],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(rmGitId);

      // Ensure .shipstudio/ is gitignored to prevent phantom changes
      await invoke('ensure_gitignore_has_shipstudio', { projectPath: projectPath });

      // Install dependencies
      setCurrentStep('install');
      const installId = await invoke<number>('spawn_pty', {
        options: {
          cwd: projectPath,
          command: 'npm',
          args: ['install'],
          rows: 10,
          cols: 80,
        },
      });

      await waitForPtyExit(installId);

      setCurrentStep('done');

      // Small delay before opening
      await new Promise((r) => setTimeout(r, 800));
      onComplete(projectPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const getStepStatus = (stepId: Step): 'pending' | 'active' | 'done' => {
    const stepOrder = STEPS.map((s) => s.id);
    const currentIndex = stepOrder.indexOf(currentStep);
    const stepIndex = stepOrder.indexOf(stepId);

    if (stepIndex < currentIndex) return 'done';
    if (stepIndex === currentIndex) return 'active';
    return 'pending';
  };

  const handleTemplateSelect = (template: Template) => {
    setSelectedTemplate(template);
  };

  const handleContinue = () => {
    if (selectedTemplate) {
      setFormStep('enter-name');
      setError(null);
    }
  };

  const handleBack = () => {
    setFormStep('select-template');
    setError(null);
  };

  const renderContent = () => {
    // Creating state - show progress
    if (isCreating) {
      return (
        <div className="create-modal-content creating">
          <h2>Creating "{projectName}"</h2>

          <div className="create-spinner" />

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
                    <div className="checklist-spinner" />
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
              <p>{error}</p>
              <button onClick={onCancel}>Close</button>
            </div>
          )}
        </div>
      );
    }

    // Template selection step
    if (formStep === 'select-template') {
      return (
        <div className="create-modal-content">
          <div className="create-modal-header">
            <div>
              <h2>New Project</h2>
              <p>Select a starting point</p>
            </div>
            <button className="create-modal-close" onClick={onCancel} type="button">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="template-grid">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`template-card ${selectedTemplate?.id === template.id ? 'selected' : ''}`}
                onClick={() => handleTemplateSelect(template)}
              >
                <h3>{template.name}</h3>
                <p>{template.description}</p>
              </button>
            ))}
          </div>

          <div className="create-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!selectedTemplate}
              onClick={handleContinue}
            >
              Continue
            </button>
          </div>
        </div>
      );
    }

    // Name entry step
    return (
      <div className="create-modal-content">
        <div className="create-modal-header">
          <div>
            <h2>New Project</h2>
            <p className="template-context">
              Using <strong>{selectedTemplate?.name}</strong>
            </p>
          </div>
          <button className="create-modal-close" onClick={onCancel} type="button">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <label>
            Project Name
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="my-awesome-site"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>

          {error && <p className="error">{error}</p>}

          <div className="create-actions">
            <button type="button" onClick={handleBack}>
              Back
            </button>
            <button type="submit" className="btn-primary">
              Create Project
            </button>
          </div>
        </form>
      </div>
    );
  };

  return (
    <div
      className="create-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isCreating) {
          onCancel();
        }
      }}
    >
      <div className="create-modal">{renderContent()}</div>
    </div>
  );
}
