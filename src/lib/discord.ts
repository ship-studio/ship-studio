import { invoke } from '@tauri-apps/api/core';

export interface DiscordPresencePayload {
  details?: string;
  state?: string;
  filename?: string;
  projectName?: string;
  languageKey?: string;
  languageName?: string;
  startTimestamp?: number;
  isEditing?: boolean;
}

export function mapLanguageFromFilename(filename: string): { key: string; name: string } {
  const cleanName = filename.split(/[/\\]/).pop() || filename;
  const lower = cleanName.toLowerCase();

  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) {
    return { key: 'docker', name: 'Docker' };
  }
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules') {
    return { key: 'git', name: 'Git' };
  }
  if (lower === '.env' || lower.startsWith('.env.')) {
    return { key: 'env', name: 'Environment Config' };
  }

  const ext = lower.split('.').pop() || '';
  switch (ext) {
    case 'ts':
      return { key: 'typescript', name: 'TypeScript' };
    case 'tsx':
      return { key: 'react_ts', name: 'TypeScript React' };
    case 'js':
    case 'mjs':
    case 'cjs':
      return { key: 'javascript', name: 'JavaScript' };
    case 'jsx':
      return { key: 'react_js', name: 'JavaScript React' };
    case 'rs':
      return { key: 'rust', name: 'Rust' };
    case 'py':
    case 'pyw':
      return { key: 'python', name: 'Python' };
    case 'html':
    case 'htm':
      return { key: 'html', name: 'HTML' };
    case 'css':
      return { key: 'css', name: 'CSS' };
    case 'scss':
    case 'sass':
      return { key: 'scss', name: 'SCSS' };
    case 'less':
      return { key: 'less', name: 'LESS' };
    case 'json':
    case 'jsonc':
      return { key: 'json', name: 'JSON' };
    case 'toml':
      return { key: 'toml', name: 'TOML' };
    case 'xml':
      return { key: 'xml', name: 'XML' };
    case 'md':
    case 'mdx':
      return { key: 'markdown', name: 'Markdown' };
    case 'go':
      return { key: 'go', name: 'Go' };
    case 'c':
    case 'h':
      return { key: 'c', name: 'C' };
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return { key: 'cpp', name: 'C++' };
    case 'cs':
      return { key: 'csharp', name: 'C#' };
    case 'php':
      return { key: 'php', name: 'PHP' };
    case 'vue':
      return { key: 'vue', name: 'Vue' };
    case 'svelte':
      return { key: 'svelte', name: 'Svelte' };
    case 'astro':
      return { key: 'astro', name: 'Astro' };
    case 'java':
      return { key: 'java', name: 'Java' };
    case 'kt':
    case 'kts':
      return { key: 'kotlin', name: 'Kotlin' };
    case 'swift':
      return { key: 'swift', name: 'Swift' };
    case 'rb':
      return { key: 'ruby', name: 'Ruby' };
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'ps1':
      return { key: 'shell', name: 'Shell Script' };
    case 'sql':
      return { key: 'sql', name: 'SQL' };
    case 'yaml':
    case 'yml':
      return { key: 'yaml', name: 'YAML' };
    case 'graphql':
    case 'gql':
      return { key: 'graphql', name: 'GraphQL' };
    case 'gitignore':
    case 'gitattributes':
      return { key: 'git', name: 'Git' };
    case 'lua':
      return { key: 'lua', name: 'Lua' };
    case 'dart':
      return { key: 'dart', name: 'Dart' };
    case 'zig':
      return { key: 'zig', name: 'Zig' };
    case 'ex':
    case 'exs':
      return { key: 'elixir', name: 'Elixir' };
    case 'prisma':
      return { key: 'prisma', name: 'Prisma' };
    case 'txt':
    case 'log':
      return { key: 'text', name: 'Text Document' };
    default:
      return { key: 'code', name: 'Code' };
  }
}

export async function getDiscordPresenceEnabled(): Promise<boolean> {
  return invoke<boolean>('get_discord_presence_enabled');
}

export async function setDiscordPresenceEnabled(enabled: boolean): Promise<void> {
  await invoke('set_discord_presence_enabled', { enabled });
}

export async function updateDiscordPresence(payload: DiscordPresencePayload): Promise<void> {
  await invoke('update_discord_presence', { payload });
}

export async function clearDiscordPresence(): Promise<void> {
  await invoke('clear_discord_presence');
}
