import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDismissOnOutsidePointer } from '../../hooks/useDismissOnOutsidePointer';
import { CheckIcon } from '@/components/icons';

export type ValueFieldVariant = 'number' | 'length' | 'angle' | 'time' | 'color';

/** Describes a unit or enumerated option accepted by a value field. */
export interface ValueFieldOption {
  /** Unit suffix (`px`) or complete keyword value (`auto`). */
  value: string;
  label: string;
  kind?: 'unit' | 'keyword' | 'format' | 'variable';
}

/** A project CSS custom property offered by the variable picker. */
export interface ValueFieldVariable {
  /** Custom-property name including the leading `--`. */
  name: string;
  /** Current resolved/source value, shown as supporting context in the picker. */
  value?: string;
}

const OPTIONS_BY_VARIANT: Record<ValueFieldVariant, ValueFieldOption[]> = {
  number: [{ value: '', label: '-' }],
  length: [
    { value: '', label: '-' },
    { value: 'px', label: 'PX' },
    { value: '%', label: '%' },
    { value: 'em', label: 'EM' },
    { value: 'rem', label: 'REM' },
    { value: 'ch', label: 'CH' },
    { value: 'vw', label: 'VW' },
    { value: 'vh', label: 'VH' },
    { value: 'svw', label: 'SVW' },
    { value: 'svh', label: 'SVH' },
  ],
  angle: [
    { value: '', label: '-' },
    { value: 'deg', label: 'DEG' },
    { value: 'rad', label: 'RAD' },
    { value: 'turn', label: 'TURN' },
  ],
  time: [
    { value: '', label: '-' },
    { value: 'ms', label: 'MS' },
    { value: 's', label: 'S' },
  ],
  color: [
    { value: 'hex', label: 'HEX', kind: 'format' },
    { value: 'rgb', label: 'RGB', kind: 'format' },
    { value: 'hsl', label: 'HSL', kind: 'format' },
    { value: 'hsb', label: 'HSB', kind: 'format' },
    { value: 'oklch', label: 'OKLCH', kind: 'format' },
  ],
};

interface SplitValue {
  text: string;
  unit: string;
}

const NUMERIC_VALUE = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/i;
const CSS_VARIABLE_VALUE = /^var\(\s*(--[\w-]+)\s*\)$/i;
const VARIABLE_OPTION: ValueFieldOption = { value: 'var', label: 'VAR', kind: 'variable' };
const EMPTY_VARIABLES: ValueFieldVariable[] = [];
// Hover dwell before a truncated variable value starts its carousel loop,
// and the constant scroll speed used to derive each loop's duration. Kept in
// JS because the delay drives a timer and the duration is width-proportional.
const VARIABLE_SCROLL_HOLD_MS = 2000;
const VARIABLE_SCROLL_SPEED_PX_PER_SECOND = 32;
const VARIABLE_OVERFLOW_EPSILON_PX = 1;

