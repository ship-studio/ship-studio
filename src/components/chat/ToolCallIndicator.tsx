/**
 * Tool call indicator for chat messages.
 *
 * Shows inline collapsible sections for tool executions
 * (file reads, writes, shell commands, etc.).
 */

import { useState } from 'react';
import type { ToolCallInfo } from '../../lib/client-agent';

interface ToolCallIndicatorProps {
  toolCall: ToolCallInfo;
}

/** Map tool names to human-readable labels. */
function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    read_file: 'Read file',
    write_file: 'Write file',
    edit_file: 'Edit file',
    ls: 'List files',
    glob: 'Find files',
    grep: 'Search files',
    execute: 'Run command',
    git_status: 'Git status',
    git_diff: 'Git diff',
    git_log: 'Git log',
    git_add: 'Stage files',
    git_commit: 'Git commit',
    write_todos: 'Update plan',
    task: 'Sub-agent',
  };
  return labels[name] || name;
}

/** Extract a short context hint from tool input (e.g., file path, command). */
function getToolDetail(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;

  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      const path = (data.path ?? data.file_path ?? data.filePath ?? data.file) as
        | string
        | undefined;
      if (path) {
        const parts = path.split('/').filter(Boolean);
        if (parts.length > 2) return parts.slice(-2).join('/');
        return parts[parts.length - 1] || path;
      }
      return null;
    }
    case 'ls': {
      const dir = (data.path ?? data.directory ?? data.dir) as string | undefined;
      if (dir && dir !== '.') {
        const parts = dir.split('/').filter(Boolean);
        return parts[parts.length - 1] || dir;
      }
      return null;
    }
    case 'glob': {
      return ((data.pattern ?? data.glob) as string | undefined) ?? null;
    }
    case 'grep': {
      return ((data.pattern ?? data.query) as string | undefined) ?? null;
    }
    case 'execute': {
      const cmd = (data.command ?? data.cmd) as string | undefined;
      if (cmd) return cmd.length > 40 ? cmd.slice(0, 37) + '\u2026' : cmd;
      return null;
    }
    case 'git_commit': {
      const msg = (data.message ?? data.msg) as string | undefined;
      if (msg) return msg.length > 40 ? msg.slice(0, 37) + '\u2026' : msg;
      return null;
    }
    case 'task': {
      const desc = (data.description ?? data.task ?? data.name) as string | undefined;
      if (desc) return desc.length > 50 ? desc.slice(0, 47) + '\u2026' : desc;
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

export function ToolCallIndicator({ toolCall }: ToolCallIndicatorProps) {
  const [expanded, setExpanded] = useState(false);

  const label = getToolLabel(toolCall.name);
  const detail = getToolDetail(toolCall.name, toolCall.input);
  const icon = getStatusIcon(toolCall.status);

  // Use sidecar-measured durationMs for accuracy (frontend timestamps are unreliable
  // since events arrive through Rust's emit_to, making start/end nearly identical).
  let duration: string | null = null;
  if (toolCall.durationMs !== undefined) {
    const ms = toolCall.durationMs;
    duration = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  } else if (toolCall.completedAt && toolCall.startedAt) {
    const ms = toolCall.completedAt - toolCall.startedAt;
    duration = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <div className={`chat-tool-call ${toolCall.status}`}>
      <button className="chat-tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className={`chat-tool-status ${toolCall.status}`}>{icon}</span>
        <span className="chat-tool-name">{label}</span>
        {detail && <span className="chat-tool-detail">{detail}</span>}
        {duration && <span className="chat-tool-duration">{duration}</span>}
        <span className={`chat-tool-chevron ${expanded ? 'expanded' : ''}`}>
          {'\u25B8'}
          {/* ▸ right-pointing triangle */}
        </span>
      </button>
      {expanded && (
        <div className="chat-tool-call-details">
          {toolCall.input !== undefined && (
            <div className="chat-tool-section">
              <span className="chat-tool-section-label">Input</span>
              <pre className="chat-tool-section-content">{formatInput(toolCall.input)}</pre>
            </div>
          )}
          {toolCall.output !== undefined && (
            <div className="chat-tool-section">
              <span className="chat-tool-section-label">Output</span>
              <pre className="chat-tool-section-content">{formatOutput(toolCall.output)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
