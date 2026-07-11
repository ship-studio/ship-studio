/**
 * Structured model for a CSS rule's body, for the cascade card GUI. A rule body is
 * an ordered list of items — declarations (`prop: value`) and nested rules
 * (`&:hover { … }`) — so the card can render/edit each as a row or a nested card and
 * serialize the whole thing back to source CSS, written verbatim via
 * `apply_css_rule_text` (`edit_css.rs`).
 *
 * The parser is a hand-written, comment/string/brace-aware splitter — a JS port of
 * `index_rules` + `locate_declarations` in `edit_css.rs`, recursive for CSS nesting.
 * No CSS-parser dependency.
 */

import type { MatchedRule } from './cssCascade';

/** One `property: value` declaration. */
export interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

/** A nested rule inside a body (`& .icon { … }`, `&:hover { … }`, `@media … { … }`). */
export interface NestedRule {
  selector: string;
  body: RuleBody;
}

/** An ordered body item — kept ordered so serialization preserves source order. */
export type BodyItem =
  | ({ kind: 'decl' } & Decl)
  | { kind: 'rule'; selector: string; body: RuleBody }
  | { kind: 'comment'; text: string };

/** A rule body: its items in source order. */
export interface RuleBody {
  items: BodyItem[];
}

/** The declaration items of a body, in order. */
export function declarations(body: RuleBody): ({ index: number } & Decl)[] {
  return body.items.flatMap((it, index) =>
    it.kind === 'decl' ? [{ index, prop: it.prop, value: it.value, important: it.important }] : []
  );
}

/** The nested-rule items of a body, in order. */
export function nestedRules(body: RuleBody): ({ index: number } & NestedRule)[] {
  return body.items.flatMap((it, index) =>
    it.kind === 'rule' ? [{ index, selector: it.selector, body: it.body }] : []
  );
}

/** First top-level `:` (paren/string-aware) — the property/value split point. */
function findColon(t: string): number {
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (ch === '"' || ch === "'") {
      const q = ch;
      k++;
      while (k < t.length && t[k] !== q) {
        if (t[k] === '\\') k++;
        k++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      // Guard against underflow on a stray `)` — without it, depth goes negative and
      // the real top-level `:` is never found, so the declaration is silently dropped.
      if (depth > 0) depth--;
    } else if (ch === ':' && depth === 0) return k;
  }
  return -1;
}

/** Parse a trailing `!important` off a value. */
function splitImportant(value: string): { value: string; important: boolean } {
  const m = /!\s*important\s*$/i.exec(value);
  if (m) return { value: value.slice(0, m.index).trim(), important: true };
  return { value: value.trim(), important: false };
}

/** Parse the text inside a rule's braces into an ordered body model. */
export function parseRuleBody(src: string): RuleBody {
  const items: BodyItem[] = [];
  const n = src.length;
  let i = 0;
  let prelude = '';
  // Paren depth so `;` / `{` / `}` inside `(...)` — e.g. an unquoted data URI
  // `url(data:…;utf8,…)` — don't terminate a declaration or start a nested rule.
  let paren = 0;

  const pushDecl = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const ci = findColon(t);
    if (ci < 0) return; // not a declaration (e.g. a stray token) — drop it
    const prop = t.slice(0, ci).trim();
    const { value, important } = splitImportant(t.slice(ci + 1).trim());
    if (prop && value) items.push({ kind: 'decl', prop, value, important });
  };

  while (i < n) {
    const c = src[i];
    // Comment — preserved, not dropped (a write-back would otherwise delete an
    // author's `/* … */` annotation). A comment sitting BETWEEN items (the prelude is
    // empty/whitespace) becomes its own ordered body item so it round-trips in place;
    // a comment WITHIN a declaration (`color: /* x */ red`) stays inline in that
    // declaration's text.
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j + 1 < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const end = j + 1 < n ? j + 2 : n; // include the closing */ when present
      const text = src.slice(i, end);
      if (prelude.trim() === '') items.push({ kind: 'comment', text });
      else prelude += text;
      i = end;
      continue;
    }
    // String — copy verbatim into the current segment.
    if (c === '"' || c === "'") {
      const q = c;
      prelude += c;
      let j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') {
          prelude += src[j] + (src[j + 1] ?? '');
          j += 2;
          continue;
        }
        prelude += src[j];
        j++;
      }
      prelude += src[j] ?? '';
      i = j + 1;
      continue;
    }
    if (c === '(') {
      paren++;
      prelude += c;
      i++;
      continue;
    }
    if (c === ')') {
      if (paren > 0) paren--;
      prelude += c;
      i++;
      continue;
    }
    if (c === '{' && paren === 0) {
      // The accumulated prelude is a nested-rule selector; find its matching close.
      const selector = prelude.trim();
      prelude = '';
      let depth = 1;
      let p = 0; // paren depth — `{`/`}` inside `(...)` (e.g. a url()) aren't braces
      let j = i + 1;
      const start = j;
      while (j < n && depth > 0) {
        const d = src[j];
        if (d === '/' && src[j + 1] === '*') {
          j += 2;
          while (j + 1 < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
          j += 2;
          continue;
        }
        if (d === '"' || d === "'") {
          const q = d;
          j++;
          while (j < n && src[j] !== q) {
            if (src[j] === '\\') j++;
            j++;
          }
          j++;
          continue;
        }
        if (d === '(') p++;
        else if (d === ')') {
          if (p > 0) p--;
        } else if (p === 0 && d === '{') depth++;
        else if (p === 0 && d === '}') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      const innerNested = src.slice(start, j);
      if (selector) items.push({ kind: 'rule', selector, body: parseRuleBody(innerNested) });
      i = j + 1;
      continue;
    }
    if (c === ';' && paren === 0) {
      pushDecl(prelude);
      prelude = '';
      i++;
      continue;
    }
    if (c === '}' && paren === 0) break; // stray close — stop
    prelude += c;
    i++;
  }
  pushDecl(prelude); // a final declaration with no trailing semicolon
  return { items };
}

