# KTool roadmap

`@kframework-ts/ktool` has hermetic argv, process, cache, and filesystem tests,
plus live coverage for native parsing, `kast`, `kore-print`, LLVM interpretation,
and kserver lifecycle.

## Complete the live K command matrix

Add K-bearing integration rows for:

- `kompile` acceptance of every supported option group;
- `krun` end-to-end execution through the public wrapper; and
- `parseModules` round-tripping a representative specification.

Exit criterion: the public wrapper for each command is exercised against the
pinned K release, including success output, a representative tool failure, and
the argv recorded by the process logger.
