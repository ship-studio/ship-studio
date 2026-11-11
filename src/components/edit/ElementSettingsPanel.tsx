/**
 * The "Settings" tab of the cascade editor (Stacki's Style/Settings split) — edits
 * the selected element's MARKUP: TEXT and TAG edits use guarded source resolvers;
 * CLASSES and ATTRIBUTES keep their existing inline editing controls.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { CheckIcon, ChevronIcon, CloseIcon, PlusIcon } from '@/components/icons';
import { useCommands } from '../../commands/useCommands';
import type { ElementSettings } from '../../hooks/useElementSettings';
import type { OpenInCode } from '../../lib/code';
import { TextButton } from '../primitives/TextButton';
import { IconButton } from '../primitives/IconButton';
import { CascadeChip } from './CascadeChip';
import { getElementIcon } from './element-icons';
import { ContextMenuLabel } from '../primitives/ContextMenu';
import { Dropdown, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import {
  ImageSettingsSection,
  type ImageCssDimensionSetter,
  type ImageCssDimensions,
} from './ImageSettingsSection';
import { PropSection } from './PropSection';
import type { ElementSignature } from '../../lib/edit';

const TEXT_DISPLAY_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'button',
  'caption',
  'cite',
  'code',
  'data',
  'dd',
  'del',
  'dfn',
  'dt',
  'em',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'mark',
  'option',
  'output',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'td',
  'textarea',
  'th',
  'time',
  'u',
  'var',
]);

function displaysText(tag: string): boolean {
  const normalizedTag = tag.toLowerCase();
  return TEXT_DISPLAY_TAGS.has(normalizedTag) || normalizedTag.includes('-');
}

export function ElementSettingsPanel({
  settings,
  signature,
  projectPath,
  onOpenInCode,
  onSetCssDimension,
  cssDimensions,
  active = true,
}: {
  settings: ElementSettings;
  signature?: ElementSignature | null;
  projectPath?: string;
  onOpenInCode?: OpenInCode;
  onSetCssDimension?: ImageCssDimensionSetter;
  cssDimensions?: ImageCssDimensions;
  /** Whether this retained panel is currently visible and its palette actions are usable. */
  active?: boolean;
}) {
  const {
    tag,
    selectionKey,
    classes,
    attributes,
    addClass,
    renameClass,
    removeClass,
    setAttribute,
    renameAttribute,
    removeAttribute,
    canEditAttributes,
    tagOptions,
    canEditTag,
    setTag,
    text: sourceText,
    textReason,
    canEditText,
    setText,
  } = settings;
  const showTextField = displaysText(tag);
  const visibleAttributes = attributes.filter(
    (attribute) =>
      tag.toLowerCase() !== 'img' ||
      !['src', 'srcset', 'alt', 'width', 'height', 'loading'].includes(attribute.name.toLowerCase())
  );
  const showAttributeEmptyState =
    visibleAttributes.length === 0 &&
    settings.sourceMarkupStatus !== 'idle' &&
    settings.sourceMarkupStatus !== 'resolving';
  const addAttributeDisabled = settings.busy || !canEditAttributes;
  const addAttributeDisabledReason = settings.busy
    ? 'Attributes are being saved.'
    : settings.sourceMarkupStatus === 'resolving'
      ? 'Wait for the selected element’s source markup to resolve.'
      : settings.sourceMarkupStatus === 'unavailable'
        ? 'The selected element’s source markup could not be resolved.'
        : settings.imageAttributeEditBlockReason === 'ambiguous'
          ? 'This image matches several source locations.'
          : settings.imageAttributeEditBlockReason === 'spread'
            ? 'A spread attribute may provide this image’s values.'
            : settings.imageAttributeEditBlockReason === 'mismatch'
              ? 'The rendered image attributes do not match the source markup.'
              : 'The selected element’s attributes are read-only.';
  type TextEditState = {
    selectionKey: string;
    sourceText: string;
    draft: string;
    original: string;
    editing: boolean;
  };
  const [adding, setAdding] = useState(false);
  const [classText, setClassText] = useState('');
  const [textEditState, setTextEditState] = useState<TextEditState>(() => ({
    selectionKey,
    sourceText,
    draft: sourceText,
    original: sourceText,
    editing: false,
  }));
  const currentTextEdit =
    textEditState.selectionKey === selectionKey && textEditState.sourceText === sourceText
      ? textEditState
      : { selectionKey, sourceText, draft: sourceText, original: sourceText, editing: false };
  const { draft: textDraft, editing: editingText } = currentTextEdit;
  const panelRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const draftSelectionKeyRef = useRef(selectionKey);
  const textCommitRef = useRef(false);
  const textCancelledRef = useRef(false);

  const submit = () => {
    const v = classText.trim();
    if (v) addClass(v);
    setClassText('');
    setAdding(false);
  };

  const commitText = () => {
    if (textCancelledRef.current) {
      textCancelledRef.current = false;
      return;
    }
    if (!editingText || textCommitRef.current) return;
    if (draftSelectionKeyRef.current !== selectionKey) {
      setTextEditState({
        selectionKey,
        sourceText,
        draft: sourceText,
        original: sourceText,
        editing: false,
      });
      textCommitRef.current = false;
      return;
    }
    const next = textDraft;
    const original = currentTextEdit.original;
    setTextEditState({ ...currentTextEdit, editing: false });
    if (next === original) return;
    textCommitRef.current = true;
    void setText(next)
      .then((saved) => {
        if (!saved) {
          setTextEditState((state) =>
            state.selectionKey === selectionKey
              ? {
                  selectionKey,
                  sourceText,
                  draft: sourceText,
                  original: sourceText,
                  editing: false,
                }
              : state
          );
        }
      })
      .finally(() => {
        textCommitRef.current = false;
      });
  };

  const cancelText = () => {
    textCancelledRef.current = true;
    setTextEditState({
      selectionKey,
      sourceText,
      draft: sourceText,
      original: sourceText,
      editing: false,
    });
    textCommitRef.current = false;
  };

  useCommands(
    () => [
      {
        id: 'elementSettings.focusText',
        title: 'Edit selected element text',
        category: 'action',
        when: ({ kind }) =>
          active && kind === 'project' && showTextField && canEditText && !settings.busy,
        keywords: ['content', 'copy', 'headline', 'label'],
        run: () => textInputRef.current?.focus(),
      },
      {
        id: 'elementSettings.openTagMenu',
        title: 'Change selected element tag',
        category: 'action',
        when: ({ kind }) => active && kind === 'project' && canEditTag && !settings.busy,
        keywords: ['element', 'heading', 'paragraph', 'link', 'tag'],
        run: () =>
          panelRef.current
            ?.querySelector<HTMLButtonElement>('[aria-label="Change element tag"]')
            ?.click(),
      },
    ],
    [active, canEditTag, canEditText, settings.busy, showTextField]
  );

  return (
    <div className="ss-settings" ref={panelRef}>
      <PropSection title="Element" sectionId="settings-element" defaultOpen>
        <div className="ss-settings__subsections">
          <div className="ss-settings__subsection">
            <h5 className="ss-settings__label">Tag</h5>
            <Dropdown
              menuClassName="ss-settings__tag-menu"
              trigger={(props) => (
                <MenuButton
                  ref={props.ref}
                  onClick={props.onClick}
                  aria-haspopup={props['aria-haspopup']}
                  expanded={props['aria-expanded']}
                  variant="ghost"
                  size="compact"
                  className="ss-settings__tag-trigger"
                  disabled={!canEditTag || settings.busy}
                  aria-label="Change element tag"
                  title={canEditTag ? 'Change element tag' : undefined}
                >
                  <CascadeChip tone="selector" className="ss-settings__tag-chip">
                    <span className="ss-settings__tag-name">{tag || '—'}</span>
                    <ChevronIcon size={10} />
                  </CascadeChip>
                </MenuButton>
              )}
            >
              <ContextMenuLabel className="ss-settings__tag-menu-heading">
                Swap tag type
              </ContextMenuLabel>
              {tagOptions.map((option) => (
                <DropdownItem
                  key={option.tag}
                  active={option.tag === tag}
                  disabled={settings.busy}
                  icon={
                    getElementIcon(option.tag) ??
                    getElementIcon(/^h[4-6]$/.test(option.tag) ? 'h3' : 'unknown')
                  }
                  onSelect={() => void setTag(option.tag)}
                >
                  {option.label}
                </DropdownItem>
              ))}
            </Dropdown>
          </div>

          <div className="ss-settings__subsection">
            <h5 className="ss-settings__label">Classes</h5>
            <div className="ss-settings__classes">
              {classes.map((c) => (
                <EditableClassChip
                  key={c}
                  name={c}
                  disabled={settings.busy}
                  onRename={(next) => renameClass(c, next)}
                  onRemove={() => removeClass(c)}
                />
              ))}
              {adding ? (
                <input
                  className="ss-settings__class-input"
                  autoFocus
                  value={classText}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="class name"
                  onChange={(e) => setClassText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    else if (e.key === 'Escape') {
                      setClassText('');
                      setAdding(false);
                    }
                  }}
                  onBlur={submit}
                />
              ) : (
                <button
                  type="button"
                  className="ss-settings__class-add"
                  onClick={() => setAdding(true)}
                >
                  <PlusIcon size={10} /> add
                </button>
              )}
            </div>
          </div>

          {showTextField && (
            <div className="ss-settings__subsection ss-settings__text-subsection">
              <h5 className="ss-settings__label">Text</h5>
              <textarea
                key={selectionKey}
                ref={textInputRef}
                className="ss-settings__text-input"
                aria-label="Text content"
                value={textDraft}
                disabled={!canEditText || settings.busy}
                placeholder={
                  textReason === 'Resolving selected text…' ? 'Resolving source…' : undefined
                }
                spellCheck
                onFocus={() => {
                  textCancelledRef.current = false;
                  draftSelectionKeyRef.current = selectionKey;
                  setTextEditState({ ...currentTextEdit, original: sourceText, editing: true });
                }}
                onChange={(event) => {
                  setTextEditState({
                    ...currentTextEdit,
                    draft: event.target.value,
                    editing: true,
                  });
                }}
                onBlur={commitText}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelText();
                    event.currentTarget.blur();
                  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    commitText();
                  }
                }}
              />
              {textReason && <p className="ss-settings__text-reason">{textReason}</p>}
              {canEditText && (
                <p className="ss-settings__text-help">Cmd/Ctrl+Enter saves · Esc cancels</p>
              )}
            </div>
          )}
        </div>
      </PropSection>

      {tag.toLowerCase() === 'img' && signature && projectPath && (
        <ImageSettingsSection
          settings={settings}
          signature={signature}
          projectPath={projectPath}
          onOpenInCode={onOpenInCode}
          onSetCssDimension={onSetCssDimension}
          cssDimensions={cssDimensions}
        />
      )}

      <PropSection title="Attributes" sectionId="settings-attributes" defaultOpen>
        {visibleAttributes.length > 0 && (
          <ul className="ss-settings__attrs">
            {visibleAttributes.map((a) => (
              <AttrRow
                key={a.name}
                name={a.name}
                value={a.value}
                editable={canEditAttributes && !settings.busy && !a.isExpression}
                onSetValue={(v) => void setAttribute(a.name, v)}
                onRename={(n) => renameAttribute(a.name, n, a.value)}
                onRemove={() => removeAttribute(a.name)}
                isExpression={a.isExpression}
              />
            ))}
          </ul>
        )}
        {showAttributeEmptyState && <p className="ss-settings__empty">No other attributes.</p>}
        <AddAttr
          disabled={addAttributeDisabled}
          disabledReason={addAttributeDisabledReason}
          onAdd={(name, value) => void setAttribute(name, value)}
        />
      </PropSection>
    </div>
  );
}

