import { describe, expect, it } from 'vitest';
import { predictNextDeclaration } from './cssPredict';

const d = (prop: string, value: string) => ({ prop, value });

describe('predictNextDeclaration', () => {
  it('returns null for an empty rule', () => {
    expect(predictNextDeclaration([])).toBeNull();
  });

  it('suggests flex companions in order, skipping ones already present', () => {
    expect(predictNextDeclaration([d('display', 'flex')])).toMatchObject({ prop: 'align-items' });
    expect(predictNextDeclaration([d('display', 'flex'), d('align-items', 'start')])).toMatchObject(
      { prop: 'justify-content' }
    );
    expect(
      predictNextDeclaration([
        d('display', 'flex'),
        d('align-items', 'start'),
        d('justify-content', 'start'),
      ])
    ).toMatchObject({ prop: 'gap' });
  });

  it('also fires for grid', () => {
    expect(predictNextDeclaration([d('display', 'grid')])).toMatchObject({ prop: 'align-items' });
  });

  it('does not suggest flex companions without a flex/grid display', () => {
    expect(predictNextDeclaration([d('display', 'block')])).toBeNull();
  });

  it('suggests an inset for positioned elements, not for static', () => {
    expect(predictNextDeclaration([d('position', 'absolute')])).toMatchObject({ prop: 'inset' });
    expect(predictNextDeclaration([d('position', 'relative')])).toBeNull();
    // Already has an offset → nothing.
    expect(predictNextDeclaration([d('position', 'fixed'), d('top', '0')])).toBeNull();
  });

  it('respects the exclude set (just-dismissed props)', () => {
    expect(predictNextDeclaration([d('display', 'flex')], new Set(['align-items']))).toMatchObject({
      prop: 'justify-content',
    });
  });

  it('suggests a positioning context when z-index has none', () => {
    expect(predictNextDeclaration([d('z-index', '10')])).toMatchObject({
      prop: 'position',
      value: 'relative',
    });
    expect(
      predictNextDeclaration([d('z-index', '10'), d('position', 'absolute')])
    ).not.toMatchObject({ prop: 'position' });
  });

  it('pairs font-size with a line-height', () => {
    expect(predictNextDeclaration([d('font-size', '14px')])).toMatchObject({ prop: 'line-height' });
  });

  it('walks the single-line truncation trio', () => {
    expect(predictNextDeclaration([d('white-space', 'nowrap')])).toMatchObject({
      prop: 'overflow',
    });
    expect(
      predictNextDeclaration([d('white-space', 'nowrap'), d('overflow', 'hidden')])
    ).toMatchObject({ prop: 'text-overflow', value: 'ellipsis' });
    expect(predictNextDeclaration([d('text-overflow', 'ellipsis')])).toMatchObject({
      prop: 'white-space',
    });
  });

  it('completes a transition shorthand sequence', () => {
    expect(predictNextDeclaration([d('transition-property', 'color')])).toMatchObject({
      prop: 'transition-duration',
    });
    expect(
      predictNextDeclaration([d('transition-property', 'color'), d('transition-duration', '0.2s')])
    ).toMatchObject({ prop: 'transition-timing-function' });
  });

  it('suggests grid columns for a grid container', () => {
    expect(
      predictNextDeclaration([
        d('display', 'grid'),
        d('align-items', 'center'),
        d('justify-content', 'center'),
        d('gap', '1rem'),
      ])
    ).toMatchObject({ prop: 'grid-template-columns' });
  });

  it('suggests cursor:pointer only for clickable-looking selectors', () => {
    expect(
      predictNextDeclaration([d('color', 'white')], new Set(), { selector: '.btn' })
    ).toMatchObject({ prop: 'cursor', value: 'pointer' });
    expect(
      predictNextDeclaration([d('color', 'white')], new Set(), { selector: 'a:hover' })
    ).toMatchObject({ prop: 'cursor', value: 'pointer' });
    // A plain container selector gets no cursor suggestion.
    expect(
      predictNextDeclaration([d('color', 'white')], new Set(), { selector: '.card' })
    ).toBeNull();
  });

  it('prefers a project design token for the suggested value when one fits', () => {
    // gap → a spacing token
    expect(
      predictNextDeclaration(
        [d('display', 'flex'), d('align-items', 'center'), d('justify-content', 'center')],
        new Set(),
        {
          variables: ['--space-4', '--gap', '--color-primary'],
        }
      )
    ).toMatchObject({ prop: 'gap', value: 'var(--gap)' });
    // border-radius → a radius token
    expect(
      predictNextDeclaration([d('overflow', 'hidden')], new Set(), { variables: ['--radius'] })
    ).toMatchObject({ prop: 'border-radius', value: 'var(--radius)' });
    // No matching token → keep the literal.
    expect(
      predictNextDeclaration(
        [d('display', 'flex'), d('align-items', 'center'), d('justify-content', 'center')],
        new Set(),
        {
          variables: ['--font-body'],
        }
      )
    ).toMatchObject({ prop: 'gap', value: '1rem' });
    // Never tokenize a `0`.
    expect(
      predictNextDeclaration([d('position', 'absolute')], new Set(), { variables: ['--space'] })
    ).toMatchObject({ prop: 'inset', value: '0' });
  });
});
