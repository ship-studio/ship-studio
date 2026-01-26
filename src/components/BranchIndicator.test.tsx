/**
 * Tests for BranchIndicator component
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BranchIndicator } from "./BranchIndicator";

describe("BranchIndicator", () => {
  const defaultProps = {
    currentBranch: "feature/test",
    hasUncommittedChanges: false,
    changedFiles: [],
    projectPath: "/path/to/project",
    isOnBranchesTab: false,
    onClick: vi.fn(),
  };

  it("should render the current branch name", () => {
    render(<BranchIndicator {...defaultProps} />);

    expect(screen.getByText("feature/test")).toBeInTheDocument();
  });

  it('should show "Live" badge when on main branch', () => {
    render(<BranchIndicator {...defaultProps} currentBranch="main" />);

    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it('should show "Live" badge when on master branch', () => {
    render(<BranchIndicator {...defaultProps} currentBranch="master" />);

    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it('should not show "Live" badge on feature branch', () => {
    render(<BranchIndicator {...defaultProps} currentBranch="feature/test" />);

    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it('should show "Unsaved" badge when there are uncommitted changes', () => {
    render(
      <BranchIndicator
        {...defaultProps}
        hasUncommittedChanges={true}
        changedFiles={[{ path: "test.txt", status: "modified" }]}
      />
    );

    expect(screen.getByText("Unsaved")).toBeInTheDocument();
  });

  it('should not show "Unsaved" badge when there are no uncommitted changes', () => {
    render(<BranchIndicator {...defaultProps} hasUncommittedChanges={false} />);

    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
  });

  it("should call onClick when the button is clicked", () => {
    const onClick = vi.fn();
    render(<BranchIndicator {...defaultProps} onClick={onClick} />);

    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('should show "Back to Preview" when on branches tab', () => {
    render(<BranchIndicator {...defaultProps} isOnBranchesTab={true} />);

    expect(screen.getByText("Back to Preview")).toBeInTheDocument();
    expect(screen.queryByText("feature/test")).not.toBeInTheDocument();
  });

  it("should show changes dropdown on hover when there are changes", async () => {
    render(
      <BranchIndicator
        {...defaultProps}
        hasUncommittedChanges={true}
        changedFiles={[
          { path: "src/test.ts", status: "modified" },
          { path: "README.md", status: "added" },
        ]}
      />
    );

    // Hover over the branch indicator
    const indicator = screen.getByText("feature/test").closest(".branch-indicator");
    if (indicator) {
      fireEvent.mouseEnter(indicator);
    }

    // Should show the changes dropdown
    expect(screen.getByText("2 Unsaved Changes")).toBeInTheDocument();
    expect(screen.getByText("test.ts")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("should show singular 'Change' for single file", async () => {
    render(
      <BranchIndicator
        {...defaultProps}
        hasUncommittedChanges={true}
        changedFiles={[{ path: "test.ts", status: "modified" }]}
      />
    );

    const indicator = screen.getByText("feature/test").closest(".branch-indicator");
    if (indicator) {
      fireEvent.mouseEnter(indicator);
    }

    expect(screen.getByText("1 Unsaved Change")).toBeInTheDocument();
  });

  it("should show correct status indicators for different change types", async () => {
    render(
      <BranchIndicator
        {...defaultProps}
        hasUncommittedChanges={true}
        changedFiles={[
          { path: "modified.ts", status: "modified" },
          { path: "added.ts", status: "added" },
          { path: "deleted.ts", status: "deleted" },
          { path: "renamed.ts", status: "renamed" },
        ]}
      />
    );

    const indicator = screen.getByText("feature/test").closest(".branch-indicator");
    if (indicator) {
      fireEvent.mouseEnter(indicator);
    }

    // Check status indicators
    expect(screen.getByText("M")).toBeInTheDocument(); // modified
    expect(screen.getByText("+")).toBeInTheDocument(); // added
    expect(screen.getByText("-")).toBeInTheDocument(); // deleted
    expect(screen.getByText("R")).toBeInTheDocument(); // renamed
  });
});
