import SuccessAlertSvg from '../../assets/icons/success-alert.svg?react';
import ErrorAlertSvg from '../../assets/icons/error-alert.svg?react';
import AlertSvg from '../../assets/icons/alert.svg?react';
import ActiveSvg from '../../assets/icons/active.svg?react';
import HistorySvg from '../../assets/icons/history.svg?react';
import ShieldTickSvg from '../../assets/icons/shield-tick.svg?react';
import PluginSvg from '../../assets/icons/plugin.svg?react';
import GraduationCapSvg from '../../assets/icons/graduation-cap.svg?react';
import PendingCircleSvg from '../../assets/icons/old-icons/pending-circle.svg?react';
import { createIcon } from './icon-base';

export const SuccessIcon = createIcon(SuccessAlertSvg, {
  name: 'SuccessIcon',
  source: 'icons/success-alert.svg',
  kind: 'ui',
  defaultSize: 20,
  strokeWidth: '1px',
});
export const ErrorIcon = createIcon(ErrorAlertSvg, {
  name: 'ErrorIcon',
  source: 'icons/error-alert.svg',
  kind: 'ui',
  defaultSize: 20,
  strokeWidth: '1px',
});
export const BellIcon = createIcon(AlertSvg, {
  name: 'BellIcon',
  source: 'icons/alert.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const ActivityIcon = createIcon(ActiveSvg, {
  name: 'ActivityIcon',
  source: 'icons/active.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const HistoryIcon = createIcon(HistorySvg, {
  name: 'HistoryIcon',
  source: 'icons/history.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const ShieldCheckIcon = createIcon(ShieldTickSvg, {
  name: 'ShieldCheckIcon',
  source: 'icons/shield-tick.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const PuzzleIcon = createIcon(PluginSvg, {
  name: 'PuzzleIcon',
  source: 'icons/plugin.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const PlugIcon = createIcon(PluginSvg, {
  name: 'PlugIcon',
  source: 'icons/plugin.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const GraduationCapIcon = createIcon(GraduationCapSvg, {
  name: 'GraduationCapIcon',
  source: 'icons/graduation-cap.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const PendingCircleIcon = createIcon(PendingCircleSvg, {
  name: 'PendingCircleIcon',
  source: 'icons/old-icons/pending-circle.svg',
  kind: 'ui',
  defaultSize: 20,
});
