/**
 * LanguagesModal — multilingual (i18n) setup for Next.js and Astro projects.
 *
 * Three states:
 * - Managed (Next.js Pages Router, Astro, or App Router with next-intl):
 *   pick languages, Ship Studio writes the config directly.
 * - Guided setup (App Router without next-intl): pick languages, review the
 *   one-time setup prompt, run it with the AI agent — after which the
 *   project becomes managed.
 * - Unsupported: clear explanation.
 *
 * Anything that involves the AI agent goes through an explicit prompt-review
 * step: the user sees the exact prompt and chooses to copy it or paste it
 * into the terminal. Nothing runs until they press Enter there.
 *
 * @module components/LanguagesModal
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModalFrame } from './primitives/ModalFrame';
import { Button } from './primitives/Button';
import { Spinner } from './primitives/Spinner';
import { useModal } from '../contexts/ModalContext';
import { useAsyncState } from '../hooks/useAsyncState';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useOptionalToast } from '../contexts/ToastContext';
import { GlobeIcon, CloseIcon } from './icons';
import { asCommandError, formatCommandError } from '../lib/errors';
import { trackEvent } from '../lib/analytics';
import {
  getI18nStatus,
  setI18nConfig,
  buildTranslatePrompt,
  buildAiSetupPrompt,
  buildAppRouterSetupPrompt,
  buildRemovalCleanupPrompt,
  localeDisplayName,
  searchLocales,
  type I18nStatus,
} from '../lib/i18n';

interface LanguagesModalProps {
  projectPath: string;
  /** Pastes text into the active agent terminal (user still presses Enter). */
  onSendToClaude?: (prompt: string) => void;
}

