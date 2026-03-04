/**
 * Tool call indicator for chat messages.
 *
 * Shows inline collapsible sections for tool executions
 * (file reads, writes, shell commands, etc.).
 */

import { useState, useEffect } from 'react';
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
      // Show which sub-agent is running + a brief description
      const agentType = (data.subagent_type ?? data.agent) as string | undefined;
      const desc = (data.description ?? data.task ?? data.name) as string | undefined;
      const prefix = agentType ? `${agentType}: ` : '';
      if (desc) {
        const full = prefix + desc;
        return full.length > 60 ? full.slice(0, 57) + '\u2026' : full;
      }
      return agentType ?? null;
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
