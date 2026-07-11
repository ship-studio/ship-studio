/**
 * Animations editor — the project's `@keyframes` rules. Each renders as a keyframes
 * card (steps as nested cards, properties inside each step), reusing the cascade card.
 * From an element you wire one up with `animation: <name>`. Project-scoped, not tied to
 * the selected element.
 */

import { useState } from 'react';
import { PlusIcon } from '../icons/utility';
import { Spinner } from '../primitives/Spinner';
import { CascadeRuleCard } from './CascadeRuleCard';
import type { RuleBody } from '../../lib/cssBody';
import type { AnimationRow } from '../../hooks/useCssAnimations';

interface Props {
  animations: AnimationRow[];
  loading: boolean;
  selectorSuggestions: string[];
  variables: string[];
  onChangeBody: (selector: string, body: RuleBody) => void;
  onDelete: (selector: string) => void;
  onCreate: (name: string) => void;
  onRename: (selector: string, newName: string) => void;
}

export function CssAnimationsPanel({
  animations,
  loading,
  selectorSuggestions,
  variables,
  onChangeBody,
  onDelete,
  onCreate,
  onRename,
}: Props) {
  if (loading && animations.length === 0) {
    return (
      <div className="ss-cascade-loading">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="ss-anims">
      <AddAnimation existing={new Set(animations.map((a) => a.name))} onCreate={onCreate} />

      {animations.length === 0 ? (
        <p className="ss-cascade-empty">
          No animations yet. Create one, then reference it from an element with{' '}
          <code>animation</code>.
        </p>
      ) : (
        <div className="ss-cascade-cards">
          {animations.map((a) => (
            <CascadeRuleCard
              key={a.selector}
              editable
              selector={a.selector}
              file={a.file}
              overridden={EMPTY}
              body={a.body}
              variables={variables}
              selectorSuggestions={selectorSuggestions}
              onChange={(b) => onChangeBody(a.selector, b)}
              onDelete={() => onDelete(a.selector)}
              onRenameKeyframes={(newName) => onRename(a.selector, newName)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY = new Map<string, string>();

/** "+ New animation": expands to a name input that creates `@keyframes <name>`. */
function AddAnimation({
  existing,
  onCreate,
}: {
  existing: Set<string>;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const submit = () => {
    const n = name.trim().replace(/^@(-[a-z]+-)?keyframes\s+/i, '');
    if (n && !existing.has(n)) onCreate(n);
    setName('');
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="ss-cascade-add-selector" onClick={() => setOpen(true)}>
        <PlusIcon size={11} /> New animation
      </button>
    );
  }

  return (
    <div className="ss-anims__add">
      <span className="ss-anims__add-at">@keyframes</span>
      <input
        className="ss-var-input"
        autoFocus
        value={name}
        spellCheck={false}
        autoComplete="off"
        placeholder="name (e.g. reveal)"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={submit}
      />
    </div>
  );
}