/** Returns the resolved pixel length of a custom property from computed style. */
function readPixelCustomProperty(element: Element, property: string): number {
  const value = Number.parseFloat(window.getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

interface VariableRowProps {
  variable: ValueFieldVariable;
  selected: boolean;
  active: boolean;
  optionId: string;
  onSelect: () => void;
  onActivate: () => void;
}

/**
 * One variable picker row. The name is always rendered in full; the supporting
 * value truncates with an ellipsis and, after the cursor rests on the row,
 * scrolls its hidden tail into view as a seamless carousel until hover ends.
 */
function VariableRow({
  variable,
  selected,
  active,
  optionId,
  onSelect,
  onActivate,
}: VariableRowProps) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const copyRef = useRef<HTMLSpanElement>(null);
  const holdTimerRef = useRef<number | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [loopDuration, setLoopDuration] = useState('');
  const [marqueeDistance, setMarqueeDistance] = useState('');
  const stopScrolling = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setScrolling(false);
    setLoopDuration('');
    setMarqueeDistance('');
  }, []);

  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const copy = copyRef.current;
    if (!viewport || !copy) return;
    const measure = () => {
      setOverflowing(copy.scrollWidth > viewport.clientWidth + VARIABLE_OVERFLOW_EPSILON_PX);
    };
    measure();
    // jsdom test environments ship no ResizeObserver; the one-shot measure
    // above already covers the fixed-width picker menu.
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [variable.value]);

  const startHold = useCallback(() => {
    if (!overflowing || scrolling) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      const copy = copyRef.current;
      if (!copy || !overflowing) return;
      // The loop shifts by exactly one copy plus the gap so the duplicate
      // copy lands where the first one started — seamless wrap-around.
      const distance =
        copy.scrollWidth + readPixelCustomProperty(copy, '--value-field-variable-scroll-gap');
      setLoopDuration(`${Math.max(distance, 1) / VARIABLE_SCROLL_SPEED_PX_PER_SECOND}s`);
      setMarqueeDistance(`${distance}px`);
      setScrolling(true);
    }, VARIABLE_SCROLL_HOLD_MS);
  }, [overflowing, scrolling]);

  return (
    <button
      id={optionId}
      type="button"
      role="option"
      aria-selected={selected}
      className={[
        'value-field__option',
        'value-field__variable-option',
        selected ? 'value-field__option--selected' : null,
        active ? 'value-field__option--active' : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => {
        onActivate();
        startHold();
      }}
      onMouseLeave={stopScrolling}
      onClick={onSelect}
    >
      <span className="value-field__variable-name">{variable.name}</span>
      {variable.value && (
        <span
          ref={viewportRef}
          className="value-field__variable-value"
          data-overflow={overflowing ? 'true' : undefined}
          data-scrolling={scrolling ? 'true' : undefined}
        >
          <span
            className="value-field__variable-track"
            style={
              scrolling
                ? ({
                    '--marquee-loop-duration': loopDuration,
                    '--marquee-loop-distance': marqueeDistance,
                  } as CSSProperties)
                : undefined
            }
          >
            <span ref={copyRef} className="value-field__variable-copy">
              {variable.value}
            </span>
            {scrolling && (
              <span className="value-field__variable-copy" aria-hidden="true">
                {variable.value}
              </span>
            )}
          </span>
        </span>
      )}
    </button>
  );
}

/** Returns the raw custom-property name from a simple `var(--name)` value. */
export function parseValueFieldVariable(value: string): string | null {
  return CSS_VARIABLE_VALUE.exec(value.trim())?.[1] ?? null;
}

/** Splits a simple number+unit while leaving keywords and CSS functions editable intact. */
export function splitValueFieldValue(value: string, options: ValueFieldOption[]): SplitValue {
  const trimmed = value.trim();
  const variable = parseValueFieldVariable(trimmed);
  if (variable) return { text: variable, unit: 'var' };
  const match = NUMERIC_VALUE.exec(trimmed);
  if (!match || !match[2]) return { text: trimmed, unit: '' };

  const unit = options.find(
    (option) => option.kind !== 'keyword' && option.value.toLowerCase() === match[2].toLowerCase()
  )?.value;
  return unit ? { text: match[1], unit } : { text: trimmed, unit: '' };
}

/** Props for an editable numeric or unit-bearing design value. */
export interface ValueFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur'
> {
  value: string;
  variant?: ValueFieldVariant;
  /** Unit selected when the value is empty; explicit values keep their unit. */
  defaultUnit?: string;
  /** Property-specific keywords such as `auto` or `none`. */
  keywords?: ValueFieldOption[];
  /** Project CSS custom properties available to this value. */
  variables?: ValueFieldVariable[];
  /** Selected representation for a color field. */
  format?: string;
  /** Reformat the current color when a color representation is selected. */
  onFormatChange?: (format: string) => void;
  /** Optional control rendered flush with the field's leading edge. */
  leading?: ReactNode;
  /** Return false to reject the value and restore the last controlled value. */
  onCommit: (value: string) => boolean | void;
}

/**
 * Editable property value with an integrated format picker. Users may type a
 * complete value (`12px`) and commit it, or edit the number and choose its unit
 * independently. Keywords remain in the text side with the neutral unit marker.
 */
