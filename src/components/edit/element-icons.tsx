import type { ReactNode } from 'react';
import {
  DecorationNoneIcon,
  ElementBodyIcon,
  ElementButtonIcon,
  ElementCodeBlockIcon,
  ElementDivIcon,
  ElementFooterIcon,
  ElementHeading1Icon,
  ElementHeading2Icon,
  ElementHeading3Icon,
  ElementHeadIcon,
  ElementLinkIcon,
  ElementListIcon,
  ElementMainIcon,
  ElementNavIcon,
  ElementParagraphIcon,
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
  p: <ElementParagraphIcon />,
  a: <ElementLinkIcon />,
  button: <ElementButtonIcon />,
  img: <ImageIcon />,
  ul: <ElementListIcon />,
  span: <DecorationNoneIcon />,
};

const ELEMENT_TAG_ICONS: Record<string, ReactNode> = {
  ...ELEMENT_ICONS,
  body: <ElementBodyIcon />,
  code: <ElementCodeBlockIcon />,
  footer: <ElementFooterIcon />,
  header: <ElementHeadIcon />,
  main: <ElementMainIcon />,
  nav: <ElementNavIcon />,
};

/** Return the Insert Element icon for a rendered tag, when one exists. */
export function getElementIcon(tag: string): ReactNode | undefined {
  return ELEMENT_TAG_ICONS[tag];
}
