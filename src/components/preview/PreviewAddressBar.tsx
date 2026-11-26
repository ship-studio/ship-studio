/**
 * Editable preview address bar with a menu for the local server and saved URLs.
 * @module components/preview/PreviewAddressBar
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useCommands } from '@/commands/useCommands';
import {
  ChevronIcon,
  ExternalLinkIcon,
  EditFieldIcon,
  GlobeIcon,
  PlusIcon,
  ResetIcon,
  TrashIcon,
} from '@/components/icons';
import { Button } from '@/components/primitives/Button';
import { Dropdown, DropdownDivider } from '@/components/primitives/Dropdown';
import { IconButton } from '@/components/primitives/IconButton';
import '../../styles/features/preview-address-bar.css';

export interface PreviewAddressBarProps {
  /** URL currently rendered by the preview, including its route and query. */
  value: string | null;
  /** User-saved custom external URLs. */
  savedUrls: readonly string[];
  /** Current local development server URL, when one is available. */
  defaultUrl: string | null;
  /** Receives the exact text entered in the address field. */
  onNavigate: (url: string) => void | Promise<void>;
  /** Saves the trimmed value entered in the menu's add form. */
  onSave: (url: string) => void | Promise<void>;
  /** Removes one custom saved URL. */
  onRemove: (url: string) => void | Promise<void>;
  /** Replaces one custom saved URL without changing its position. */
  onEdit: (oldUrl: string, newUrl: string) => void | Promise<void>;
  /** Reloads the currently selected preview URL. */
  onRefresh: () => void;
  /** Optional browser action, used when the address bar needs a browser picker. */
  browserAction?: ReactNode;
  /** Opens the currently displayed URL in the system browser. */
  onOpenBrowser?: () => void;
  /** Indicates that navigation or a URL action is being processed. */
  isLoading?: boolean;
  /** Parent-owned error message, such as a failed navigation. */
  error?: string | null;
}

const MIN_ADDRESS_INPUT_SIZE = 20;
const MAX_ADDRESS_INPUT_SIZE = 52;
const ACTION_ERROR_DURATION_MS = 4000;

