import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './Breadcrumb';

describe('Breadcrumb', () => {
  it('renders an accessible hierarchy and handles parent selection', () => {
    const onSelect = vi.fn();

    render(
      <Breadcrumb aria-label="Element hierarchy">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink onClick={onSelect}>section.hero</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage aria-current="page">button.btn</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );

    expect(screen.getByRole('navigation', { name: 'Element hierarchy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'section.hero' })).toBeInTheDocument();
    expect(screen.getByText('button.btn')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'section.hero' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('renders a non-interactive ellipsis for collapsed paths', () => {
    const { container } = render(<BreadcrumbEllipsis />);

    expect(container.querySelector('.breadcrumb__ellipsis')).toHaveAttribute('aria-hidden', 'true');
  });
});