export function ValueField({
  value,
  variant = 'number',
  defaultUnit = '',
  keywords = [],
  variables = EMPTY_VARIABLES,
  format,
  onFormatChange,
  leading,
  onCommit,
  className,
  onKeyDown,
  placeholder,
  'aria-label': ariaLabel,
  ...inputProps
}: ValueFieldProps) {
  const variableValue = parseValueFieldVariable(value);
  const availableVariables = useMemo(() => {
    const seen = new Set<string>();
    return variables.filter((variable) => {
      if (!variable.name.startsWith('--') || seen.has(variable.name)) return false;
      seen.add(variable.name);
      return true;
    });
  }, [variables]);
  const options = [
    ...OPTIONS_BY_VARIANT[variant],
    ...(availableVariables.length > 0 || variableValue ? [VARIABLE_OPTION] : []),
    ...keywords,
  ];
  // A field whose only option is the empty "no unit" entry has nothing to
  // pick: rendering its trigger just parks a stray "-" beside the number
  // (the Opacity row read "100 -").
  const hasSelectableOptions = options.some((option) => option.value !== '');
  const isFormatField = variant === 'color';
  const initial = splitValueFieldValue(value, options);
  const placeholderValue =
    typeof placeholder === 'string' ? splitValueFieldValue(placeholder, options) : null;
  const hasControlledValue = value.trim() !== '';
  const displayPlaceholder = placeholderValue?.unit ? placeholderValue.text : placeholder;
  const [text, setText] = useState(initial.text);
  const [unit, setUnit] = useState(
    hasControlledValue ? initial.unit : placeholderValue?.unit || initial.unit || defaultUnit
  );
  const [selectedFormat, setSelectedFormat] = useState(
    format ?? options.find((option) => option.kind === 'format')?.value ?? ''
  );
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [variableOpen, setVariableOpen] = useState(false);
  const [variableQuery, setVariableQuery] = useState('');
  const [activeVariableIndex, setActiveVariableIndex] = useState(0);
  const [menuRect, setMenuRect] = useState<{
    top: number;
    right: number;
    variableLeft: number;
    variableWidth: number;
  } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const variableMenuRef = useRef<HTMLDivElement>(null);
  const pointerToggleRef = useRef(false);
  const keyboardToggleRef = useRef(false);
  const listId = useId();
  const variableListId = useId();

  const filteredVariables = useMemo(() => {
    const query = variableQuery.trim().toLowerCase();
    return availableVariables.filter((variable) => variable.name.toLowerCase().includes(query));
  }, [availableVariables, variableQuery]);

  useEffect(() => {
    const next = splitValueFieldValue(value, options);
    setText(next.text);
    setUnit(value.trim() !== '' ? next.unit : placeholderValue?.unit || next.unit || defaultUnit);
    if (format !== undefined) setSelectedFormat(format);
    setInvalid(false);
    // The options are intentionally derived from stable primitive presets and
    // caller-owned keyword literals; the controlled value is the sync signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, variant, format, placeholder]);

  const reposition = () => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const boundary = root.closest<HTMLElement>('[data-value-field-menu-boundary]');
    const boundaryRect = boundary?.getBoundingClientRect();
    const boundaryStyle = boundary ? window.getComputedStyle(boundary) : null;
    const paddingLeft = Number.parseFloat(boundaryStyle?.paddingLeft ?? '0') || 0;
    const paddingRight = Number.parseFloat(boundaryStyle?.paddingRight ?? '0') || 0;
    const variableLeft = boundaryRect ? boundaryRect.left + paddingLeft : rect.left;
    const variableRight = boundaryRect ? boundaryRect.right - paddingRight : rect.right;
    setMenuRect({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
      variableLeft,
      variableWidth: Math.max(0, variableRight - variableLeft),
    });
  };

  useLayoutEffect(() => {
    if (!open && !variableOpen) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, variableOpen]);

  useDismissOnOutsidePointer(
    open || variableOpen,
    menuRef,
    () => {
      setOpen(false);
      setVariableOpen(false);
    },
    {
      isOutside: (target) =>
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target) &&
        !variableMenuRef.current?.contains(target),
    }
  );

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  const combinedValue = (nextText = text, nextUnit = unit) => {
    const trimmed = nextText.trim();
    if (nextUnit === 'var') return `var(${trimmed})`;
    return isFormatField ? trimmed : `${trimmed}${nextUnit}`;
  };

  const commit = (nextText = text, nextUnit = unit) => {
    if (!nextText.trim()) return true;
    const nextValue = combinedValue(nextText, nextUnit);
    if (onCommit(nextValue) === false) {
      const restored = splitValueFieldValue(value, options);
      setText(restored.text);
      setUnit(restored.unit);
      setInvalid(true);
      return false;
    }
    const normalized = splitValueFieldValue(nextValue, options);
    setText(normalized.text);
    setUnit(normalized.unit);
    setInvalid(false);
    return true;
  };

  const selectOption = (option: ValueFieldOption) => {
    setOpen(false);
    if (option.kind === 'variable') {
      const nextText = unit === 'var' ? text : '--';
      setText(nextText);
      setUnit('var');
      setVariableQuery('');
      setActiveVariableIndex(0);
      setVariableOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (option.kind === 'format') {
      setSelectedFormat(option.value);
      if (unit === 'var') {
        setText('');
        setUnit('');
        inputRef.current?.focus();
        return;
      }
      onFormatChange?.(option.value);
      inputRef.current?.focus();
      return;
    }
    if (option.kind === 'keyword') {
      setText(option.value);
      setUnit('');
      commit(option.value, '');
      inputRef.current?.focus();
      return;
    }

    if (unit === 'var') {
      setText('');
      setUnit(option.value);
      inputRef.current?.focus();
      return;
    }

    const typed = splitValueFieldValue(text, options).text;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(typed)) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    setText(typed);
    setUnit(option.value);
    commit(typed, option.value);
    inputRef.current?.focus();
  };

  const selectVariable = (variable: ValueFieldVariable) => {
    setText(variable.name);
    setUnit('var');
    setVariableOpen(false);
    setVariableQuery('');
    commit(variable.name, 'var');
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const stepNumericValue = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+))$/.exec(text.trim());
    if (!match) return false;
    const baseStep = unit ? 0.1 : 1;
    const amount = event.shiftKey ? 10 : event.altKey ? baseStep : 1;
    const direction = event.key === 'ArrowUp' ? 1 : -1;
    const next = String(Math.round((Number(match[1]) + direction * amount) * 100) / 100);
    event.preventDefault();
    setText(next);
    commit(next, unit);
    return true;
  };

  const currentKeyword = keywords.find(
    (option) => option.value.toLowerCase() === text.trim().toLowerCase() && unit === ''
  );
  const selectedValue =
    unit === 'var' ? 'var' : isFormatField ? selectedFormat : (currentKeyword?.value ?? unit);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selectedValue)
  );
  const selectedLabel = options.find((option) => option.value === selectedValue)?.label;

  useLayoutEffect(() => {
    if (!open || !menuRect || !menuRef.current) return;
    const optionElements = Array.from(
      menuRef.current.querySelectorAll<HTMLElement>('[role="option"]')
    );
    const option = optionElements[Math.min(activeIndex, optionElements.length - 1)];
    option?.focus({ preventScroll: true });
  }, [activeIndex, menuRect, open]);

  const handleFormatKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % options.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + options.length) % options.length);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const option = options[activeIndex];
      if (!option) return;
      event.preventDefault();
      selectOption(option);
    }
  };

  return (
    <span
      ref={rootRef}
      className={[
        'value-field',
        invalid ? 'value-field--invalid' : null,
        open || variableOpen ? 'value-field--open' : null,
        unit === 'var' ? 'value-field--variable' : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {leading !== undefined && <span className="value-field__leading">{leading}</span>}
      <input
        {...inputProps}
        ref={inputRef}
        className="value-field__input"
        placeholder={displayPlaceholder}
        value={text}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        role={availableVariables.length > 0 ? 'combobox' : undefined}
        aria-autocomplete={availableVariables.length > 0 ? 'list' : undefined}
        aria-expanded={availableVariables.length > 0 ? variableOpen : undefined}
        aria-controls={variableOpen ? variableListId : undefined}
        aria-activedescendant={
          variableOpen && filteredVariables[activeVariableIndex]
            ? `${variableListId}-option-${activeVariableIndex}`
            : undefined
        }
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          const isVariableInput = next.trimStart().startsWith('--');
          const parsed = splitValueFieldValue(next, options);
          if (isVariableInput) {
            setText(next);
            setUnit('var');
            if (availableVariables.length > 0) {
              setVariableQuery(next);
              setActiveVariableIndex(0);
              setVariableOpen(true);
              setOpen(false);
            }
          } else {
            if (unit === 'var') {
              setVariableOpen(false);
              setVariableQuery('');
            }
            if (!isFormatField && parsed.unit) {
              setText(parsed.text);
              setUnit(parsed.unit);
            } else {
              setText(next);
              if (!isFormatField && /[a-z%)]$/i.test(next.trim())) setUnit('');
            }
          }
          if (invalid) setInvalid(false);
        }}
        onFocus={(event) => {
          event.currentTarget.select();
          if (unit === 'var' && availableVariables.length > 0) {
            setVariableQuery('');
            setActiveVariableIndex(
              Math.max(
                0,
                availableVariables.findIndex((variable) => variable.name === text)
              )
            );
            setVariableOpen(true);
            setOpen(false);
          }
        }}
        onBlur={(event) => {
          if (
            rootRef.current?.contains(event.relatedTarget) ||
            menuRef.current?.contains(event.relatedTarget) ||
            variableMenuRef.current?.contains(event.relatedTarget)
          )
            return;
          setVariableOpen(false);
          setVariableQuery('');
          commit();
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (variableOpen) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveVariableIndex((current) =>
                filteredVariables.length ? (current + 1) % filteredVariables.length : 0
              );
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveVariableIndex((current) =>
                filteredVariables.length
                  ? (current - 1 + filteredVariables.length) % filteredVariables.length
                  : 0
              );
              return;
            }
            if (event.key === 'Enter' && filteredVariables[activeVariableIndex]) {
              event.preventDefault();
              selectVariable(filteredVariables[activeVariableIndex]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setVariableOpen(false);
              setVariableQuery('');
              return;
            }
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            const restored = splitValueFieldValue(value, options);
            setText(restored.text);
            setUnit(restored.unit);
            setInvalid(false);
            event.currentTarget.select();
          } else {
            stepNumericValue(event);
          }
        }}
      />
      {hasSelectableOptions && (
        <button
          ref={triggerRef}
          type="button"
          className="value-field__unit"
          aria-label={`${ariaLabel ?? 'Value'} format`}
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-expanded={open}
          onPointerDown={(event) => {
            // Toggle on pointerdown so the opening gesture is complete before the
            // outside-dismiss listener can be attached. Keep focus in the input;
            // moving focus to this segment can make WebKit commit the value and
            // refresh the editor before the menu opens.
            event.preventDefault();
            event.stopPropagation();
            pointerToggleRef.current = true;
            keyboardToggleRef.current = false;
            setVariableOpen(false);
            setOpen((current) => !current);
          }}
          onClick={(event) => {
            event.stopPropagation();
            // Pointerdown already toggles the menu. Ignore its later click even
            // when the browser reports a zero click detail or dispatches it late.
            if (pointerToggleRef.current) {
              pointerToggleRef.current = false;
              return;
            }
            // Enter/Space opens from onKeyDown; ignore that keyboard-generated
            // click so keyboard activation does not toggle twice.
            if (keyboardToggleRef.current) {
              keyboardToggleRef.current = false;
              return;
            }
            setActiveIndex(selectedIndex);
            setVariableOpen(false);
            setOpen((current) => !current);
          }}
          onKeyDown={(event) => {
            if (open || !['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            keyboardToggleRef.current = true;
            setActiveIndex(selectedIndex);
            setVariableOpen(false);
            setOpen(true);
          }}
        >
          {selectedLabel ?? '-'}
        </button>
      )}
      {open &&
        menuRect &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="value-field__menu"
            role="listbox"
            aria-label={`${ariaLabel ?? 'Value'} formats`}
            style={{ top: menuRect.top, right: menuRect.right }}
            tabIndex={-1}
            onKeyDown={handleFormatKeyDown}
          >
            {options.map((option, index) => {
              const selected = option.value === selectedValue;
              return (
                <button
                  key={`${option.kind ?? 'unit'}:${option.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  className={`value-field__option${selected ? ' value-field__option--selected' : ''}`}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => selectOption(option)}
                >
                  <span className="value-field__check" aria-hidden>
                    {selected && <CheckIcon size={14} />}
                  </span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>,
          document.body
        )}
      {variableOpen &&
        menuRect &&
        createPortal(
          <div
            ref={variableMenuRef}
            id={variableListId}
            className="value-field__menu value-field__variable-menu"
            role="listbox"
            aria-label={`${ariaLabel ?? 'Value'} variables`}
            style={{
              top: menuRect.top,
              left: menuRect.variableLeft,
              width: menuRect.variableWidth,
            }}
          >
            {filteredVariables.length > 0 ? (
              filteredVariables.map((variable, index) => (
                <VariableRow
                  key={`${variable.name}:${variable.value ?? ''}`}
                  variable={variable}
                  selected={variable.name === text}
                  active={index === activeVariableIndex}
                  optionId={`${variableListId}-option-${index}`}
                  onSelect={() => selectVariable(variable)}
                  onActivate={() => setActiveVariableIndex(index)}
                />
              ))
            ) : (
              <span className="value-field__variable-empty">No matching variables</span>
            )}
          </div>,
          document.body
        )}
    </span>
  );
}
