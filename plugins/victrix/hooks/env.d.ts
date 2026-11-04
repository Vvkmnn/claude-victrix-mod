// Globals the test kit provides to *.test.ts files; the hooks module itself has neither (no DOM, no Node).
declare function setTimeout(callback: () => void, ms?: number): unknown
declare const console: { log: (...parts: unknown[]) => void }