/** A prompt staged for the user to review before handing to the agent. */
interface PromptReview {
  description: string;
  prompt: string;
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

/**
 * Search-any-language picker: popular languages as one-click pills, with a
 * search box over the full ISO 639-1 set (plus regional codes like `fr-CA`).
 */
function AddLanguagePicker({
  selected,
  onAdd,
}: {
  selected: string[];
  onAdd: (code: string) => void;
}) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchLocales(query, selected), [query, selected]);

  const add = (code: string) => {
    onAdd(code);
    setQuery('');
  };

  return (
    <>
      <input
        type="text"
        className="languages-search"
        placeholder="Search any language…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length > 0) add(results[0].code);
        }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {results.length === 0 ? (
        <div className="languages-pills-empty">No language matches "{query}"</div>
      ) : (
        <div className="languages-pills">
          {results.map((l) => (
            <button
              key={l.code}
              type="button"
              className="languages-pill"
              onClick={() => add(l.code)}
            >
              <span className="languages-pill-plus">+</span> {l.name}
              {query && <span className="languages-pill-code">{l.code}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function LanguagesModal({ projectPath, onSendToClaude }: LanguagesModalProps) {
  const { isOpen, close: onClose } = useModal('i18n');
  const { showToast } = useOptionalToast();
  const { copy, isCopied } = useCopyToClipboard();

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
  /** When set, the modal shows the prompt-review step instead of the editor. */
  const [promptReview, setPromptReview] = useState<PromptReview | null>(null);

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
    setPromptReview(null);
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

  /** Languages the draft removes relative to the saved config. */
  const removedLocales = useMemo(
    () =>
      status && status.configured ? status.locales.filter((l) => !draftLocales.includes(l)) : [],
    [status, draftLocales]
  );

  const addLocale = (code: string) => {
    if (!draftLocales.includes(code)) setDraftLocales([...draftLocales, code]);
  };

  const removeLocale = (code: string) => {
    if (code === draftDefault) return;
    setDraftLocales(draftLocales.filter((l) => l !== code));
  };

  /** Write the config; returns the fresh status on success, null on failure. */
  const saveConfig = async (showSuccessToast: boolean): Promise<I18nStatus | null> => {
    setIsSaving(true);
    setSaveError(null);
    setNeedsAiFallback(false);
    try {
      const updated = await setI18nConfig(projectPath, draftLocales, draftDefault);
      setStatus(updated);
      resetDraft(updated);
      void trackEvent('i18n_config_saved', { locale_count: draftLocales.length });
      if (showSuccessToast) showToast('Language settings saved', 'success');
      return updated;
    } catch (err) {
      const cmdErr = asCommandError(err);
      setSaveError(formatCommandError(cmdErr));
      if (cmdErr.type === 'Validation' && cmdErr.field === 'config') {
        setNeedsAiFallback(true);
      }
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveOnly = async () => {
    const removed = removedLocales;
    const updated = await saveConfig(true);
    if (!updated || removed.length === 0) return;
    // Ship Studio never deletes files, so removed languages leave translated
    // content behind (which Astro keeps serving). Offer an optional cleanup.
    void trackEvent('i18n_removal_cleanup_offered', { removed_count: removed.length });
    setPromptReview({
      description: `${removed.map(localeDisplayName).join(', ')} removed from the config. The translated files stay in your project${
        updated.framework === 'astro'
          ? ' — and Astro keeps serving those pages until the locale folders are deleted'
          : ''
      }. This optional prompt asks your AI agent to clean them up; press Back to skip.`,
      prompt: buildRemovalCleanupPrompt(updated, removed),
    });
  };

  /** The happy path: save the new languages, then review the translate prompt. */
  const handleSaveAndTranslate = async () => {
    const updated = await saveConfig(true);
    if (!updated) return;
    const updatedDefault = updated.defaultLocale ?? updated.locales[0] ?? null;
    const targets = updated.locales.filter((l) => l !== updatedDefault);
    if (targets.length === 0) return;
    void trackEvent('i18n_translate_requested', {
      locale_count: updated.locales.length,
      framework: updated.framework,
      via: 'save_and_translate',
    });
    setPromptReview({
      description: `Languages saved. The next step is content: this prompt asks your AI agent to translate your site into ${targets
        .map(localeDisplayName)
        .join(', ')}.`,
      prompt: buildTranslatePrompt(updated),
    });
  };

  const handleTranslate = () => {
    if (!status) return;
    void trackEvent('i18n_translate_requested', {
      locale_count: status.locales.length,
      framework: status.framework,
    });
    const statusDefault = status.defaultLocale ?? status.locales[0] ?? null;
    const targets = status.locales.filter((l) => l !== statusDefault);
    setPromptReview({
      description: `This prompt asks your AI agent to translate your site into ${targets
        .map(localeDisplayName)
        .join(', ')}.`,
      prompt: buildTranslatePrompt(status),
    });
  };

  const handleAgentSetup = () => {
    void trackEvent('i18n_app_router_setup_started', { locale_count: draftLocales.length });
    setPromptReview({
      description:
        'This one-time setup prompt restructures your project for multiple languages with next-intl. It takes a few minutes to run — reopen Languages afterwards to manage and translate.',
      prompt: buildAppRouterSetupPrompt(draftLocales, draftDefault),
    });
  };

  const handleAiFallback = () => {
    if (!status) return;
    void trackEvent('i18n_ai_fallback_used', { framework: status.framework });
    setPromptReview({
      description:
        "Ship Studio couldn't edit this config automatically. This prompt asks your AI agent to make the change instead.",
      prompt: buildAiSetupPrompt(status),
    });
  };

  const handlePasteToTerminal = () => {
    if (!promptReview || !onSendToClaude) return;
    onSendToClaude(promptReview.prompt);
    showToast('Prompt pasted — press Enter in the terminal to run it', 'success');
    setPromptReview(null);
    onClose();
  };

  if (!isOpen) return null;

  // Match buildTranslatePrompt's fallback: with an unparseable defaultLocale,
  // the first locale is treated as the default, not as a translation target.
  const effectiveDefault = status ? (status.defaultLocale ?? status.locales[0] ?? null) : null;
  const translateTargets = status?.locales.filter((l) => l !== effectiveDefault) ?? [];
  const draftTargets = draftLocales.filter((l) => l !== draftDefault);
  const showSetupFlow = !!status && !status.supported && status.agentSetupAvailable;
  // Removal needs honest messaging: Ship Studio never deletes files, and
  // Astro keeps serving locale folders that still exist on disk.
  const removalNote =
    removedLocales.length > 0
      ? `Removing ${removedLocales.map(localeDisplayName).join(', ')}: ${
          status?.framework === 'astro'
            ? 'their pages keep serving until the files are removed (cleanup offered after saving).'
            : 'those pages stop being served; translated files stay in your project.'
        }`
      : null;

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
        <AddLanguagePicker selected={draftLocales} onAdd={addLocale} />
      </div>
    </>
  );

  return (
    <ModalFrame isOpen onClose={onClose} title="Languages" className="languages-modal">
      {/* Prompt review: the user sees exactly what the agent will be asked */}
      {promptReview && (
        <div className="languages-editor">
          <p className="languages-intro">{promptReview.description}</p>
          <div className="languages-prompt-box">{promptReview.prompt}</div>
          <div className="languages-footer">
            <Button variant="ghost" onClick={() => setPromptReview(null)}>
              Back
            </Button>
            <div className="languages-footer-buttons">
              <Button variant="secondary" onClick={() => void copy(promptReview.prompt)}>
                {isCopied ? 'Copied!' : 'Copy prompt'}
              </Button>
              {onSendToClaude && (
                <Button variant="primary" onClick={handlePasteToTerminal}>
                  Paste into terminal
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {!promptReview && isLoading && (
        <div className="languages-loading">
          <Spinner />
          <span>Checking project…</span>
        </div>
      )}

      {!promptReview && !isLoading && loadError && (
        <div className="languages-error">Couldn't check this project's language setup.</div>
      )}

      {/* Unsupported, no path forward */}
      {!promptReview && !isLoading && status && !status.supported && !showSetupFlow && (
        <div className="languages-unsupported">
          <div className="languages-unsupported-icon">
            <GlobeIcon size={28} />
          </div>
          <p>{status.unsupportedReason}</p>
        </div>
      )}

      {/* App Router: guided one-time setup */}
      {!promptReview && !isLoading && showSetupFlow && (
        <div className="languages-editor">
          <p className="languages-intro">
            Your project uses the Next.js App Router. Ship Studio adds multilingual support with{' '}
            <strong>next-intl</strong> — pick your languages, then run a one-time setup with your AI
            agent:
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
              Next: review the setup prompt before anything runs.
            </span>
            <Button variant="primary" onClick={handleAgentSetup}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {/* Managed: edit locales directly */}
      {!promptReview && !isLoading && status && status.supported && (
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
              {needsAiFallback && (
                <Button variant="secondary" size="sm" onClick={handleAiFallback}>
                  Fix with AI
                </Button>
              )}
            </div>
          )}

          {/* Footer adapts to where the user is in the flow:
              unsaved new languages → "Save & translate" is the happy path;
              saved with target languages → translate;
              nothing actionable → no footer. */}
          {isDirty && draftTargets.length > 0 && (
            <div className="languages-footer">
              <span className="languages-footer-note">
                {removalNote ??
                  `New languages start as a copy of ${localeDisplayName(draftDefault)} until translated.`}
              </span>
              <div className="languages-footer-buttons">
                <Button variant="ghost" onClick={() => void handleSaveOnly()} disabled={isSaving}>
                  Save only
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void handleSaveAndTranslate()}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving…' : 'Save & translate with AI'}
                </Button>
              </div>
            </div>
          )}
          {isDirty && draftTargets.length === 0 && (
            <div className="languages-footer">
              {removalNote ? (
                <span className="languages-footer-note">{removalNote}</span>
              ) : (
                <span />
              )}
              <Button variant="primary" onClick={() => void handleSaveOnly()} disabled={isSaving}>
                {isSaving ? 'Saving…' : status.configured ? 'Save changes' : 'Enable languages'}
              </Button>
            </div>
          )}
          {!isDirty && translateTargets.length > 0 && (
            <div className="languages-footer">
              <span className="languages-footer-note">
                Languages are set up — run translation whenever you add or change content.
              </span>
              <Button variant="primary" onClick={handleTranslate}>
                Translate with AI
              </Button>
            </div>
          )}
        </div>
      )}
    </ModalFrame>
  );
}