const pad = (level: number) => '  '.repeat(Math.max(0, level));

/** Serialize a body back to CSS text (the content between a rule's braces), with the
 *  leading/trailing newlines + indentation needed to splice into `selector {…}`.
 *  Round-trips: re-parsing the output yields the same model. */
export function serializeRuleBody(body: RuleBody, level = 1): string {
  const at = pad(level);
  const lines = body.items
    // Skip half-written declarations (a just-added property with no value yet) so we
    // never write `prop: ;` to source — they live in the model until a value is typed.
    .filter((it) => it.kind !== 'decl' || (it.prop.trim() !== '' && it.value.trim() !== ''))
    .map((it) => {
      if (it.kind === 'decl') {
        return `${at}${it.prop}: ${it.value}${it.important ? ' !important' : ''};`;
      }
      if (it.kind === 'comment') {
        return `${at}${it.text}`;
      }
      return `${at}${it.selector} {${serializeRuleBody(it.body, level + 1)}}`;
    });
  if (lines.length === 0) return '\n' + pad(level - 1);
  return `\n${lines.join('\n')}\n${pad(level - 1)}`;
}

/** Overridden properties → the selector that wins each (for the strike-through and
 *  "overridden by …" tooltip). Lowercased prop names; best-effort for shorthands.
 *  Only TRUE overrides (another rule actually wins) are included — a declaration
 *  that's merely inactive because its rule's @media doesn't match the current
 *  viewport has no `overriddenBy` and is left out (the card is dimmed instead). */
export function overriddenProps(row: Pick<MatchedRule, 'declarations'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of row.declarations) {
    if (!d.active && d.overriddenBy) out.set(d.prop.toLowerCase(), d.overriddenBy);
  }
  return out;
}

/** Append a new declaration after the last declaration (before trailing nested rules),
 *  returning a new body (immutable update). */
export function addDeclaration(body: RuleBody, decl: Decl): RuleBody {
  const items = [...body.items];
  let insertAt = 0;
  items.forEach((it, idx) => {
    if (it.kind === 'decl') insertAt = idx + 1;
  });
  items.splice(insertAt, 0, { kind: 'decl', ...decl });
  return { items };
}

/** Append a new nested rule at the end of the body. */
export function addNestedRule(body: RuleBody, selector: string): RuleBody {
  return { items: [...body.items, { kind: 'rule', selector, body: { items: [] } }] };
}

/** Remove the item at `index`. */
export function removeItem(body: RuleBody, index: number): RuleBody {
  return { items: body.items.filter((_, i) => i !== index) };
}

/** Replace the item at `index` (immutably). */
export function replaceItem(body: RuleBody, index: number, item: BodyItem): RuleBody {
  return { items: body.items.map((it, i) => (i === index ? item : it)) };
}

/** Move the declaration at `declIndex` into a nested rule for `selector` — appending
 *  to that nested rule if it already exists, else creating it at the end. No-op if
 *  the item isn't a declaration. The power-user "take this declaration and nest it"
 *  action. */
export function moveDeclIntoNested(body: RuleBody, declIndex: number, selector: string): RuleBody {
  const item = body.items[declIndex];
  if (!item || item.kind !== 'decl') return body;
  const decl: BodyItem = {
    kind: 'decl',
    prop: item.prop,
    value: item.value,
    important: item.important,
  };
  const rest = body.items.filter((_, i) => i !== declIndex);
  const target = rest.find((it) => it.kind === 'rule' && it.selector === selector);
  if (target && target.kind === 'rule') {
    return {
      items: rest.map((it) =>
        it === target ? { ...it, body: { items: [...it.body.items, decl] } } : it
      ),
    };
  }
  return { items: [...rest, { kind: 'rule', selector, body: { items: [decl] } }] };
}
