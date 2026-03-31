/**
 * cStar support integration.
 *
 * - LibraryClient: public articles/search (no auth needed)
 * - ChatClient: authenticated conversations, tickets, and messaging (HMAC identity from backend)
 *
 * All ticket/message operations go through the ChatClient SDK, which handles
 * customer linking automatically via the identify flow. The HMAC identity
 * secret stays in the Rust backend — only the signed payload is used here.
 */

import { LibraryClient } from '@cstar.help/js/library';
import { ChatClient } from '@cstar.help/js/chat';
import { invoke } from '@tauri-apps/api/core';
import type { LibraryArticle, Category } from '@cstar.help/js/library';
import type { Conversation, WidgetMessage } from '@cstar.help/js/chat';

export type { LibraryArticle, Category, Conversation, WidgetMessage };

const TEAM_SLUG = 'ship-studio';
const BASE_URL = 'https://www.cstar.help';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SupportIdentity {
  external_id: string;
  name: string;
  email: string;
  timestamp: number;
  signature: string;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return (
      d.toLocaleDateString() +
      ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  } catch {
    return '';
  }
}

// ─── Library Client (public, no auth) ────────────────────────────────────────

let _library: LibraryClient | null = null;

function getLibrary(): LibraryClient {
  if (!_library) {
    _library = new LibraryClient({ teamSlug: TEAM_SLUG, baseUrl: BASE_URL });
  }
  return _library;
}

// ─── In-memory cache (5 min TTL) ─────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000;
let _popularArticles: LibraryArticle[] | null = null;
const _articleCache = new Map<string, LibraryArticle>();
let _cacheTime = 0;

function isCacheValid() {
  return _popularArticles && Date.now() - _cacheTime < CACHE_TTL;
}

export async function searchArticles(query: string): Promise<LibraryArticle[]> {
  const result = await getLibrary().search(query);
  return result.data ?? [];
}

export async function getPopularArticles(limit = 5): Promise<LibraryArticle[]> {
  if (isCacheValid()) return _popularArticles!;
  const articles = await getLibrary().popularArticles(limit);
  _popularArticles = articles;
  _cacheTime = Date.now();
  return articles;
}

export async function getArticle(slug: string): Promise<LibraryArticle | null> {
  const cached = _articleCache.get(slug);
  if (cached) return cached;
  try {
    const article = await getLibrary().article(slug);
    if (article) _articleCache.set(slug, article);
    return article;
  } catch {
    return null;
  }
}

export async function getCategories(): Promise<Category[]> {
  return getLibrary().categories();
}

export async function recordArticleView(slug: string): Promise<void> {
  try {
    await getLibrary().recordView(slug);
  } catch {
    // Non-critical, ignore failures
  }
}

// ─── Chat Client (HMAC identity from backend) ───────────────────────────────

let _chatClient: ChatClient | null = null;
let _identifyPromise: Promise<ChatClient> | null = null;

export async function getChatClient(): Promise<ChatClient> {
  if (_chatClient) return _chatClient;

  // Avoid duplicate identify calls if called concurrently
  if (_identifyPromise) return _identifyPromise;

  _identifyPromise = (async () => {
    const client = new ChatClient({ teamSlug: TEAM_SLUG, baseUrl: BASE_URL });
    const identity = await invoke<SupportIdentity>('get_support_identity');

    await client.identify(
      {
        externalId: identity.external_id,
        email: identity.email,
        name: identity.name,
        timestamp: identity.timestamp,
      },
      identity.signature
    );

    _chatClient = client;
    _identifyPromise = null;
    return client;
  })();

  return _identifyPromise;
}

export function disconnectChat(): void {
  if (_chatClient) {
    _chatClient.disconnect();
    _chatClient = null;
  }
  _identifyPromise = null;
}

// ─── Ticket Operations (via ChatClient SDK) ─────────────────────────────────

export async function createTicket(params: {
  subject: string;
  message: string;
}): Promise<Conversation> {
  const client = await getChatClient();
  return client.conversations.create({
    subject: params.subject,
    message: params.message,
  });
}

export async function listTickets(): Promise<Conversation[]> {
  const client = await getChatClient();
  const result = await client.conversations.list();
  return result.conversations;
}

export async function getTicketMessages(ticketId: string): Promise<WidgetMessage[]> {
  const client = await getChatClient();
  return client.messages.list(ticketId);
}

export async function sendTicketMessage(ticketId: string, content: string): Promise<WidgetMessage> {
  const client = await getChatClient();
  return client.messages.send(ticketId, content);
}

export function onTicketMessage(
  ticketId: string,
  callback: (message: WidgetMessage) => void
): () => void {
  if (!_chatClient) return () => {};
  return _chatClient.onMessage(ticketId, callback);
}
