/**
 * Custom CSS — Tailwind's native escape hatch for any property. Typing `prop: value`
 * emits a real arbitrary-property class `[prop:value]` (spaces escaped to `_`),
 * validated with CSS.supports so a bad property/value is rejected. Any arbitrary
 * properties already on the element (at the active breakpoint) are listed as chips
 * you can remove. Lives in its own collapsed section at the bottom of the panel.
 */

import { useState } from 'react';
import {
  tokensForVariant,
  listArbitraryProps,
  parseArbitraryProp,
  type LayerContext,
  type ResetSpec,
} from '../../lib/edit';

interface Props {
  currentClass: string;
  layer: LayerContext;
  onApplyEnum: (token: string, style: Record<string, string>) => void;
  onReset: (spec: ResetSpec) => void;
}

export function CustomCssBox({ currentClass, layer, onApplyEnum, onReset }: Props) {
  // Arbitrary properties set at the active breakpoint layer (so md edits show under md).
  const scoped = tokensForVariant(currentClass, layer.bp.prefix, layer.known);
  const props = listArbitraryProps(scoped);

  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);

  const add = () => {
    const parsed = parseArbitraryProp(text);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    onApplyEnum(parsed.token, { [parsed.prop]: parsed.value });
    setText('');
    setInvalid(false);
  };

  return (
    <div className="ss-custom-css">
      {props.length > 0 && (
        <ul className="ss-custom-css__list">
          {props.map((p) => (
            <li key={p.token} className="ss-custom-css__chip" title={`${p.prop}: ${p.value}`}>
              <span className="ss-custom-css__chip-text">
                <span className="ss-custom-css__chip-prop">{p.prop}</span>: {p.value}
              </span>
              <button
                type="button"
                className="ss-custom-css__chip-x"
                title={`Remove ${p.prop}`}
                aria-label={`Remove ${p.prop}`}
                onClick={() => onReset({ match: (t) => t === p.token, cssProps: [p.prop] })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ss-custom-css__add">
        <input
          className={`ss-edit-panel__text${invalid ? ' ss-edit-panel__num--invalid' : ''}`}
          inputMode="text"
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="Custom CSS property"
          aria-invalid={invalid}
          placeholder="clip-path: circle(50%)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (invalid) setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="ss-custom-css__addbtn"
          aria-label="Add custom CSS"
          onClick={add}
        >
          +
        </button>
      </div>
      <p className="ss-custom-css__hint">
        Any CSS property — written as a Tailwind <code>[prop:value]</code> class.
      </p>
    </div>
  );
}
