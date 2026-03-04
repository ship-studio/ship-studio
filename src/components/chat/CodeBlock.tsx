/**
 * Syntax-highlighted code block for chat messages.
 *
 * Reuses the global Shiki highlighter instance (same as CodeViewer).
 * Includes a copy-to-clipboard button and language label.
 */

import { useEffect, useState, useCallback } from 'react';

// Cache the highlighter instance globally (shared with CodeViewer)
let highlighterPromise: Promise<import('shiki').Highlighter> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark'],
        langs: [],
      })
    );
  }
  return highlighterPromise;
}

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      try {
        const highlighter = await getHighlighter();
        const lang = language || 'text';

        // Load grammar if not already loaded
        const loadedLangs = highlighter.getLoadedLanguages();
        if (!loadedLangs.includes(lang as never)) {
          try {
            await highlighter.loadLanguage(lang as never);
          } catch {
            // Fall back to plaintext if language isn't supported
          }
        }

        if (cancelled) return;

        const finalLang = highlighter.getLoadedLanguages().includes(lang as never) ? lang : 'text';
        const html = highlighter.codeToHtml(code, {
          lang: finalLang,
          theme: 'github-dark',
        });
        setHighlightedHtml(html);
      } catch {
        // Fall back to plain text
        setHighlightedHtml(`<pre><code>${escapeHtml(code)}</code></pre>`);
      }
    }

    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }, [code]);

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        {language && <span className="chat-code-lang">{language}</span>}
        <button className="chat-code-copy" onClick={() => void handleCopy()} title="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {highlightedHtml ? (
        <div className="chat-code-content" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      ) : (
        <pre className="chat-code-content chat-code-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
