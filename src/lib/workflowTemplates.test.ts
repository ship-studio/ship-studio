import { describe, expect, it } from 'vitest';
import {
  BLANK_TEMPLATE_ID,
  browsableTemplates,
  TEMPLATE_CATEGORIES,
  WORKFLOW_TEMPLATES,
} from './workflowTemplates';

describe('WORKFLOW_TEMPLATES', () => {
  it('has unique ids and a blank option', () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(BLANK_TEMPLATE_ID);
  });

  it('ships every template read-only', () => {
    // A starter that can edit files unattended is not a starting point, it's a
    // trap. Opting into can-edit must be a deliberate act in the editor.
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.permission).toBe('read-only');
    }
  });

  it('gives every non-blank template a prompt and a description', () => {
    for (const template of browsableTemplates()) {
      expect(template.prompt.trim().length).toBeGreaterThan(0);
      expect(template.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('ships no template that fires more often than hourly', () => {
    // Templates are picked before anyone has watched a single run, so their
    // cadence is the one nobody thinks about. An agent on a 15-minute loop
    // spends real quota on an unchanged tree ~96 times a day; that is a choice
    // to make deliberately in the editor, never a default we handed out.
    for (const template of WORKFLOW_TEMPLATES) {
      if (template.trigger.kind === 'interval') {
        expect(template.trigger.everyMinutes).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('gives every template an icon, so no row falls back to a bare dot', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('shows every browsable template what it would put in your Inbox', () => {
    // The example is what the picker is built around: a description says what
    // a workflow looks at, and only an example says what comes back.
    for (const template of browsableTemplates()) {
      expect(template.example, `${template.id} has no example finding`).toBeDefined();
      expect(template.example?.title.trim().length).toBeGreaterThan(0);
      expect(template.example?.summary.trim().length).toBeGreaterThan(0);
    }
  });

  it('tells every prompt what not to report', () => {
    // The way a workflow fails is by being noisy, and an agent asked to find
    // problems will always find some. Every template has to say where the
    // floor is.
    const restraint = /ignore|skip|only report|do not report|don't file|only flag|not the whole/i;
    for (const template of browsableTemplates()) {
      expect(restraint.test(template.prompt), `${template.id} never says what to leave out`).toBe(
        true
      );
    }
  });

  it('offers a handful of starters, and they all produce something on the first Run', () => {
    const starters = browsableTemplates().filter((template) => template.starter);
    expect(starters.length).toBeGreaterThanOrEqual(2);
    expect(starters.length).toBeLessThanOrEqual(4);
    for (const starter of starters) {
      // An event-triggered starter does nothing until you push, which is a
      // poor first impression for someone trying the feature out.
      expect(starter.requires, `${starter.id} needs setup before it works`).toBeUndefined();
    }
  });

  it('avoids glyphs that disappear on a dark surface', () => {
    // 🕶️ rendered as two grey dashes in the picker: the emoji is almost
    // entirely black, and every surface this app has is dark.
    const invisibleOnDark = ['🕶️', '🖤', '⚫', '◾', '▪️', '🎱', '🕳️'];
    for (const template of WORKFLOW_TEMPLATES) {
      expect(invisibleOnDark, `${template.id} uses a glyph that vanishes on dark`).not.toContain(
        template.icon
      );
    }
  });

  it('files every template under a category the picker offers', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(TEMPLATE_CATEGORIES).toContain(template.category);
    }
  });

  it('covers every category with at least two templates', () => {
    // A category chip that filters down to one option is a worse experience
    // than not having the chip.
    for (const category of TEMPLATE_CATEGORIES) {
      const count = browsableTemplates().filter((t) => t.category === category).length;
      expect(count, `${category} has ${count} template(s)`).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the blank template out of the browsable list', () => {
    expect(browsableTemplates().some((t) => t.id === BLANK_TEMPLATE_ID)).toBe(false);
  });
});
