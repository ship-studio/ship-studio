import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CssValueText } from './CssValueText';

describe('CssValueText', () => {
  it('keeps highlighted variable references in one wrapping text flow', () => {
    const { container } = render(
      <CssValueText value="var(--font-body), system-ui, -apple-system, sans-serif" />
    );

    const text = container.querySelector('.ss-css-value-text');
    expect(text).toBeInTheDocument();
    expect(text).toHaveTextContent('var(--font-body), system-ui, -apple-system, sans-serif');
    expect(text?.querySelectorAll('.ss-css-variable')).toHaveLength(1);
  });
});
