# Prooftrace roadmap

`@kframework-ts/prooftrace` reads and attributes complete LLVM proof-hint
streams. The parser, rule join, deterministic JSONL projection, filtering,
native runner, failure status, and live conformance checks are implemented.

## P1: incremental file streaming

The backend writes proof hints incrementally, and `proofTraceEvents` yields one
event at a time from an in-memory buffer. The package does not provide a reader
that follows a file while the interpreter is still writing it.

Add an async file-stream reader that:

- handles records split across arbitrary read boundaries;
- yields every complete event without waiting for process exit;
- distinguishes a clean end of stream from truncation; and
- composes with record assembly and JSONL output without renumbering events.

This completes the streaming part of `docs/execution-traces.md` R7 and preserves
partial evidence when a run times out or crashes.

## P1: proof-hint overhead benchmark

Measure runtime overhead and output size for identical interpreter runs with
and without proof-hint output. The benchmark must include a short spawn-bound
program and a sustained rewrite workload, report warm and cold samples, and pin
the K/LLVM backend version and host details.

Publish the command, raw samples, median, and dispersion in the package README.
This completes `docs/execution-traces.md` R9.

## Upstream boundary: runtime aborts

An LLVM runtime `abort()` can leave a zero-byte hint file because the backend
does not flush the proof writer. A reader cannot recover bytes that were never
written. Keep zero-byte output distinct from a valid header-only empty trace,
and re-evaluate this boundary when the backend gains crash-safe flushing.