/** A class chip is its own small inline editor. Click the name, type the new
 *  source class, and commit with Enter or blur; Escape leaves it unchanged. */
function EditableClassChip({
  name,
  disabled,
  onRename,
  onRemove,
}: {
  name: string;
  disabled: boolean;
  onRename: (nextName: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const cancelled = useRef(false);

  const start = () => {
    if (disabled) return;
    cancelled.current = false;
    setText(name);
    setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    if (cancelled.current) return;
    const next = text.trim();
    if (next && next !== name) onRename(next);
  };

  return (
    <CascadeChip
      tone="selector"
      editing={editing}
      interactive={!disabled}
      className="ss-settings__class-chip"
    >
      {editing ? (
        <input
          className="ss-cascade-chip__input"
          autoFocus
          value={text}
          size={Math.max(1, text.length)}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Rename .${name}`}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="ss-cascade-chip__content ss-settings__class-name"
            title={`Rename .${name}`}
            disabled={disabled}
            onClick={start}
          >
            .{name}
          </button>
          <button
            type="button"
            className="ss-settings__class-remove"
            title={`Remove .${name}`}
            aria-label={`Remove .${name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <CloseIcon size={10} />
          </button>
        </>
      )}
    </CascadeChip>
  );
}

/** One attribute row: click-to-edit KEY and VALUE, plus a remove button. */
function AttrRow({
  name,
  value,
  editable,
  onSetValue,
  onRename,
  onRemove,
  isExpression = false,
}: {
  name: string;
  value: string;
  editable: boolean;
  onSetValue: (value: string) => void;
  onRename: (newName: string) => void;
  onRemove: () => void;
  isExpression?: boolean;
}) {
  const [editing, setEditing] = useState<null | 'name' | 'value'>(null);
  const [text, setText] = useState('');

  const start = (field: 'name' | 'value') => {
    setText(field === 'name' ? name : value);
    setEditing(field);
  };
  const commit = () => {
    if (editing === 'name') {
      const n = text.trim();
      if (n && n !== name) onRename(n);
    } else if (editing === 'value' && text !== value) {
      onSetValue(text);
    }
    setEditing(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(null);
    }
  };

  return (
    <li className="ss-settings__attr">
      {editing === 'name' ? (
        <div className="ss-settings__attr-key-editor">
          <span className="ss-settings__attr-key ss-settings__attr-key-measure" aria-hidden="true">
            {text || '\u00a0'}
          </span>
          <textarea
            className="ss-settings__attr-input ss-settings__attr-input--name"
            autoFocus
            aria-label={`Attribute name ${name}`}
            rows={1}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onFocus={(event) => {
              const end = event.currentTarget.value.length;
              event.currentTarget.setSelectionRange(end, end);
            }}
            // Attribute names are idents — no spaces.
            onChange={(e) => setText(e.target.value.replace(/\s+/g, ''))}
            onKeyDown={onKey}
            onBlur={commit}
          />
        </div>
      ) : (
        <button
          type="button"
          className="ss-settings__attr-key"
          disabled={!editable}
          title={
            isExpression
              ? 'This value is generated by code'
              : editable
                ? 'Click to rename'
                : undefined
          }
          onClick={() => start('name')}
        >
          {name}
        </button>
      )}
      <span className="ss-settings__attr-eq">=</span>
      {editing === 'value' ? (
        <div className="ss-settings__attr-value-editor">
          <span
            className="ss-settings__attr-value--editable ss-settings__attr-value-measure"
            aria-hidden="true"
          >
            {text || <span className="ss-settings__attr-empty">empty</span>}
          </span>
          <textarea
            className="ss-settings__attr-input ss-settings__attr-input--value"
            autoFocus
            aria-label={`Attribute value for ${name}`}
            rows={1}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onFocus={(event) => {
              const end = event.currentTarget.value.length;
              event.currentTarget.setSelectionRange(end, end);
            }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
          />
        </div>
      ) : (
        <button
          type="button"
          className="ss-settings__attr-value ss-settings__attr-value--editable"
          disabled={!editable}
          title={
            isExpression
              ? 'This value is generated by code'
              : editable
                ? 'Click to edit'
                : undefined
          }
          onClick={() => start('value')}
        >
          {value || <span className="ss-settings__attr-empty">empty</span>}
        </button>
      )}
      {editable && (
        <button
          type="button"
          className="ss-settings__attr-remove"
          title={`Remove ${name}`}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <CloseIcon size={10} />
        </button>
      )}
    </li>
  );
}

/** "+ attribute" affordance: expands to name + value inputs. */
function AddAttr({
  disabled,
  disabledReason,
  onAdd,
}: {
  disabled: boolean;
  disabledReason: string;
  onAdd: (name: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const rowRef = useRef<HTMLDivElement>(null);
  const valueInputRef = useRef<HTMLInputElement>(null);
  const closedRef = useRef(true);

  const finish = useCallback(
    (save: boolean) => {
      if (closedRef.current) return;
      closedRef.current = true;
      const normalizedName = name.trim();
      if (save && !disabled && normalizedName) onAdd(normalizedName, value);
      setName('');
      setValue('');
      setOpen(false);
    },
    [disabled, name, onAdd, value]
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rowRef.current?.contains(event.target)) return;
      finish(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [finish, open]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    finish(true);
  };

  const start = () => {
    closedRef.current = false;
    setName('');
    setValue('');
    setOpen(true);
  };

  if (disabled || !open) {
    return (
      <TextButton
        className="ss-settings__attr-add-btn"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={start}
      >
        Add attribute
      </TextButton>
    );
  }
  return (
    <div ref={rowRef} className="ss-settings__attr-add" onBlur={handleBlur}>
      <input
        className="ss-settings__attr-input"
        autoFocus
        aria-label="Attribute name"
        value={name}
        spellCheck={false}
        autoComplete="off"
        placeholder="name"
        onChange={(e) => setName(e.target.value.replace(/\s+/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            valueInputRef.current?.focus();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
      />
      <span className="ss-settings__attr-eq">=</span>
      <input
        ref={valueInputRef}
        className="ss-settings__attr-input"
        aria-label="Attribute value"
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder="value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
      />
      <div className="ss-settings__attr-add-actions">
        <IconButton
          icon={<CheckIcon size={12} />}
          variant="success"
          size="compact"
          aria-label="Save attribute"
          title="Save attribute"
          disabled={!name.trim()}
          onClick={() => finish(true)}
        />
        <IconButton
          icon={<CloseIcon size={12} />}
          variant="ghost"
          size="compact"
          aria-label="Cancel adding attribute"
          title="Cancel"
          onClick={() => finish(false)}
        />
      </div>
    </div>
  );
}
