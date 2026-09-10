/**
 * Harbr Plugin SDK
 *
 * Provides hooks and types for building Harbr plugins.
 *
 * Plugins use this SDK to access the host app's context, execute shell commands,
 * show toast notifications, and persist data — all without direct Tauri invoke access.
 *
 * @module @shipstudio/plugin-sdk
 */

// Context
export { usePluginContext, getPluginContext, type PluginContextValue } from './context';

// Hooks
export { useProject } from './hooks/useProject';
export { useShell } from './hooks/useShell';
export { useFs } from './hooks/useFs';
export { useToast } from './hooks/useToast';
export { usePluginStorage } from './hooks/usePluginStorage';
export { useAppActions } from './hooks/useAppActions';
export { useTheme } from './hooks/useTheme';
export { useInvoke } from './hooks/useInvoke';

// UI Components
export { Button, type ButtonProps } from './components/Button';
export { Input, type InputProps } from './components/Input';
export { Select, type SelectProps } from './components/Select';
export { Modal, type ModalProps } from './components/Modal';
export { Spinner, type SpinnerProps } from './components/Spinner';
export { Badge, type BadgeProps } from './components/Badge';
export { Stack, type StackProps } from './components/Stack';
export { Text, type TextProps } from './components/Text';
