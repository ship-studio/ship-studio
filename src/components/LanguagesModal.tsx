/**
 * LanguagesModal — multilingual (i18n) setup for Next.js and Astro projects.
 *
 * Three states:
 * - Managed (Next.js Pages Router, Astro, or App Router with next-intl):
 *   pick languages, Ship Studio writes the config directly.
 * - Guided setup (App Router without next-intl): pick languages, the
 *   embedded agent runs a pinned one-time setup, after which the project
 *   becomes managed.
 * - Unsupported: clear explanation.
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
  buildAppRouterSetupPrompt,
  localeDisplayName,
  LOCALE_CATALOG,
  type I18nStatus,
} from '../lib/i18n';

interface LanguagesModalProps {
  projectPath: string;
  /** Hands a prompt to the embedded agent terminal (setup / translate). */
  onSendToClaude?: (prompt: string) => void;
  agentDisplayName?: string;
}

/** Selected languages as rows: name, code, default badge / actions. */
function LanguageRows({
  locales,
  defaultLocale,
  onMakeDefault,
  onRemove,
}: {
  locales: string[];
  defaultLocale: string;
  onMakeDefault: (code: string) => void;
  onRemove: (code: string) => void;
}) {
  return (
    <div className="languages-rows">
      {locales.map((code) => (
        <div key={code} className="languages-row">
          <span className="languages-row-name">{localeDisplayName(code)}</span>
          <span className="languages-row-code">{code}</span>
          <span className="languages-row-actions">
            {code === defaultLocale ? (
              <span className="languages-row-badge">Default</span>
            ) : (
              <>
                <button
                  type="button"
                  className="languages-row-make-default"
                  onClick={() => onMakeDefault(code)}
                >
                  Make default
                </button>
                <button
                  type="button"
                  className="languages-row-remove"
                  onClick={() => onRemove(code)}
                  aria-label={`Remove ${localeDisplayName(code)}`}
                >
                  <CloseIcon size={12} />
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Remaining catalog languages as one-click "+ Language" pills. */
function AddLanguagePills({
  selected,
  onAdd,
}: {
  selected: string[];
  onAdd: (code: string) => void;
}) {
  const available = LOCALE_CATALOG.filter((l) => !selected.includes(l.code));
  if (available.length === 0) return null;
  return (
    <div className="languages-pills">
      {available.map((l) => (
        <button key={l.code} type="button" className="languages-pill" onClick={() => onAdd(l.code)}>
          <span className="languages-pill-plus">+</span> {l.name}
        </button>
      ))}
    </div>
  );
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

  const addLocale = (code: string) => {
    if (!draftLocales.includes(code)) setDraftLocales([...draftLocales, code]);
  };

  const removeLocale = (code: string) => {
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

  const handleAgentSetup = () => {
    void trackEvent('i18n_app_router_setup_started', { locale_count: draftLocales.length });
    sendPrompt(
      buildAppRouterSetupPrompt(draftLocales, draftDefault),
      `Setup started — watch ${agentDisplayName} in the terminal`
    );
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
  const showSetupFlow = !!status && !status.supported && status.agentSetupAvailable;

  const picker = (
    <>
      <div className="languages-section">
        <div className="languages-section-label">Your languages</div>
        <LanguageRows
          locales={draftLocales}
          defaultLocale={draftDefault}
          onMakeDefault={setDraftDefault}
          onRemove={removeLocale}
        />
      </div>
      <div className="languages-section">
        <div className="languages-section-label">Add a language</div>
        <AddLanguagePills selected={draftLocales} onAdd={addLocale} />
      </div>
    </>
  );

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

      {/* Unsupported, no path forward */}
      {!isLoading && status && !status.supported && !showSetupFlow && (
        <div className="languages-unsupported">
          <div className="languages-unsupported-icon">
            <GlobeIcon size={28} />
          </div>
          <p>{status.unsupportedReason}</p>
        </div>
      )}

      {/* App Router: guided one-time setup */}
      {!isLoading && showSetupFlow && (
        <div className="languages-editor">
          <p className="languages-intro">
            Your project uses the Next.js App Router. Ship Studio adds multilingual support with{' '}
            <strong>next-intl</strong> — pick your languages and {agentDisplayName} does the
            one-time setup:
          </p>
          <ol className="languages-steps">
            <li>Install next-intl</li>
            <li>Move your pages under a locale-aware route</li>
            <li>Extract text into per-language dictionaries</li>
            <li>Add routing so visitors get the right language</li>
          </ol>

          {picker}

          <div className="languages-footer">
            <span className="languages-footer-note">
              Runs in your terminal — takes a few minutes. Reopen Languages when it's done.
            </span>
            <Button variant="primary" onClick={handleAgentSetup} disabled={!onSendToClaude}>
              Set up with {agentDisplayName}
            </Button>
          </div>
        </div>
      )}

      {/* Managed: edit locales directly */}
      {!isLoading && status && status.supported && (
        <div className="languages-editor">
          {!status.configured && (
            <p className="languages-intro">
              Make your site available in multiple languages — visitors get routed automatically
              (e.g. <code>/fr/about</code>).
            </p>
          )}

          {picker}

          {status.parseWarning && <div className="languages-note">{status.parseWarning}</div>}

          {saveError && (
            <div className="languages-error">
              {saveError}
              {needsAiFallback && onSendToClaude && (
                <Button variant="secondary" size="sm" onClick={handleAiFallback}>
                  Ask {agentDisplayName} to fix it
                </Button>
              )}
            </div>
          )}

          <div className="languages-footer">
            {status.configured && translateTargets.length > 0 && onSendToClaude ? (
              <Button
                variant="secondary"
                onClick={handleTranslate}
                disabled={isDirty}
                title={isDirty ? 'Save your changes first' : undefined}
              >
                Translate with AI
              </Button>
            ) : (
              <span />
            )}
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={!isDirty || isSaving}
            >
              {isSaving ? 'Saving…' : status.configured ? 'Save changes' : 'Enable languages'}
            </Button>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}
