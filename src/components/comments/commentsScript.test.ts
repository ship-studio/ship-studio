import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import script from '../../../src-tauri/src/proxy/comments_script.html?raw';

function send(data: object, source: MessageEventSource = window) {
  window.dispatchEvent(
    new MessageEvent('message', { source, data: { channel: 'ss:comments-host', ...data } })
  );
}
let posted: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  Object.defineProperty(window, 'CSS', { value: { escape: (s: string) => s }, configurable: true });
  window.eval(script.replace(/^<script>/, '').replace(/<\/script>\s*$/, ''));
});
beforeEach(() => {
  document.body.innerHTML =
    '<main><section id="hero"><h1>Build great things</h1><a href="/other">Go</a></section><section id="next">Next</section></main>';
  posted = vi.spyOn(window.parent, 'postMessage');
});
afterEach(() => {
  send({ type: 'sync', enabled: false });
  posted.mockRestore();
});
it('is inert until explicitly activated and rejects messages from other frames', () => {
  send({ type: 'sync', enabled: true, picking: true, notes: [] }, {} as Window);
  document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(posted.mock.calls.some(([d]) => (d as { type: string }).type === 'selected')).toBe(false);
});
it('captures the real target, blocks navigation while picking, and supports selecting its parent', () => {
  send({ type: 'sync', enabled: true, picking: true, notes: [], accent: 'blue', ink: 'white' });
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  document.querySelector('h1')!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(posted).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'selected',
      target: expect.objectContaining({
        tag: 'h1',
        heading: 'Build great things',
        selector: '#hero > h1:nth-of-type(1)',
      }) as unknown,
    }),
    '*'
  );
  send({ type: 'parent' });
  expect(posted).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'selected',
      target: expect.objectContaining({ tag: 'section', selector: '#hero' }) as unknown,
    }),
    '*'
  );
});
it('does not silently attach a stale selector to changed content', () => {
  send({ type: 'sync', enabled: true, picking: true, notes: [], accent: 'blue', ink: 'white' });
  send({
    type: 'locate',
    id: 'one',
    target: {
      page: location.pathname + location.search + location.hash,
      selector: '#hero',
      tag: 'section',
      text: 'Old hero content',
    },
  });
  expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'missing', id: 'one' }), '*');
});
it('does not select another element while a draft is being written', () => {
  send({ type: 'sync', enabled: true, picking: false, notes: [] });
  document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(posted.mock.calls.some(([d]) => (d as { type: string }).type === 'selected')).toBe(false);
});

it('keeps the hovered target through layout updates, preserves drafts, and clears the spotlight', async () => {
  send({
    type: 'sync',
    enabled: true,
    picking: true,
    notes: [],
    accent: '#46e76f',
    scrim: 'rgba(0, 0, 0, 0.3)',
  });
  const heading = document.querySelector('h1')!;
  vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue({
    left: 20,
    top: 40,
    width: 240,
    height: 80,
  } as DOMRect);
  heading.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  const host = document.querySelector('[data-ss-overlay="comments"]') as HTMLElement;
  const outline = host.shadowRoot!.querySelector('.outline') as HTMLElement;
  expect(host.style.getPropertyValue('--cc-accent')).toBe('#46e76f');
  expect(outline.hidden).toBe(false);
  window.dispatchEvent(new Event('scroll'));
  await new Promise(requestAnimationFrame);
  expect(outline.hidden).toBe(false);
  expect(outline.style.width).toBe('240px');
  heading.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  send({ type: 'sync', enabled: true, picking: false, notes: [] });
  await new Promise(requestAnimationFrame);
  expect(outline.hidden).toBe(false);
  send({ type: 'clear' });
  expect(outline.hidden).toBe(true);
  send({ type: 'sync', enabled: true, picking: true, notes: [] });
  heading.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  heading.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
  expect(outline.hidden).toBe(true);
});

it('keeps saved targets locatable without rendering numbered canvas pins', async () => {
  send({
    type: 'sync',
    enabled: true,
    picking: true,
    notes: [
      {
        id: 'saved',
        number: 42,
        target: {
          page: location.pathname + location.search + location.hash,
          selector: '#hero',
          tag: 'section',
          text: '',
        },
      },
    ],
  });
  await new Promise(requestAnimationFrame);
  const host = document.querySelector('[data-ss-overlay="comments"]')!;
  expect(host.shadowRoot!.querySelectorAll('button')).toHaveLength(0);
  expect(host.shadowRoot!.textContent).not.toContain('42');
});
