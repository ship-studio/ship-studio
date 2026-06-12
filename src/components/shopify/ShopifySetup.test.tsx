/**
 * Tests for the Shopify theme preview gate: CLI missing → agent hand-off,
 * store missing → inline connect form, already connected → straight to ready.
 */

import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockIPC } from '@tauri-apps/api/mocks';
import { ShopifySetup } from './ShopifySetup';

interface MockState {
  cliInstalled: boolean;
  store: string | null;
  savedStores: string[];
}

const state: MockState = { cliInstalled: false, store: null, savedStores: [] };

// The global afterEach (test/setup.ts) clearMocks() wipes the IPC handler after
// every test, so register a self-contained handler per test.
beforeEach(() => {
  state.cliInstalled = false;
  state.store = null;
  state.savedStores = [];
  mockIPC((cmd, args) => {
    if (cmd === 'check_shopify_cli_status') {
      return { installed: state.cliInstalled, version: state.cliInstalled ? '3.80.0' : null };
    }
    if (cmd === 'get_shopify_store') return state.store;
    if (cmd === 'set_shopify_store') {
      state.savedStores.push((args as { store: string }).store);
      return null;
    }
    return undefined;
  });
});

function renderGate() {
  const onSendToAgent = vi.fn();
  const onReady = vi.fn();
  const onConnected = vi.fn();
  render(
    <ShopifySetup
      projectPath="/Users/test/ShipStudio/my-theme"
      onSendToAgent={onSendToAgent}
      onReady={onReady}
      onConnected={onConnected}
    />
  );
  return { onSendToAgent, onReady, onConnected };
}

it('offers the agent hand-off when the Shopify CLI is missing', async () => {
  const { onSendToAgent, onReady } = renderGate();
  expect(await screen.findByText('Set up the Shopify CLI')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Set up with AI'));
  expect(onSendToAgent).toHaveBeenCalledTimes(1);
  expect(onSendToAgent.mock.calls[0]?.[0]).toContain('Shopify CLI');
  expect(onReady).not.toHaveBeenCalled();
});

it('connects a store: normalizes input, persists it, and reports connected', async () => {
  state.cliInstalled = true;
  const { onConnected, onReady } = renderGate();
  expect(await screen.findByText('Connect your Shopify store')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('my-store.myshopify.com'), {
    target: { value: 'My-Store' },
  });
  fireEvent.click(screen.getByText('Connect store'));

  await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  expect(state.savedStores).toEqual(['my-store.myshopify.com']);
  expect(onReady).not.toHaveBeenCalled();
});

it('rejects input that is not a store domain without saving', async () => {
  state.cliInstalled = true;
  renderGate();
  fireEvent.change(await screen.findByPlaceholderText('my-store.myshopify.com'), {
    target: { value: 'not a store!!' },
  });
  fireEvent.click(screen.getByText('Connect store'));

  expect(
    await screen.findByText('Enter your store domain, like my-store.myshopify.com')
  ).toBeInTheDocument();
  expect(state.savedStores).toEqual([]);
});

it('skips straight to ready when CLI and store are already in place', async () => {
  state.cliInstalled = true;
  state.store = 'my-store.myshopify.com';
  const { onReady, onConnected } = renderGate();

  await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  expect(onConnected).not.toHaveBeenCalled();
});
