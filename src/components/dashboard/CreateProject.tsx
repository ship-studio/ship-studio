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

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { CheckIcon, CloseIcon, FileIcon, PendingCircleIcon, UploadIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import {
  useProjectCreation,
  TEMPLATES,
  TEMPLATE_GROUPS,
  STEPS,
  STATUS_MESSAGES,
} from '../../hooks/useProjectCreation';
import { useAsyncState } from '../../hooks/useAsyncState';
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
  const [communitySearch, setCommunitySearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Debounce search input — hit the API server-side
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(communitySearch), 300);
    return () => clearTimeout(timer);
  }, [communitySearch]);

  // Fetch templates from API (server-side search). The search term is an
  // argument, not a closure, so `execute` stays stable across keystrokes.
  const {
    data: fetchedTemplates,
    isLoading: isFetchingTemplates,
    error: fetchTemplatesError,
    execute: fetchTemplates,
  } = useAsyncState<CommunityTemplate[], [string]>(
    async (search: string) => {
      const params: Record<string, string | number> = {};
      if (search) params.search = search;
      const raw = await invoke<string>('fetch_community_templates', params);
      return (JSON.parse(raw) as { templates: CommunityTemplate[] }).templates;
    },
    {
      onError: (err) => {
        // The backend classifies these Expected (offline / API unreachable), so
        // warn rather than error — but the user must still be told the fetch
        // failed instead of being shown "No templates found" (issue #754).
        logger.warn('[CreateProject] Failed to fetch community templates', { error: err.message });
      },
    }
  );

  /**
   * Set when the fetch itself failed (offline, API down, parse error) so the
   * gallery can say so and offer a retry, instead of the identical-looking
   * "No templates found" the search-miss case shows (issue #754).
   */
  const communityError = fetchTemplatesError?.message ?? null;
  // A failed fetch shows the error, never a stale list from an earlier search.
  const communityTemplates = communityError ? [] : (fetchedTemplates ?? []);
  // `data === null` means the first fetch hasn't landed yet — still loading, so
  // the first paint is skeletons rather than a momentary "No templates found".
  const communityLoading =
    isFetchingTemplates || (fetchedTemplates === null && fetchTemplatesError === null);

  // Fetch on mount and when search changes
  useEffect(() => {
    void fetchTemplates(debouncedSearch);
  }, [fetchTemplates, debouncedSearch]);

  // Re-fetch every 50 minutes to keep signed zip_urls fresh (they expire after 1 hour)
  useEffect(() => {
    const interval = setInterval(() => void fetchTemplates(debouncedSearch), 50 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchTemplates, debouncedSearch]);

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
        const detail = formatCommandError(asCommandError(err));
        logger.error('Failed to download community template', {
          template: selectedCommunityTemplate.name,
          error: detail,
        });
        setError(
          `Couldn't download "${selectedCommunityTemplate.name}": ${detail}. ` +
            'Check your connection and try again.'
        );
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
                    <CheckIcon size={18} />
                  ) : status === 'active' ? (
                    <Spinner />
                  ) : (
                    <PendingCircleIcon size={18} />
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
              <CloseIcon size={20} />
            </button>
          </div>

          <Tabs value={activeTab} onValueChange={(next) => setActiveTab(next as typeof activeTab)}>
            <TabsList className="create-tabs" variant="stretch" aria-label="Project source">
              <TabsTab value="scratch" className="create-tab">
                Start from Scratch
              </TabsTab>
              <TabsTab value="template" className="create-tab">
                Start from Template
              </TabsTab>
            </TabsList>

            <TabsPanel value="scratch" className="create-tab-panel">
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
                              onSelect={() => {
                                handleTemplateSelect(template);
                                setSetAsDefaultChecked(false);
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}

                  {selectedTemplate &&
                    selectedTemplate.id !== defaultTemplateId &&
                    !hasZipTemplate && (
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
            </TabsPanel>

            <TabsPanel value="template" className="create-tab-panel">
              {activeTab === 'template' && (
                <>
                  <TemplateGallery
                    templates={communityTemplates}
                    loading={communityLoading}
                    onSelect={handleCommunitySelect}
                    selectedId={selectedCommunityId}
                    searchQuery={communitySearch}
                    onSearchChange={setCommunitySearch}
                    loadError={communityError}
                    onRetry={() => void fetchTemplates(debouncedSearch)}
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
                        <FileIcon size={20} />
                        <span>{displayZipName}</span>
                      </div>
                      <button
                        type="button"
                        className="template-zip-remove"
                        onClick={handleRemoveZip}
                      >
                        <CloseIcon size={16} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </TabsPanel>
          </Tabs>

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
            <CloseIcon size={20} />
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
