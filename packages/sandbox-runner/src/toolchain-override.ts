import type { SerializedToolchain } from '@sutura/common';
import type { DetectedToolchain, Language } from './types';

const KNOWN_LANGUAGES: Language[] = ['node', 'python', 'go', 'java', 'ruby'];

/** Rehydrate a serialized (JSON-safe) toolchain into the function-valued shape
 *  the runner consumes. */
export function toDetectedToolchain(s: SerializedToolchain): DetectedToolchain {
  return {
    language: KNOWN_LANGUAGES.includes(s.language as Language) ? (s.language as Language) : 'unknown',
    image: s.image,
    restoreCmd: s.restoreCmd,
    installCmd: s.restoreCmd, // deprecated alias kept in sync
    testCmd: (paths) => (s.appendTestPaths && paths.length > 0 ? [...s.testCmd, ...paths] : s.testCmd),
    cachePaths: s.cachePaths,
    restoreNeedsPatch: s.restoreNeedsPatch,
    testFramework: s.testFramework,
    testFilePattern: s.testFilePattern,
  };
}
