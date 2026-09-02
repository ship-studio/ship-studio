import ChevronDownSvg from '../../assets/icons/chevron-down.svg?react';
import ChevronRightSvg from '../../assets/icons/chevron-right.svg?react';
import TickSvg from '../../assets/icons/tick.svg?react';
import WarningAlertSvg from '../../assets/icons/warning-alert.svg?react';
import AlertSvg from '../../assets/icons/alert.svg?react';
import CancelSvg from '../../assets/icons/cancel.svg?react';
import InfoAlertSvg from '../../assets/icons/info-alert.svg?react';
import SearchSvg from '../../assets/icons/search.svg?react';
import LeftSvg from '../../assets/icons/left.svg?react';
import RightSvg from '../../assets/icons/right.svg?react';
import GridSvg from '../../assets/icons/grid.svg?react';
import ListSvg from '../../assets/icons/list.svg?react';
import CommandPlaceholderSvg from '../../assets/icons/old-icons/command-placeholder.svg?react';
import MoreHorizontalSvg from '../../assets/icons/old-icons/more-horizontal.svg?react';
import { createIcon } from './icon-base';

export const ChevronIcon = createIcon(ChevronDownSvg, {
  name: 'ChevronIcon',
  source: 'icons/chevron-down.svg',
  kind: 'ui',
  defaultSize: 14,
  compact: true,
  strokeWidth: '1px',
});
export const ChevronRightIcon = createIcon(ChevronRightSvg, {
  name: 'ChevronRightIcon',
  source: 'icons/chevron-right.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const CheckIcon = createIcon(TickSvg, {
  name: 'CheckIcon',
  source: 'icons/tick.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const WarningIcon = createIcon(WarningAlertSvg, {
  name: 'WarningIcon',
  source: 'icons/warning-alert.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const AlertIcon = createIcon(AlertSvg, {
  name: 'AlertIcon',
  source: 'icons/alert.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const CloseIcon = createIcon(CancelSvg, {
  name: 'CloseIcon',
  source: 'icons/cancel.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const InfoIcon = createIcon(InfoAlertSvg, {
  name: 'InfoIcon',
  source: 'icons/info-alert.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const SearchIcon = createIcon(SearchSvg, {
  name: 'SearchIcon',
  source: 'icons/search.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const ArrowLeftIcon = createIcon(LeftSvg, {
  name: 'ArrowLeftIcon',
  source: 'icons/left.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const ArrowRightIcon = createIcon(RightSvg, {
  name: 'ArrowRightIcon',
  source: 'icons/right.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const GridIcon = createIcon(GridSvg, {
  name: 'GridIcon',
  source: 'icons/grid.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const ListIcon = createIcon(ListSvg, {
  name: 'ListIcon',
  source: 'icons/list.svg',
  kind: 'ui',
  defaultSize: 16,
  strokeWidth: '1px',
});
export const CommandPlaceholderIcon = createIcon(CommandPlaceholderSvg, {
  name: 'CommandPlaceholderIcon',
  source: 'icons/old-icons/command-placeholder.svg',
  kind: 'ui',
  defaultSize: 14,
});
export const MoreHorizontalIcon = createIcon(MoreHorizontalSvg, {
  name: 'MoreHorizontalIcon',
  source: 'icons/old-icons/more-horizontal.svg',
  kind: 'ui',
  defaultSize: 14,
});
