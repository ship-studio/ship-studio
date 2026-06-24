/**
 * Educational content for the Education Mode feature.
 *
 * This module defines tooltip content for UI elements that can be
 * highlighted when Education Mode is active. Each element is identified
 * by a unique ID that matches the data-education-id attribute on the element.
 *
 * IMPORTANT: All descriptions are written for non-technical users who may
 * not be familiar with terms like "git", "branch", "commit", etc.
 * Explain concepts in plain language.
 *
 * @module lib/educationContent
 */

export interface EducationItem {
  /** Short title displayed in the tooltip header */
  title: string;
  /** Longer description explaining what the element does */
  description: string;
}

/**
 * Map of education IDs to their tooltip content.
 * The keys correspond to data-education-id attributes on UI elements.
 */
export const educationContent: Record<string, EducationItem> = {
  // ─── Dashboard ───

  'search-projects': {
    title: 'Search Projects',
    description:
      'Quickly find any project by name. Press ⌘K to jump straight to search from anywhere on this screen.',
  },
  'import-button': {
    title: 'Import Project',
    description:
      'Bring in an existing project from GitHub. Your code will be downloaded so you can start working on it right away.',
  },
  'new-project-button': {
    title: 'New Project',
    description:
      'Create a brand new website project. Choose from starter templates or start from scratch.',
  },
  'sort-projects': {
    title: 'Sort Projects',
    description:
      'Change how your projects are ordered — by when you last worked on them or by name.',
  },
  'new-folder-button': {
    title: 'New Folder',
    description:
      'Organize your projects into folders. Drag or move projects into folders to keep things tidy.',
  },
  'settings-button': {
    title: 'Settings',
    description:
      'Customize your dashboard — show or hide the activity calendar and community banner, and manage analytics preferences.',
  },
  'machine-tools': {
    title: 'Tools on this Mac',
    description:
      'The tools installed once on your machine and shared by every workspace — Homebrew, Node, Git, and the agent CLIs. Click to expand and check what is installed.',
  },
  'changelog-sidebar': {
    title: "What's New",
    description:
      'See the latest updates and improvements to Ship Studio. Click any version to install it if you want to try it.',
  },
  'github-calendar': {
    title: 'Activity Calendar',
    description:
      "Your GitHub contribution history at a glance. Shows how active you've been over the past year.",
  },
  'slack-cta': {
    title: 'Community',
    description:
      "Join the Ship Studio Slack community to suggest features, share what you're building, and connect with other builders.",
  },

  // ─── Workspace header toolbar ───

  'branch-indicator': {
    title: 'Current Version',
    description:
      "Shows which version of your project you're working on. You can create separate versions to try new ideas without affecting your live site. Click to see all versions.",
  },
  'assets-button': {
    title: 'Assets',
    description:
      'Upload and manage images, fonts, and other files for your website. Files you add here will be available at yoursite.com/filename.',
  },
  'publish-button': {
    title: 'Publish',
    description:
      'Save your work online and make it live. Your changes will be backed up and your website will update automatically.',
  },
  'github-button': {
    title: 'GitHub',
    description:
      'GitHub stores all your project files online and keeps a history of every change. Connect to back up your work and collaborate with others.',
  },
  'env-button': {
    title: 'Environment Variables',
    description:
      'Set values like API keys and configuration options that your app can read at runtime. These are stored in a .env file in your project.',
  },
  'backups-button': {
    title: 'GitHub Backups',
    description:
      'View and restore previous versions of your project. Every time you save, a backup is created automatically. You can go back to any earlier state.',
  },
  'ide-button': {
    title: 'Open in Code Editor',
    description:
      'If you want to manually edit any of your code, you can open it with VS Code or Cursor.',
  },

  'project-settings-button': {
    title: 'Project Settings',
    description:
      'Configure settings specific to this project, like the dev server command and other project-level preferences.',
  },
  'support-button': {
    title: 'Support',
    description:
      "Get help or report a bug. Reach out to the Ship Studio team if something isn't working right.",
  },

  // Workspace tabs
  'branches-tab': {
    title: 'Versions',
    description:
      'View and switch between different versions of your project. Create new versions to experiment safely without affecting your live site.',
  },
  'prs-tab': {
    title: 'Review Requests',
    description:
      'Submit your changes for review before making them live. Great for team projects where others need to approve changes first.',
  },

  // Terminal area - granular elements
  'restart-server': {
    title: 'Restart Server',
    description:
      'Restart the preview server if your site stops responding. Use this if the preview looks stuck or shows errors.',
  },
  'health-panel': {
    title: 'Code Health',
    description:
      'Shows whether your code has any errors or warnings. Green means everything looks good, red means something needs attention.',
  },
  'claude-terminal': {
    title: 'Terminal Window',
    description:
      'A full terminal where you can run coding agents like Claude Code, Codex, or any other terminal-based tool. Type commands or ask your agent to build features, fix problems, and more.',
  },
  'server-logs': {
    title: 'Server Output',
    description:
      "Shows messages from your development server. Helpful for debugging when something isn't working as expected.",
  },
  'health-logs': {
    title: 'Health Check Results',
    description: 'Shows detailed results from code quality checks like tests and error detection.',
  },
  'terminal-tabs': {
    title: 'Chat Sessions',
    description:
      'Each tab is a separate terminal session. Use multiple tabs to work on different tasks at the same time.',
  },

  // Preview area - granular elements
  'preview-viewport': {
    title: 'Live Preview',
    description:
      'See your website as you build it. Changes appear here automatically when your agent updates your code.',
  },
  'page-switcher': {
    title: 'Page Navigation',
    description: 'Switch between different pages of your website to preview them.',
  },
  'preview-refresh': {
    title: 'Refresh Preview',
    description:
      'Reload the preview to see the latest changes. Usually happens automatically, but click here if the preview seems outdated.',
  },
  breakpoints: {
    title: 'Device Sizes',
    description:
      'See how your website looks on different devices - desktop, tablet, or mobile phone.',
  },
  'compact-button': {
    title: 'Compact Mode',
    description:
      'Shrink the app to a smaller window that stays on top. Great for working with your agent while using another app.',
  },
  'browser-button': {
    title: 'Open in Browser',
    description:
      'Open your preview in a full web browser to test features that require a real browser window.',
  },

  // Screenshot tools
  'screenshot-button': {
    title: 'Screenshot',
    description:
      'Take a picture of the current preview and share it with your agent. Useful for showing exactly what you see.',
  },
  'crop-button': {
    title: 'Crop Screenshot',
    description:
      'Select a specific area of the preview to screenshot. Click this, then drag on the preview to select the region.',
  },
  // Terminal header buttons
  'notification-settings': {
    title: 'Notification Sounds',
    description:
      'Turn sound alerts on or off. Get notified when your agent finishes a task or needs your attention.',
  },
  'skills-manager': {
    title: 'Manage Skills',
    description:
      'Install and manage skills that give your agent specialized abilities. Skills add commands for specific tasks like React patterns or code review.',
  },
  'mcp-manager': {
    title: 'MCP Servers',
    description:
      'Manage Model Context Protocol servers that connect your agent to external tools and data sources. MCP servers let your agent interact with databases, APIs, and other services.',
  },
  'help-commands': {
    title: 'Help & Commands',
    description:
      'See keyboard shortcuts and all the commands available in the terminal. Find quick ways to navigate and control the app.',
  },

  // Toolbar more menu
  'toolbar-more': {
    title: 'More Options',
    description:
      'Access additional settings like notification sounds, skill management, and helpful commands.',
  },

  // Plugin manager
  'plugin-manager': {
    title: 'Plugins',
    description:
      'Install and manage plugins that add new features to the app. Plugins can add toolbar buttons, sidebar panels, and more.',
  },

  // Preview visibility
  'show-preview': {
    title: 'Show Preview',
    description: 'Bring back the live preview panel so you can see your website while you work.',
  },
  'hide-preview': {
    title: 'Hide Preview',
    description:
      'Hide the preview panel to give the terminal more room. Useful when you want to focus on your agent.',
  },

  // Education mode button itself
  'education-button': {
    title: 'Learn Mode',
    description:
      "You're using it now! Hover over any part of the app to learn what it does. Click anywhere or press Escape to exit.",
  },
};
