/**
 * Regression cover for the pinned-comment geometry.
 *
 * Every bug in this layer so far was found by a human looking at a screenshot,
 * not by a test — and all of them were deterministic positioning or wiring
 * mistakes that jsdom can see perfectly well. These lock the ones that shipped
 * broken: a card that stuck to the frame instead of scrolling away with its
 * element, a composer anchored to a stale rect, and inputs that fell back to
 * browser defaults when they were moved out of the panel's stylesheet scope.
 */
import { expect, it, describe, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CommentPins } from './CommentPins';
import { CommentComposer } from './CommentComposer';
import type { CanvasComment, CommentPlacement } from '../../lib/canvasComments';

const target = {
  page: '/',
  selector: '#hero',
  tag: 'section',
  text: 'Hero',
  heading: 'Hero',
  classes: 'hero',
  ancestors: ['main'],
  viewport: { width: 1440, height: 900 },
  rect: { x: 0, y: 0, width: 1440, height: 900 },
};
const note: CanvasComment = {
  id: 'one',
  number: 1,
  target,
  body: 'Make it 80vh',
  status: 'pending',
  createdAt: '2026-09-06',
};

function renderPins(placement: Partial<CommentPlacement>, scale = 1, bounds = { w: 1200, h: 800 }) {
  cleanup();
  render(
    <CommentPins
      comments={[note]}
      placements={[{ id: 'one', x: 0, y: 0, width: 100, height: 40, ...placement }]}
      missing={[]}
      scale={scale}
      bounds={bounds}
      openId="one"
      onOpen={vi.fn()}
      excluded={new Set()}
      toggle={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onHover={vi.fn()}
    />
  );
  const pin = screen.getByRole('button', { name: /^Comment 1:/ });
  const card = document.querySelector<HTMLElement>('.canvas-comment-bubble')!;
  return { pin, card };
}

describe('pinned comment geometry', () => {
  it('places the pin on its element, scaled for the canvas', () => {
    const { pin } = renderPins({ x: 200, y: 300 }, 0.5);
    // The canvas overlay is an unscaled screen-pixel layer, so a frame
    // coordinate has to come through the scale or the pin lands off its element.
    expect(pin.style.left).toBe('100px');
    expect(pin.style.top).toBe('150px');
  });

  it('lets an open note scroll away with its element instead of sticking', () => {
    // The element has scrolled above the frame's viewport: y is negative. The
    // card must follow it off-screen. Clamping this to the top edge is the bug
    // that made a note read as a floating panel.
    const { card } = renderPins({ x: 40, y: -260 });
    expect(parseFloat(card.style.top)).toBeLessThan(0);
  });

  it('flips a card to the other side of its pin at the right edge', () => {
    const { card } = renderPins({ x: 1150, y: 100 }, 1, { w: 1200, h: 800 });
    // 260 wide + a 10px gap cannot fit in the 50px remaining, so it goes left.
    expect(parseFloat(card.style.left)).toBeLessThan(1150);
    const { card: roomy } = renderPins({ x: 100, y: 100 });
    expect(parseFloat(roomy.style.left)).toBeGreaterThan(100);
  });

  it('reports the viewport a note was written at, not a chosen scope', () => {
    renderPins({ x: 10, y: 10 });
    expect(screen.getByText(/Seen at 1440 × 900/)).toBeInTheDocument();
    expect(screen.queryByText(/Applies to/)).not.toBeInTheDocument();
  });

  it('keeps the layer click-through except for the pins and an open note', () => {
    renderPins({ x: 10, y: 10 });
    const layer = document.querySelector<HTMLElement>('.canvas-comment-layer')!;
    // The page underneath has to stay clickable — picking a new element for the
    // next comment goes through this layer.
    expect(layer).toBeInTheDocument();
    expect(layer.className).toBe('canvas-comment-layer');
  });
});

describe('the composer and note use house inputs, not browser defaults', () => {
  it('composes with the TextArea primitive', () => {
    cleanup();
    render(
      <CommentPins
        comments={[]}
        placements={[]}
        missing={[]}
        scale={1}
        bounds={{ w: 1200, h: 800 }}
        openId={null}
        onOpen={vi.fn()}
        excluded={new Set()}
        toggle={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onHover={vi.fn()}
        composer={<CommentComposer target={target} onSave={() => true} onCancel={vi.fn()} />}
        composerAt={{ x: 50, y: 60 }}
      />
    );
    // The composer lives in the pinned bubble, outside `.canvas-comments-panel`,
    // so it cannot rely on that stylesheet's descendant rules. It shipped once
    // as an unstyled white box for exactly this reason.
    const field = screen.getByLabelText('What should change?');
    expect(field.tagName).toBe('TEXTAREA');
    expect(field).toHaveClass('ss-text-field');
    expect(field).toHaveClass('ss-text-field--multiline');
  });

  it('anchors the composer to the live rect it is given, not the frame corner', () => {
    cleanup();
    render(
      <CommentPins
        comments={[]}
        placements={[]}
        missing={[]}
        scale={1}
        bounds={{ w: 1200, h: 800 }}
        openId={null}
        onOpen={vi.fn()}
        excluded={new Set()}
        toggle={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onHover={vi.fn()}
        composer={<CommentComposer target={target} onSave={() => true} onCancel={vi.fn()} />}
        composerAt={{ x: 400, y: -120 }}
      />
    );
    const bubble = document.querySelector<HTMLElement>('.canvas-comment-bubble--composing')!;
    // Negative means its element scrolled up and the form went with it, rather
    // than holding a fixed screen position and riding the viewport.
    expect(parseFloat(bubble.style.top)).toBeLessThan(0);
    expect(parseFloat(bubble.style.left)).toBeGreaterThan(400);
  });
});
