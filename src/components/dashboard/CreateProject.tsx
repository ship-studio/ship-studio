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

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { trackEvent } from '../../lib/analytics';
import { logger } from '../../lib/logger';
import { UploadIcon } from '../icons';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import {
  useProjectCreation,
  TEMPLATES,
  TEMPLATE_GROUPS,
  STEPS,
  STATUS_MESSAGES,
} from '../../hooks/useProjectCreation';
import { TemplateGallery, type CommunityTemplate } from './TemplateGallery';
import { TemplateCard } from './TemplateCard';

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
    setZipPath,
    setZipFileName,
    setError,
    saveDefaultTemplate,
    defaultTemplateId,
  } = useProjectCreation({ onComplete, onCancel });

  const [setAsDefaultChecked, setSetAsDefaultChecked] = useState(false);

  // Tab state: "scratch" = start from scratch, "template" = community templates
  const [activeTab, setActiveTab] = useState<'scratch' | 'template'>('scratch');

  // Community templates from API
  const [communityTemplates, setCommunityTemplates] = useState<CommunityTemplate[]>([]);
  const [communityLoading, setCommunityLoading] = useState(true);
  const [communitySearch, setCommunitySearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Debounce search input — hit the API server-side
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(communitySearch), 300);
    return () => clearTimeout(timer);
  }, [communitySearch]);

  // Fetch templates from API (server-side search)
  const fetchTemplates = useCallback(() => {
    setCommunityLoading(true);
    const params: Record<string, string | number> = {};
    if (debouncedSearch) params.search = debouncedSearch;
    invoke<string>('fetch_community_templates', params)
      .then((raw) => {
        const data = JSON.parse(raw) as { templates: CommunityTemplate[] };
        setCommunityTemplates(data.templates);
      })
      .catch(() => {
        // Silently fail — user sees empty state
      })
      .finally(() => setCommunityLoading(false));
  }, [debouncedSearch]);

  // Fetch on mount and when search changes
  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  // Re-fetch every 50 minutes to keep signed zip_urls fresh (they expire after 1 hour)
  useEffect(() => {
    const interval = setInterval(fetchTemplates, 50 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchTemplates]);

  const handleCommunitySelect = (template: CommunityTemplate) => {
    setSelectedCommunityId(template.id === selectedCommunityId ? null : template.id);
  };

  const selectedCommunityTemplate =
    communityTemplates.find((t) => t.id === selectedCommunityId) ?? null;

  const handleContinue = async () => {
    if (activeTab === 'scratch') {
      if (setAsDefaultChecked && selectedTemplate) {
        saveDefaultTemplate(selectedTemplate.id);
      }
      rawHandleContinue();
      return;
    }

    // Template tab — community template selected
    if (selectedCommunityTemplate?.zip_url) {
      setDownloading(true);
      try {
        const tempPath = await invoke<string>('download_template_zip', {
          url: selectedCommunityTemplate.zip_url,
        });
        setZipPath(tempPath);
        setZipFileName(selectedCommunityTemplate.name + '.zip');
        rawHandleContinue();
      } catch (err) {
        // Surface the failure (don't block the modal) — a silent catch left the
        // button snapping back to "Continue" with no explanation.
        logger.error('Failed to download community template', { error: err });
        setError("Couldn't download that template. Check your connection and try again.");
      } finally {
        setDownloading(false);
      }
      return;
    }

    // Template tab — zip upload selected
    if (hasZipTemplate) {
      rawHandleContinue();
    }
  };

  const renderContent = () => {
    // Creating state - show progress
    if (isCreating) {
      return (
        <div className="create-modal-content creating">
          <h2>Creating "{projectName}"</h2>

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
              <p style={{ whiteSpace: 'pre-line', maxHeight: '200px', overflowY: 'auto' }}>
                {error}
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                {currentStep === 'install' && createdProjectPath && (
                  <Button variant="primary" onClick={() => void retryInstall()}>
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

          <div className="create-tabs">
            <button
              type="button"
              className={`create-tab ${activeTab === 'scratch' ? 'active' : ''}`}
              onClick={() => setActiveTab('scratch')}
            >
              Start from Scratch
            </button>
            <button
              type="button"
              className={`create-tab ${activeTab === 'template' ? 'active' : ''}`}
              onClick={() => setActiveTab('template')}
            >
              Start from Template
            </button>
          </div>

          {activeTab === 'scratch' && (
            <>
              {TEMPLATE_GROUPS.map((group) => {
                const groupTemplates = TEMPLATES.filter((t) => t.category === group.id);
                if (groupTemplates.length === 0) return null;
                return (
                  <div key={group.id} className="stack-group">
                    <h3 className="stack-group-title">{group.label}</h3>
                    <div className="stack-grid">
                      {groupTemplates.map((template) => (
                        <TemplateCard
                          key={template.id}
                          name={template.name}
                          description={template.description}
                          selected={selectedTemplate?.id === template.id && !hasZipTemplate}
                          recommended={template.id === defaultTemplateId}
                          onSelect={() => {
                            handleTemplateSelect(template);
                            void trackEvent('template_selected', {
                              template_id: template.id,
                              $screen_name: 'Create Project',
                            });
                            setSetAsDefaultChecked(false);
                          }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {selectedTemplate && selectedTemplate.id !== defaultTemplateId && !hasZipTemplate && (
                <button
                  type="button"
                  className={`template-default-toggle ${setAsDefaultChecked ? 'active' : ''}`}
                  onClick={() => setSetAsDefaultChecked(!setAsDefaultChecked)}
                >
                  {setAsDefaultChecked ? 'Will be your default' : 'Set as default?'}
                </button>
              )}
            </>
          )}

          {activeTab === 'template' && (
            <>
              <TemplateGallery
                templates={communityTemplates}
                loading={communityLoading}
                onSelect={handleCommunitySelect}
                selectedId={selectedCommunityId}
                searchQuery={communitySearch}
                onSearchChange={setCommunitySearch}
              />

              <div className="template-divider">
                <span>or upload a template</span>
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
            </>
          )}

          {error && <p className="error">{error}</p>}

          <div className="create-actions">
            <Button variant="secondary" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={
                downloading ||
                (activeTab === 'scratch'
                  ? !selectedTemplate && !hasZipTemplate
                  : !selectedCommunityId && !hasZipTemplate)
              }
              onClick={() => void handleContinue()}
            >
              {downloading ? 'Downloading...' : 'Continue'}
            </Button>
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
            <Button variant="secondary" type="button" onClick={handleBack}>
              Back
            </Button>
            <Button variant="primary" type="submit">
              Create Project
            </Button>
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
