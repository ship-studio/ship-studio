/**
 * Markdown renderer for chat messages.
 *
 * Uses react-markdown with GFM support and custom code block rendering
 * via Shiki syntax highlighting.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import type { ComponentPropsWithoutRef } from 'react';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Custom code block renderer
        code({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) {
          const match = /language-(\w+)/.exec(className || '');
          const text = Array.isArray(children)
            ? children.map((c) => (typeof c === 'string' ? c : '')).join('')
            : typeof children === 'string'
              ? children
              : '';
          const isBlock = text.includes('\n') || match;

          if (isBlock) {
            return <CodeBlock code={text.replace(/\n$/, '')} language={match?.[1]} />;
          }

          // Inline code
          return (
            <code className="chat-inline-code" {...props}>
              {children}
            </code>
          );
        },
        // Open links in external browser
        a({ href, children, ...props }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="chat-link"
              {...props}
            >
              {children}
            </a>
          );
        },
        // Don't render images (security)
        img() {
          return null;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
