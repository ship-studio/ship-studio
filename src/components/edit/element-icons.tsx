import type { ReactNode } from 'react';
import {
  AlignLeftIcon,
  DecorationNoneIcon,
  ElementButtonIcon,
  ElementDivIcon,
  ElementHeading1Icon,
  ElementHeading2Icon,
  ElementHeading3Icon,
  ElementLinkIcon,
  ElementListIcon,
  ElementSectionIcon,
  ImageIcon,
} from '@/components/icons';
import type { ElementKind } from '../../lib/edit-structure';

/** The canonical icons for the kinds offered by the Insert Element menu. */
export const ELEMENT_ICONS: Record<ElementKind, ReactNode> = {
  div: <ElementDivIcon />,
  section: <ElementSectionIcon />,
  h1: <ElementHeading1Icon />,
  h2: <ElementHeading2Icon />,
  h3: <ElementHeading3Icon />,
  p: <AlignLeftIcon />,
  a: <ElementLinkIcon />,
  button: <ElementButtonIcon />,
  img: <ImageIcon />,
  ul: <ElementListIcon />,
  span: <DecorationNoneIcon />,
};

/** Return the Insert Element icon for a rendered tag, when one exists. */
export function getElementIcon(tag: string): ReactNode | undefined {
  return Object.prototype.hasOwnProperty.call(ELEMENT_ICONS, tag)
    ? ELEMENT_ICONS[tag as ElementKind]
    : undefined;
}