function getAddressDisplayParts(value: string): { host: string; suffix: string } | null {
  const match = /^(https?:\/\/)([^/?#]*)([\s\S]*)$/i.exec(value);
  if (!match) return null;
  return { host: match[2], suffix: match[3] };
}

/** A focused address field and saved destination menu for the preview toolbar. */
export function PreviewAddressBar({
  value,
  savedUrls,
  defaultUrl,
  onNavigate,
  onSave,
  onRemove,
  onEdit,
  onRefresh,
  browserAction,
  onOpenBrowser,
  isLoading = false,
  error = null,
}: PreviewAddressBarProps) {
  const addressBarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const addChoiceRef = useRef<HTMLButtonElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addingUrl, setAddingUrl] = useState(false);
  const [addUrlKind, setAddUrlKind] = useState<'dev-server' | 'external' | null>(null);
  const [addUrlDraft, setAddUrlDraft] = useState('');
  const [restoreAddTriggerFocus, setRestoreAddTriggerFocus] = useState(false);
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [addressFocused, setAddressFocused] = useState(false);
  const shownError = localError ?? error;
  const currentText = draft ?? value ?? '';
  const displayParts = getAddressDisplayParts(currentText);
  const displayText = displayParts ? `${displayParts.host}${displayParts.suffix}` : currentText;
  const inputSize = Math.min(
    Math.max(
      (addressFocused ? currentText : displayText).length,
      displayParts ? 1 : MIN_ADDRESS_INPUT_SIZE
    ),
    MAX_ADDRESS_INPUT_SIZE
  );

  useEffect(() => {
    if (!localError) return;
    const timeout = window.setTimeout(() => setLocalError(null), ACTION_ERROR_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [localError]);

  useEffect(() => {
    if (!addingUrl) return;
    if (addUrlKind) {
      const input = addInputRef.current;
      input?.focus();
      if (addUrlKind === 'dev-server') {
        input?.setSelectionRange(input.value.length, input.value.length);
      }
    } else addChoiceRef.current?.focus();
  }, [addingUrl, addUrlKind]);

  useEffect(() => {
    if (!restoreAddTriggerFocus) return;
    addTriggerRef.current?.focus();
    setRestoreAddTriggerFocus(false);
  }, [restoreAddTriggerFocus]);

  useEffect(() => {
    if (editingUrl) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingUrl]);

  const submitNavigation = async (text: string) => {
    if (!text.trim() || pending || isLoading) return;
    setLocalError(null);
    try {
      await onNavigate(text);
      setDraft(null);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const navigateToDestination = async (url: string) => {
    setMenuOpen(false);
    setLocalError(null);
    try {
      await onNavigate(url);
      setDraft(null);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveUrl = async () => {
    const url = addInputRef.current?.value.trim() ?? '';
    if (!url || url === 'http://localhost:' || pending) return;
    setPending(true);
    setLocalError(null);
    try {
      await onSave(url);
      setAddingUrl(false);
      setAddUrlKind(null);
      setMenuOpen(false);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const removeUrl = async (url: string) => {
    if (pending) return;
    setPending(true);
    setLocalError(null);
    try {
      await onRemove(url);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const editUrl = async () => {
    if (!editingUrl || pending) return;
    const newUrl = editDraft.trim();
    if (!newUrl) return;
    setPending(true);
    setLocalError(null);
    try {
      await onEdit(editingUrl, newUrl);
      setEditingUrl(null);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  useCommands(
    () => [
      {
        id: 'preview.focusAddressBar',
        title: 'Focus preview address bar',
        category: 'project',
        when: 'project',
        keywords: ['preview', 'url', 'navigate', 'address'],
        run: () => {
          inputRef.current?.focus();
          inputRef.current?.select();
        },
      },
      {
        id: 'preview.addAddress',
        title: 'Add saved preview URL…',
        category: 'project',
        when: 'project',
        keywords: ['preview', 'url', 'external', 'save'],
        run: () => {
          setMenuOpen(true);
          setAddingUrl(true);
          setAddUrlKind(null);
        },
      },
    ],
    []
  );

  const destinations = [
    ...(defaultUrl ? [{ url: defaultUrl, label: 'Dev Server', isDefault: true }] : []),
    ...savedUrls.map((url) => ({ url, label: url, isDefault: false })),
  ];

  return (
    <div ref={addressBarRef} className="preview-address-bar" aria-label="Preview address">
      <IconButton
        className="preview-address-bar__refresh"
        variant="ghost"
        size="compact"
        icon={<ResetIcon size={14} />}
        onClick={onRefresh}
        disabled={!value || isLoading || pending}
        title="Refresh preview"
        aria-label="Refresh preview"
      />
      <div
        style={{ '--preview-address-input-width': `${inputSize}ch` } as CSSProperties}
        className={`preview-address-bar__field${displayParts ? ' preview-address-bar__field--formatted' : ''}${addressFocused ? ' preview-address-bar__field--focused' : ''}`}
      >
        <input
          ref={inputRef}
          className="preview-address-bar__input"
          aria-label="Preview URL"
          size={inputSize}
          aria-invalid={Boolean(shownError && !menuOpen)}
          aria-describedby={shownError && !menuOpen ? 'preview-address-bar-error' : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="url"
          value={currentText}
          placeholder={value ? undefined : 'Enter preview URL'}
          onFocus={(event) => {
            setAddressFocused(true);
            setLocalError(null);
            setDraft(event.currentTarget.value);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setLocalError(null);
            setDraft(event.target.value);
          }}
          onBlur={() => {
            setAddressFocused(false);
            setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setLocalError(null);
              setDraft(null);
              event.currentTarget.blur();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void submitNavigation(event.currentTarget.value);
              event.currentTarget.blur();
            }
          }}
        />
        {displayParts && (
          <span className="preview-address-bar__display" aria-hidden="true">
            <strong>{displayParts.host}</strong>
            <span>{displayParts.suffix}</span>
          </span>
        )}
      </div>
      <Dropdown
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) {
            setEditingUrl(null);
            setAddingUrl(false);
            setAddUrlKind(null);
            setLocalError(null);
          }
        }}
        ariaLabel="Saved preview URLs"
        presentation="popover"
        align="left"
        portal
        portalClampToViewport
        portalAnchorRef={addressBarRef}
        className="preview-address-bar__destinations"
        menuClassName="preview-address-bar__menu"
        trigger={(props) => (
          <IconButton
            {...props}
            className="preview-address-bar__menu-trigger"
            variant="ghost"
            size="compact"
            icon={<ChevronIcon size={13} />}
            aria-label="Choose a saved preview URL"
            title="Saved preview URLs"
          />
        )}
      >
        <div className="preview-address-bar__menu-heading">Preview destinations</div>
        {destinations.map(({ url, label, isDefault }) => (
          <div
            className="preview-address-bar__destination"
            key={`${isDefault ? 'default:' : ''}${url}`}
          >
            {!isDefault && editingUrl === url ? (
              <form
                className="preview-address-bar__edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void editUrl();
                }}
              >
                <input
                  ref={editInputRef}
                  aria-label={`Edit saved URL ${url}`}
                  type="url"
                  value={editDraft}
                  onChange={(event) => {
                    setLocalError(null);
                    setEditDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditingUrl(null);
                      setLocalError(null);
                    }
                  }}
                />
                <Button size="compact" variant="primary" type="submit" disabled={pending}>
                  Save
                </Button>
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => {
                    setEditingUrl(null);
                    setLocalError(null);
                  }}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="preview-address-bar__destination-select"
                title={url}
                onClick={() => {
                  void navigateToDestination(url);
                }}
              >
                {isDefault ? <GlobeIcon size={14} /> : <ExternalLinkIcon size={14} />}
                <span className="preview-address-bar__destination-copy">
                  <strong>{label}</strong>
                  {isDefault && <small>{url}</small>}
                </span>
              </button>
            )}
            {!isDefault &&
              (editingUrl === url ? null : (
                <span className="preview-address-bar__destination-actions">
                  <IconButton
                    className="preview-address-bar__edit"
                    variant="ghost"
                    size="compact"
                    role="menuitem"
                    icon={<EditFieldIcon size={13} />}
                    onClick={() => {
                      setEditDraft(url);
                      setEditingUrl(url);
                      setLocalError(null);
                    }}
                    disabled={pending}
                    title={`Edit ${url}`}
                    aria-label={`Edit saved URL ${url}`}
                  />
                  <IconButton
                    className="preview-address-bar__remove"
                    variant="ghost"
                    size="compact"
                    role="menuitem"
                    icon={<TrashIcon size={13} />}
                    onClick={() => void removeUrl(url)}
                    disabled={pending}
                    title={`Remove ${url}`}
                    aria-label={`Remove saved URL ${url}`}
                  />
                </span>
              ))}
          </div>
        ))}
        {destinations.length > 0 && <DropdownDivider />}
        {addingUrl ? (
          addUrlKind ? (
            <form
              className="preview-address-bar__add-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveUrl();
              }}
            >
              <label htmlFor="preview-address-bar-add">
                {addUrlKind === 'dev-server' ? 'Another dev server address' : 'External URL'}
              </label>
              <input
                ref={addInputRef}
                id="preview-address-bar-add"
                type="url"
                placeholder={addUrlKind === 'dev-server' ? undefined : 'https://example.com'}
                autoComplete="url"
                value={addUrlDraft}
                onChange={(event) => {
                  setAddUrlDraft(event.target.value);
                  setLocalError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setAddUrlKind(null);
                    setLocalError(null);
                  }
                }}
              />
              <div className="preview-address-bar__add-actions">
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => {
                    setAddUrlKind(null);
                    setLocalError(null);
                  }}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button
                  size="compact"
                  variant="primary"
                  type="submit"
                  disabled={
                    pending || !addUrlDraft.trim() || addUrlDraft.trim() === 'http://localhost:'
                  }
                >
                  Save URL
                </Button>
              </div>
            </form>
          ) : (
            <div className="preview-address-bar__add-choices">
              <button
                ref={addChoiceRef}
                type="button"
                className="preview-address-bar__add-trigger"
                onClick={() => {
                  setAddUrlDraft('http://localhost:');
                  setAddUrlKind('dev-server');
                  setLocalError(null);
                }}
              >
                <GlobeIcon size={14} />
                <span>Another dev server address…</span>
              </button>
              <button
                type="button"
                className="preview-address-bar__add-trigger"
                onClick={() => {
                  setAddUrlDraft('');
                  setAddUrlKind('external');
                  setLocalError(null);
                }}
              >
                <ExternalLinkIcon size={14} />
                <span>External URL…</span>
              </button>
              <Button
                size="compact"
                variant="ghost"
                onClick={() => {
                  setAddingUrl(false);
                  setAddUrlKind(null);
                  setRestoreAddTriggerFocus(true);
                }}
              >
                Cancel
              </Button>
            </div>
          )
        ) : (
          <button
            ref={addTriggerRef}
            type="button"
            className="preview-address-bar__add-trigger"
            onClick={() => {
              setAddingUrl(true);
              setAddUrlKind(null);
              setLocalError(null);
            }}
          >
            <PlusIcon size={14} />
            <span>Save another URL…</span>
          </button>
        )}
        {shownError && (
          <div className="preview-address-bar__menu-error" role="alert">
            {shownError}
          </div>
        )}
      </Dropdown>
      {browserAction !== undefined
        ? browserAction
        : onOpenBrowser && (
            <IconButton
              className="preview-address-bar__open-browser"
              variant="ghost"
              size="compact"
              icon={<ExternalLinkIcon size={14} />}
              onClick={onOpenBrowser}
              disabled={!value}
              title="Open preview in browser"
              aria-label="Open preview in browser"
            />
          )}
      {isLoading && (
        <span className="preview-address-bar__loading" role="status">
          Loading preview
        </span>
      )}
      {shownError && !menuOpen && (
        <span id="preview-address-bar-error" className="preview-address-bar__error" role="alert">
          {shownError}
        </span>
      )}
    </div>
  );
}
