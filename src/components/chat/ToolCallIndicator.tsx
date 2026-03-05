/**
 * Tool call indicator for chat messages.
 *
 * Shows inline collapsible sections for tool executions
 * (file reads, writes, shell commands, etc.).
 */

import { useState, useEffect } from 'react';
import type { ToolCallInfo } from '../../lib/client-agent';
import { CodeBlock } from './CodeBlock';

interface ToolCallIndicatorProps {
  toolCall: ToolCallInfo;
}

/** Map tool names to human-readable labels.
 * Agent SDK uses capitalized tool names (Read, Write, Edit, Bash, etc.)
 * while our custom MCP git tools use snake_case. */
function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    // Agent SDK built-in tools
    Read: 'Read file',
    Write: 'Write file',
    Edit: 'Edit file',
    Bash: 'Run command',
    Glob: 'Find files',
    Grep: 'Search files',
    WebSearch: 'Web search',
    WebFetch: 'Fetch page',
    TodoWrite: 'Update plan',
    Agent: 'Sub-agent',
    NotebookEdit: 'Edit notebook',
    // Custom MCP git tools
    git_status: 'Git status',
    git_diff: 'Git diff',
    git_log: 'Git log',
    git_add: 'Stage files',
    git_commit: 'Git commit',
  };
  return labels[name] || name;
}

/** Extract a short context hint from tool input (e.g., file path, command). */
function getToolDetail(name: string, input: unknown): string | null {
  if (!input) return null;
  // Tool input sometimes arrives as stringified JSON from the sidecar event stream
  let data: Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (typeof parsed !== 'object' || parsed === null) return null;
      data = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof input === 'object') {
    data = input as Record<string, unknown>;
  } else {
    return null;
  }

  switch (name) {
    // Agent SDK file tools use file_path
    case 'Read':
    case 'Write':
    case 'Edit': {
      const path = (data.file_path ?? data.path ?? data.filePath ?? data.file) as
        | string
        | undefined;
      if (path) {
        const parts = path.split('/').filter(Boolean);
        if (parts.length > 2) return parts.slice(-2).join('/');
        return parts[parts.length - 1] || path;
      }
      return null;
    }
    case 'Bash': {
      const cmd = (data.command ?? data.cmd) as string | undefined;
      if (cmd) return cmd.length > 40 ? cmd.slice(0, 37) + '\u2026' : cmd;
      return null;
    }
    case 'Glob': {
      return ((data.pattern ?? data.glob) as string | undefined) ?? null;
    }
    case 'Grep': {
      return ((data.pattern ?? data.query) as string | undefined) ?? null;
    }
    case 'Agent': {
      const agentType = (data.subagent_type ?? data.agent) as string | undefined;
      const desc = (data.description ?? data.task ?? data.name) as string | undefined;
      const prefix = agentType ? `${agentType}: ` : '';
      if (desc) {
        const full = prefix + desc;
        return full.length > 60 ? full.slice(0, 57) + '\u2026' : full;
      }
      return agentType ?? null;
    }
    case 'git_commit': {
      const msg = (data.message ?? data.msg) as string | undefined;
      if (msg) return msg.length > 40 ? msg.slice(0, 37) + '\u2026' : msg;
      return null;
    }
    default:
      return null;
  }
}

/** Get a status icon for the tool call. */
function getStatusIcon(status: ToolCallInfo['status']): string {
  switch (status) {
    case 'running':
      return '\u25CB'; // ○ hollow circle
    case 'complete':
      return '\u2713'; // ✓ checkmark
    case 'error':
      return '\u2717'; // ✗ cross
  }
}

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    const str = JSON.stringify(output, null, 2);
    // Truncate very long outputs
    if (str.length > 2000) {
      return str.slice(0, 2000) + '\n... (truncated)';
    }
    return str;
  } catch {
    return String(output);
  }
}

