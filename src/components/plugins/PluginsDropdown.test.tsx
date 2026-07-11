/**
 * Tests for PluginsDropdown accounting — load-failed plugins render as greyed
 * rows (clicking explains why), and installed hosting plugins get a footer
 * note so the visible count matches the installed count.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginsDropdown } from './PluginsDropdown';
import type { PluginAppActions, PluginThemeData } from '../../contexts/PluginContext';

const theme: PluginThemeData = {
  bgPrimary: '',
  bgSecondary: '',
  bgTertiary: '',
  textPrimary: '',
  textSecondary: '',
  textMuted: '',
  border: '',
  accent: '',
  accentHover: '',
  action: '',
  actionHover: '',
  actionText: '',
  error: '',
  success: '',
};

function makeActions() {
  const showToast = vi.fn();
  const actions: PluginAppActions = {
    showToast,
    refreshGitStatus: vi.fn(),
    refreshBranches: vi.fn(),
    focusTerminal: vi.fn(),
    openUrl: vi.fn(),
    openTerminal: vi.fn(() => Promise.resolve(null)),
  };
  return { actions, showToast };
}

function renderDropdown(overrides: Partial<Parameters<typeof PluginsDropdown>[0]> = {}) {
  const { actions, showToast } = makeActions();
  render(
    <PluginsDropdown
      plugins={[]}
      pluginProject={null}
      pluginActions={actions}
      pluginTheme={theme}
      onOpenPluginManager={vi.fn()}
      {...overrides}
    />
  );
  return { showToast };
}

describe('PluginsDropdown', () => {
  it('renders a load-failed plugin as a greyed row and toasts on click', () => {
    const { showToast } = renderDropdown({
      failures: [{ id: 'figma', name: 'Figma', reason: 'bundle failed to parse' }],
    });

    const row = screen.getByText('Figma').closest('.plugin-dropdown-row');
    expect(row).not.toBeNull();
    expect(row).toHaveClass('plugin-dropdown-row--failed');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    // The error chip carries the reason in its tooltip
    expect(screen.getByLabelText('Figma unavailable')).toHaveAttribute(
      'title',
      expect.stringContaining('bundle failed to parse')
    );

    fireEvent.click(row as HTMLElement);
    expect(showToast).toHaveBeenCalledWith(
      'Figma is unavailable — it may have crashed. Check the plugin manager.',
      'error'
    );
  });

  it('shows a hosting-plugin footer instead of the empty hint', () => {
    renderDropdown({ hostingPluginCount: 2 });
    expect(screen.getByText('2 hosting plugins live in the toolbar')).toBeInTheDocument();
    expect(screen.queryByText('No plugins installed yet.')).not.toBeInTheDocument();
  });

  it('uses singular phrasing for one hosting plugin', () => {
    renderDropdown({ hostingPluginCount: 1 });
    expect(screen.getByText('1 hosting plugin lives in the toolbar')).toBeInTheDocument();
  });

  it('shows the empty hint only when nothing is installed at all', () => {
    renderDropdown();
    expect(screen.getByText('No plugins installed yet.')).toBeInTheDocument();
  });
});
