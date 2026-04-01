/**
 * CreateProject component that provides a wizard for creating new projects.
 *
 * This is a multi-step wizard that:
 * 1. Lets user select a project template (built-in or from zip file)
 * 2. Lets user enter a project name
 * 3. Shows progress while cloning, initializing, and installing dependencies
 *
 * Uses Tauri PTY for running git clone and npm install with progress events.
 *
 * @module components/CreateProject
 */

import { useState, useRef } from 'react';
import { trackEvent } from '../lib/analytics';
import { UploadIcon } from './icons';
import { useProjectCreation, TEMPLATES, STEPS, STATUS_MESSAGES } from '../hooks/useProjectCreation';
import { useClickOutside } from '../hooks/useClickOutside';

/** Props for the CreateProject component */
interface CreateProjectProps {
  /** Callback when project creation completes successfully */
  onComplete: (projectPath: string) => void;
  /** Callback when user cancels the wizard */
  onCancel: () => void;
}

export function CreateProject({ onComplete, onCancel }: CreateProjectProps) {
  const {
    formStep,
    selectedTemplate,
    projectName,
    setProjectName,
    isCreating,
    currentStep,
    error,
    createdProjectPath,
    isDragging,
    fileInputRef,
    dropZoneRef,
    hasZipTemplate,
    displayZipName,
    handleCreate,
    handleCreateFromZip,
    handleTemplateSelect,
    handleContinue: rawHandleContinue,
    handleBack,
    retryInstall,
    getStepStatus,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    handleRemoveZip,
    saveDefaultTemplate,
    defaultTemplateId,
  } = useProjectCreation({ onComplete, onCancel });

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [setAsDefaultChecked, setSetAsDefaultChecked] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(dropdownRef, () => setDropdownOpen(false), dropdownOpen);

  const handleContinue = () => {
    if (setAsDefaultChecked && selectedTemplate) {
      saveDefaultTemplate(selectedTemplate.id);
    }
    rawHandleContinue();
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
              <p style={{ whiteSpace: 'pre-line', maxHeight: '200px', overflowY: 'auto' }}>
                {error}
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                {currentStep === 'install' && createdProjectPath && (
                  <button className="btn-primary" onClick={() => void retryInstall()}>
                    Retry
                  </button>
                )}
                <button onClick={onCancel}>Close</button>
              </div>
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

          <div className="template-select-wrapper" ref={dropdownRef}>
            <button
              type="button"
              className={`template-select-trigger ${hasZipTemplate ? 'dimmed' : ''}`}
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              <span>{selectedTemplate?.name ?? 'Select a template'}</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{
                  transform: dropdownOpen ? 'rotate(180deg)' : undefined,
                  transition: 'transform 0.15s',
                }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {dropdownOpen && (
              <div className="template-select-menu">
                {TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`template-select-option ${selectedTemplate?.id === template.id && !hasZipTemplate ? 'selected' : ''}`}
                    onClick={() => {
                      handleTemplateSelect(template);
                      void trackEvent('template_selected', {
                        template_id: template.id,
                        $screen_name: 'Create Project',
                      });
                      setDropdownOpen(false);
                      setSetAsDefaultChecked(false);
                    }}
                  >
                    <div className="template-option-text">
                      <span className="template-option-name">{template.name}</span>
                      <span className="template-option-desc">{template.description}</span>
                    </div>
                    {selectedTemplate?.id === template.id && !hasZipTemplate && (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedTemplate && selectedTemplate.id !== defaultTemplateId && !hasZipTemplate && (
            <button
              type="button"
              className={`template-default-toggle ${setAsDefaultChecked ? 'active' : ''}`}
              onClick={() => setSetAsDefaultChecked(!setAsDefaultChecked)}
            >
              {setAsDefaultChecked ? 'Will be your default' : 'Set as default?'}
            </button>
          )}

          <div className="template-divider">
            <span>or use a template</span>
          </div>

          {!hasZipTemplate ? (
            <div
              ref={dropZoneRef}
              className={`template-dropzone ${isDragging ? 'dragging' : ''}`}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
              <UploadIcon size={24} />
              <p>Drop a template .zip file here</p>
              <span>or click to browse</span>
            </div>
          ) : (
            <div className="template-zip-selected">
              <div className="template-zip-info">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span>{displayZipName}</span>
              </div>
              <button type="button" className="template-zip-remove" onClick={handleRemoveZip}>
                <svg
                  width="16"
                  height="16"
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
          )}

          {error && <p className="error">{error}</p>}

          <div className="create-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!selectedTemplate && !hasZipTemplate}
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
              Using{' '}
              <strong>
                {hasZipTemplate ? displayZipName?.replace('.zip', '') : selectedTemplate?.name}
              </strong>
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
            if (hasZipTemplate) {
              void handleCreateFromZip();
            } else {
              void handleCreate();
            }
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