/** Detect syntax highlighting language from tool name and input. */
function detectOutputLanguage(name: string, input: unknown): string | undefined {
  if (name === 'Bash') return 'bash';
  if (name === 'Grep' || name === 'Glob') return undefined;

  // For file tools, infer from file extension
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const data = typeof input === 'object' && input ? (input as Record<string, unknown>) : {};
    const filePath = (data.file_path ?? data.path ?? '') as string;
    const ext = filePath.split('.').pop()?.toLowerCase();
    const extMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'tsx',
      js: 'javascript',
      jsx: 'jsx',
      py: 'python',
      rs: 'rust',
      go: 'go',
      rb: 'ruby',
      css: 'css',
      scss: 'scss',
      html: 'html',
      svelte: 'svelte',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'toml',
      md: 'markdown',
      sql: 'sql',
      sh: 'bash',
      zsh: 'bash',
      xml: 'xml',
      vue: 'vue',
    };
    return ext ? extMap[ext] : undefined;
  }
  return undefined;
}

/** Format milliseconds as a human-readable duration string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function ToolCallIndicator({ toolCall }: ToolCallIndicatorProps) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Live elapsed timer for running tools — updates every second so the
  // user can see the clock ticking (especially important for sub-agent
  // calls that wait on LLM responses for 30-60+ seconds).
  useEffect(() => {
    if (toolCall.status !== 'running') return;
    const id = setInterval(() => setElapsed(Date.now() - toolCall.startedAt), 1000);
    return () => clearInterval(id);
  }, [toolCall.status, toolCall.startedAt]);

  const label = getToolLabel(toolCall.name);
  const detail = getToolDetail(toolCall.name, toolCall.input);
  const icon = getStatusIcon(toolCall.status);

  // For completed tools, use sidecar-measured durationMs for accuracy.
  // For running tools, show the live elapsed timer.
  let duration: string | null = null;
  if (toolCall.status === 'running' && elapsed > 0) {
    duration = formatDuration(elapsed);
  } else if (toolCall.durationMs !== undefined) {
    duration = formatDuration(toolCall.durationMs);
  } else if (toolCall.completedAt && toolCall.startedAt) {
    duration = formatDuration(toolCall.completedAt - toolCall.startedAt);
  }

  return (
    <div className={`chat-tool-call ${toolCall.status}`}>
      <button className="chat-tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className={`chat-tool-status ${toolCall.status}`}>{icon}</span>
        <span className="chat-tool-header-content">
          <span className="chat-tool-name-row">
            <span className="chat-tool-name">{label}</span>
            {duration && <span className="chat-tool-duration">{duration}</span>}
            <span className={`chat-tool-chevron ${expanded ? 'expanded' : ''}`}>{'\u25B8'}</span>
          </span>
          {detail && <span className="chat-tool-detail">{detail}</span>}
        </span>
      </button>
      {/* Collapsed error preview — visible without expanding */}
      {!expanded && toolCall.status === 'error' && toolCall.output !== undefined && (
        <div className="chat-tool-error-preview">
          {formatOutput(toolCall.output).split('\n')[0].slice(0, 120)}
        </div>
      )}
      {expanded && (
        <div className="chat-tool-call-details">
          {toolCall.input !== undefined && (
            <div className="chat-tool-section">
              <span className="chat-tool-section-label">Input</span>
              <pre className="chat-tool-section-content">{formatInput(toolCall.input)}</pre>
            </div>
          )}
          {toolCall.output !== undefined && (
            <div
              className={`chat-tool-section${toolCall.status === 'error' ? ' chat-tool-section-error' : ''}`}
            >
              <span className="chat-tool-section-label">
                {toolCall.status === 'error' ? 'Error' : 'Output'}
              </span>
              {toolCall.status === 'error' ? (
                <pre className="chat-tool-section-content chat-tool-error-content">
                  {formatOutput(toolCall.output)}
                </pre>
              ) : (
                (() => {
                  const outputStr = formatOutput(toolCall.output);
                  const lang = detectOutputLanguage(toolCall.name, toolCall.input);
                  // Use syntax highlighting for file/bash output, plain pre for everything else
                  return lang && outputStr.length > 10 && outputStr.length < 2000 ? (
                    <div className="chat-tool-highlighted-output">
                      <CodeBlock code={outputStr} language={lang} />
                    </div>
                  ) : (
                    <pre className="chat-tool-section-content">{outputStr}</pre>
                  );
                })()
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
