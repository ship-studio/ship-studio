import { describe, it, expect } from 'vitest';
import { describeImportError } from './importErrors';

describe('describeImportError', () => {
  it('distinguishes illegal-filename checkouts from the long-path case (issue #706)', () => {
    // The same clone dump also contains the "unable to checkout working tree"
    // wrapper that the shared long-paths branch (#701) matches — long-path
    // support can't fix an illegal character, so this must win.
    const raw =
      "Process exited with code 1\n\nCloning into 'goova-web-4'...\nerror: invalid path 'GOOVA IMAGES/logos/Google_\"G\"_logo.svg'\nfatal: unable to checkout working tree\nwarning: Clone succeeded, but checkout failed.\nfailed to run git: exit status 128";
    const info = describeImportError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toContain("Windows doesn't allow");
    expect(info.message).not.toContain('core.longpaths');
    expect(info.message).not.toContain('Cloning into');
  });

  it('still gives long-path guidance for genuine "Filename too long" failures', () => {
    const raw =
      'Process exited with code 1\n\nerror: unable to create file some/deep/path: Filename too long\nfatal: unable to checkout working tree';
    const info = describeImportError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('core.longpaths');
  });

  it('maps npm EUNSUPPORTEDPROTOCOL for workspace:/catalog: deps to pnpm guidance (issues #707/#708)', () => {
    const workspace =
      'Process exited with code 1\n\nnpm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:*\nnpm error A complete log of this run can be found in: ~/.npm/_logs/debug-0.log';
    const info = describeImportError(workspace);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('pnpm');
    expect(info.message).not.toContain('npm error');

    const catalog =
      'Process exited with code 1\n\nnpm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "catalog:": catalog:lint';
    expect(describeImportError(catalog).expected).toBe(true);
  });

  it('recognizes preinstall guards that refuse non-pnpm installers (issue #707)', () => {
    const raw =
      'Process exited with code 1\n\n> workspace@0.0.0 preinstall\n> sh -c \'rm -f package-lock.json yarn.lock; case "$npm_config_user_agent" in pnpm/*) ;; *) echo "Use pnpm instead" >&2; exit 1 ;; esac\'\nUse pnpm instead\nnpm error code 1';
    const info = describeImportError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('pnpm');
    expect(info.message).not.toContain('npm_config_user_agent');
  });

  it("maps gh's GraphQL repository 404 to a renamed/deleted/access hint (issue #733)", () => {
    const raw =
      "Process exited with code 1\n\nGraphQL: Could not resolve to a Repository with the name 'uxfold/fin-insight-tables'. (repository)";
    const info = describeImportError(raw);
    expect(info.expected).toBe(true);
    expect(info.message).toContain('renamed');
    expect(info.message).not.toContain('GraphQL');
  });

  it('delegates everything else to the shared classifier', () => {
    // Recognized shared branch stays recognized…
    expect(describeImportError('npm error code E401').expected).toBe(true);
    // …and a genuinely unknown failure still reports as unexpected.
    const unknown = describeImportError('Process exited with code 1\n\nsomething went sideways');
    expect(unknown.expected).toBe(false);
    expect(unknown.message).toContain('something went sideways');
  });
});
