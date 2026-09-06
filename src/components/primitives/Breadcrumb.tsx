import type { ComponentPropsWithoutRef } from 'react';
import { ChevronRightIcon, MoreHorizontalIcon } from '@/components/icons';
import { Button, type ButtonProps } from './Button';

function joinClassNames(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(' ');
}

/** Root navigation landmark for a hierarchy of related items. */
export function Breadcrumb({ className, ...props }: ComponentPropsWithoutRef<'nav'>) {
  return <nav className={joinClassNames('breadcrumb', className)} {...props} />;
}

/** Ordered list that contains breadcrumb items and separators. */
export function BreadcrumbList({ className, ...props }: ComponentPropsWithoutRef<'ol'>) {
  return <ol className={joinClassNames('breadcrumb__list', className)} {...props} />;
}

/** One item in the breadcrumb hierarchy. */
export function BreadcrumbItem({ className, ...props }: ComponentPropsWithoutRef<'li'>) {
  return <li className={joinClassNames('breadcrumb__item', className)} {...props} />;
}

/** Interactive breadcrumb item that reselects an element in the live preview. */
export function BreadcrumbLink({ className, ...props }: BreadcrumbLinkProps) {
  return (
    <Button
      variant="ghost"
      size="compact"
      className={joinClassNames('breadcrumb__link', className)}
      {...props}
    />
  );
}

export type BreadcrumbLinkProps = Omit<
  ButtonProps,
  'variant' | 'size' | 'width' | 'block' | 'leftIcon' | 'rightIcon'
>;

/** Non-interactive truncation marker for a collapsed breadcrumb path. */
export function BreadcrumbEllipsis({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      className={joinClassNames('breadcrumb__ellipsis', className)}
      {...props}
    >
      <MoreHorizontalIcon size={14} />
    </span>
  );
}

/** Non-interactive label for the currently selected item. */
export function BreadcrumbPage({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
  return <span className={joinClassNames('breadcrumb__page', className)} {...props} />;
}

/** Visual separator between breadcrumb items. */
export function BreadcrumbSeparator({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<'li'>) {
  return (
    <li
      aria-hidden="true"
      className={joinClassNames('breadcrumb__separator', className)}
      {...props}
    >
      {children ?? <ChevronRightIcon size={12} />}
    </li>
  );
}
