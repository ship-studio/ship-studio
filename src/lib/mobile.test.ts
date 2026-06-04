import { describe, it, expect } from 'vitest';
import { classifyBuildOutput } from './mobile';

describe('classifyBuildOutput', () => {
  it('returns null while the build is still running', () => {
    expect(classifyBuildOutput('')).toBeNull();
    expect(
      classifyBuildOutput('› Compiling MyApp\nCompiling react-native-reanimated...')
    ).toBeNull();
  });

  it('detects xcodebuild success (expo / react-native)', () => {
    const log = [
      'CompileC build/Objects/Foo.o',
      '** BUILD SUCCEEDED **',
      'Installing on iPhone 17',
    ].join('\n');
    expect(classifyBuildOutput(log)).toBe('launched');
  });

  it('detects flutter success via its interactive banner', () => {
    expect(
      classifyBuildOutput('Syncing files to device iPhone 17...\nFlutter run key commands.')
    ).toBe('launched');
  });

  it('detects a hard xcodebuild failure', () => {
    const log = [
      'CompileC build/Objects/Foo.o',
      "error: use of undeclared identifier 'foo'",
      'The following build commands failed:',
      '** BUILD FAILED **',
    ].join('\n');
    expect(classifyBuildOutput(log)).toBe('failed');
  });

  it('does not false-positive on benign output containing the word "error"', () => {
    // A warning line and a log line that merely contain "error" must not be
    // treated as a build failure — only structural markers count.
    const log =
      'warning: this API is deprecated\nLOG  Handling error boundary gracefully\nBundling complete';
    expect(classifyBuildOutput(log)).toBeNull();
  });

  it('treats failure as authoritative when both markers somehow appear', () => {
    const log = '** BUILD SUCCEEDED **\n...later...\n** BUILD FAILED **';
    expect(classifyBuildOutput(log)).toBe('failed');
  });

  it('does not fire success on a bare "BUILD SUCCEEDED" from an intermediate target', () => {
    // Only xcodebuild's final `** BUILD SUCCEEDED **` banner counts; a pre-build
    // target succeeding must not be read as the app having launched.
    expect(classifyBuildOutput('=== BUILD TARGET Pods ===\nBUILD SUCCEEDED')).toBeNull();
  });
});
