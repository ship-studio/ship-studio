/**
 * LanguagesModal — multilingual (i18n) setup for Next.js (Pages Router) and
 * Astro projects.
 *
 * Reads/writes the framework's built-in i18n config via the Rust i18n
 * commands. When the config can't be edited safely (App Router, wrapped
 * configs), falls back to handing a setup prompt to the embedded AI agent.
 *
 * @module components/LanguagesModal
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { useModal } from '../contexts/ModalContext';
import { useAsyncState } from '../hooks/useAsyncState';
import { useOptionalToast } from '../contexts/ToastContext';
import { GlobeIcon, SpinnerIcon, CloseIcon } from './icons';
import { asCommandError, formatCommandError } from '../lib/errors';
import { trackEvent } from '../lib/analytics';
import {
  getI18nStatus,
  setI18nConfig,
  buildTranslatePrompt,
  buildAiSetupPrompt,
  localeDisplayName,
  LOCALE_CATALOG,
  type I18nStatus,
} from '../lib/i18n';

interface LanguagesModalProps {
  projectPath: string;
  /** Hands a prompt to the embedded agent terminal (translate / AI fallback). */
  onSendToClaude?: (prompt: string) => void;
  agentDisplayName?: string;
}

export function LanguagesModal({
  projectPath,
  onSendToClaude,
  agentDisplayName = 'Claude',
}: LanguagesModalProps) {
  const { isOpen, close: onClose } = useModal('i18n');
  const { showToast } = useOptionalToast();

  const {
    data: status,
    isLoading,
    error: loadError,
    execute: loadStatus,
    setData: setStatus,
  } = useAsyncState<I18nStatus>(() => getI18nStatus(projectPath));

  const [draftLocales, setDraftLocales] = useState<string[]>(['en']);
  const [draftDefault, setDraftDefault] = useState('en');
  const [addSelection, setAddSelection] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** True when the save failed because the config can't be edited safely. */
  const [needsAiFallback, setNeedsAiFallback] = useState(false);

  const resetDraft = useCallback((s: I18nStatus | null) => {
    const locales = s && s.locales.length > 0 ? s.locales : ['en'];
    setDraftLocales(locales);
    setDraftDefault(
      s?.defaultLocale && locales.includes(s.defaultLocale) ? s.defaultLocale : locales[0]
    );
  }, []);

  useEffect(() => {
    if (!isOpen || !projectPath) return;
    setSaveError(null);
    setNeedsAiFallback(false);
    setAddSelection('');
    void loadStatus().then((s) => resetDraft(s));
  }, [isOpen, projectPath, loadStatus, resetDraft]);

  const isDirty = useMemo(() => {
    if (!status) return false;
    const saved = status.locales.length > 0 ? status.locales : ['en'];
    const savedDefault = status.defaultLocale ?? saved[0];
    return (
      !status.configured ||
      draftDefault !== savedDefault ||
      draftLocales.length !== saved.length ||
      draftLocales.some((l, i) => l !== saved[i])
    );
  }, [status, draftLocales, draftDefault]);

  const availableToAdd = useMemo(
    () => LOCALE_CATALOG.filter((l) => !draftLocales.includes(l.code)),
    [draftLocales]
  );

  const handleAdd = () => {
    if (!addSelection || draftLocales.includes(addSelection)) return;
    setDraftLocales([...draftLocales, addSelection]);
    setAddSelection('');
  };

  const handleRemove = (code: string) => {
    if (code === draftDefault) return;
    setDraftLocales(draftLocales.filter((l) => l !== code));
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    setNeedsAiFallback(false);
    try {
      const updated = await setI18nConfig(projectPath, draftLocales, draftDefault);
      setStatus(updated);
      resetDraft(updated);
      void trackEvent('i18n_config_saved', { locale_count: draftLocales.length });
      showToast('Language settings saved', 'success');
    } catch (err) {
      const cmdErr = asCommandError(err);
      setSaveError(formatCommandError(cmdErr));
      if (cmdErr.type === 'Validation' && cmdErr.field === 'config') {
        setNeedsAiFallback(true);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const sendPrompt = (prompt: string, toast: string) => {
    if (!onSendToClaude) return;
    onSendToClaude(prompt);
    showToast(toast, 'success');
    onClose();
  };

  const handleTranslate = () => {
    if (!status) return;
    void trackEvent('i18n_translate_requested', {
      locale_count: status.locales.length,
      framework: status.framework,
    });
    sendPrompt(buildTranslatePrompt(status), `Translation request sent to ${agentDisplayName}`);
  };

  const handleAiFallback = () => {
    if (!status) return;
    void trackEvent('i18n_ai_fallback_used', { framework: status.framework });
    sendPrompt(buildAiSetupPrompt(status), `Setup request sent to ${agentDisplayName}`);
  };

  if (!isOpen) return null;

  const translateTargets = status?.locales.filter((l) => l !== status.defaultLocale) ?? [];

  return (
    <ModalFrame isOpen onClose={onClose} title="Languages" className="languages-modal">
      {isLoading && (
        <div className="languages-loading">
          <SpinnerIcon size={16} />
          <span>Checking project…</span>
        </div>
      )}

      {!isLoading && loadError && (
        <div className="languages-error">Couldn't check this project's language setup.</div>
      )}

      {!isLoading && status && !status.supported && (
        <div className="languages-unsupported">
          <div className="languages-unsupported-icon">
            <GlobeIcon size={28} />
          </div>
          <p>{status.unsupportedReason}</p>
          {status.framework === 'nextjs-app' && onSendToClaude && (
            <Button variant="secondary" onClick={handleAiFallback}>
              Ask {agentDisplayName} to set it up
            </Button>
          )}
        </div>
      )}

      {!isLoading && status && status.supported && (
        <div className="languages-editor">
          {!status.configured && (
            <p className="languages-intro">
              Make your site available in multiple languages. Pick the languages you want to support
              — visitors get routed automatically (e.g. <code>/fr/about</code>).
            </p>
          )}

          <div className="languages-field">
            <label htmlFor="languages-default-select">Default language</label>
            <select
              id="languages-default-select"
              value={draftDefault}
              onChange={(e) => setDraftDefault(e.target.value)}
            >
              {draftLocales.map((code) => (
                <option key={code} value={code}>
                  {localeDisplayName(code)} ({code})
                </option>
              ))}
            </select>
          </div>

          <div className="languages-field">
            <label>Languages</label>
            <div className="languages-chips">
              {draftLocales.map((code) => (
                <span
                  key={code}
                  className={`languages-chip${code === draftDefault ? ' languages-chip-default' : ''}`}
                >
                  {localeDisplayName(code)}
                  <span className="languages-chip-code">{code}</span>
                  {code === draftDefault ? (
                    <span className="languages-chip-badge">default</span>
                  ) : (
                    <button
                      type="button"
                      className="languages-chip-remove"
                      onClick={() => handleRemove(code)}
                      aria-label={`Remove ${localeDisplayName(code)}`}
                    >
                      <CloseIcon size={10} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>

          <div className="languages-add-row">
            <select
              aria-label="Add a language"
              value={addSelection}
              onChange={(e) => setAddSelection(e.target.value)}
            >
              <option value="">Add a language…</option>
              {availableToAdd.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
            <Button variant="secondary" size="sm" onClick={handleAdd} disabled={!addSelection}>
              Add
            </Button>
          </div>

          {status.parseWarning && <div className="languages-note">{status.parseWarning}</div>}

          {saveError && (
            <div className="languages-error">
              {saveError}
              {needsAiFallback && onSendToClaude && (
                <Button variant="secondary" size="sm" onClick={handleAiFallback}>
                  Ask {agentDisplayName} to set it up
                </Button>
              )}
            </div>
          )}

          <div className="languages-actions">
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={!isDirty || isSaving}
            >
              {isSaving ? 'Saving…' : status.configured ? 'Save changes' : 'Enable languages'}
            </Button>
          </div>

          {status.configured && translateTargets.length > 0 && onSendToClaude && (
            <div className="languages-translate">
              <div className="languages-translate-text">
                <strong>Translate your pages</strong>
                <span>
                  Ask {agentDisplayName} to translate your site into{' '}
                  {translateTargets.map((l) => localeDisplayName(l)).join(', ')}.
                </span>
              </div>
              <Button variant="secondary" onClick={handleTranslate} disabled={isDirty}>
                Translate with AI
              </Button>
            </div>
          )}
          {status.configured && translateTargets.length > 0 && isDirty && (
            <div className="languages-note">Save your changes before translating.</div>
          )}
        </div>
      )}
    </ModalFrame>
  );
}
