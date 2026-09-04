import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkflowTemplatePicker } from './WorkflowTemplatePicker';
import { browsableTemplates, type WorkflowTemplate } from '../../lib/workflowTemplates';

/** The picker is controlled; this is the modal's half of the contract. */
function Harness({ initialId }: { initialId?: string }) {
  const first = browsableTemplates().find((t) => t.starter) ?? browsableTemplates()[0];
  const [selected, setSelected] = useState<WorkflowTemplate>(
    browsableTemplates().find((t) => t.id === initialId) ?? first
  );
  return <WorkflowTemplatePicker selectedId={selected.id} onSelect={(next) => setSelected(next)} />;
}

describe('WorkflowTemplatePicker', () => {
  it('shows what a template would put in your Inbox, not just what it looks at', () => {
    // The whole reason this screen is a two-pane preview: a name and a
    // description cannot answer "what would I actually get".
    render(<Harness initialId="tpl-security" />);
    expect(screen.getByText('What lands in your Inbox')).toBeInTheDocument();
    expect(screen.getByText('Checkout route trusts the cookie header for identity')).toBeVisible();
    expect(screen.getByText('src/app/api/checkout/route.ts:12')).toBeVisible();
  });

  it('marks the example as an example, so nobody reads it as a real finding', () => {
    render(<Harness initialId="tpl-security" />);
    expect(screen.getByText(/An example, not a real finding/)).toBeVisible();
  });

  it('shows the instruction the agent will actually be given', () => {
    render(<Harness initialId="tpl-a11y" />);
    expect(screen.getByText('What it tells the agent')).toBeInTheDocument();
    expect(screen.getByText(/an interactive element that is a div/)).toBeVisible();
  });

  it('opens on a starter rather than on nothing', () => {
    // An unchosen picker is an empty preview pane and a dead primary button,
    // which reads as broken rather than as an invitation.
    render(<Harness />);
    const selected = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });

  it('leads with a Start here group before the categories', () => {
    render(<Harness />);
    // Scoped to the list: the filter control carries the same category words.
    const list = within(screen.getByRole('listbox', { name: 'Templates' }));
    const groups = list.getAllByText(
      /^(Start here|Security|Quality|Content|Maintenance|Research)$/
    );
    expect(groups[0]).toHaveTextContent('Start here');
  });

  it('filters the list down to one category', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const filter = within(screen.getByRole('group', { name: 'Filter templates' }));
    await user.click(filter.getByRole('button', { name: 'Security' }));

    const list = within(screen.getByRole('listbox', { name: 'Templates' }));
    expect(list.getByText('Security sweep')).toBeVisible();
    expect(list.queryByText('Copy review')).not.toBeInTheDocument();
    expect(list.queryByText('Start here')).not.toBeInTheDocument();
  });

  it('selects a template when its row is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness initialId="tpl-security" />);
    await user.click(screen.getByRole('option', { name: /Copy review/ }));
    expect(screen.getByRole('option', { name: /Copy review/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText(/product name is spelled three ways/i)).toBeVisible();
  });

  it('walks the list with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const before = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    await user.click(before!);
    await user.keyboard('{ArrowDown}');
    const after = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(after).not.toBe(before);
  });

  it('says what a template needs before it can be useful', () => {
    // "Nothing happened" is the worst outcome of a first run, and for these
    // two it is entirely predictable.
    render(<Harness initialId="tpl-links" />);
    expect(screen.getByText(/Needs the project open with its dev server running/)).toBeVisible();
  });

  it('states the three facts about every run, on every template', () => {
    render(<Harness initialId="tpl-copy" />);
    expect(screen.getByText(/Read-only — enforced by the agent CLI/)).toBeVisible();
    expect(screen.getByText(/plan you already pay for/)).toBeVisible();
    // And the honest one: a schedule the app cannot keep while closed.
    expect(screen.getByText(/while it is open/)).toBeVisible();
  });

  it('never offers the blank template as a browsable choice', () => {
    render(<Harness />);
    expect(screen.queryByRole('option', { name: /Blank workflow/ })).not.toBeInTheDocument();
  });
});
