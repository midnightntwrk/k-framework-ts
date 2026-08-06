# Versioning, and how K compatibility is expressed

**Status:** policy. This document defines package versions and K compatibility.

## Packages use independent semver. A package version never mirrors a K version.

Each package carries its own semver and is released on its own tag (`<package>-v<version>`, e.g.
`kast-json-v0.1.0`). A package version describes _that package's_ API and behaviour, and nothing else.

Mirroring the targeted K release into the package version —
`@kframework-ts/kast-json@7.1.191` — was considered and rejected. It is an
appealing idea, because it appears to answer "which release supports my K?" by
construction. It does not survive contact with three problems:

1. **K patch versions do not guarantee format compatibility.** KAST v4 defines `KSort` as
   `{node, name, params}` with a bare `name`; KAST v3 encodes its parameters in `name` and has no `params`
   field. K releases `v7.1.319` and `v7.1.320` differ only in the patch component while spanning those
   formats. A consumer on `^7.1.191` would therefore cross a breaking format change under a version range
   that promises compatibility. See `packages/kast-json/src/version.ts` for the format definitions.
2. **It leaves no room to ship a fix.** K uses all three semver components, so a transcription bug in
   `7.1.191` has nowhere to go. `7.1.191+1` is build metadata, which semver ignores for precedence and which
   therefore cannot distinguish a release. `7.1.191-1` is a _prerelease_, which sorts **before** `7.1.191`.
3. **"Just install the matching version" fails whenever releases are sparse** — which is the normal case, since
   most K releases change nothing here. A user on K `v7.1.240` finds no `7.1.240` to install. `<=7.1.240`
   expresses the intent but nobody guesses it.

The version number is therefore not the place to encode K compatibility. That is a separate axis and gets its
own mechanism.

## K compatibility is answered on demand, not enumerated in advance

Every package that transcribes or depends on specific K source files **exports a manifest of what it was
built against**: the file paths, their sha256 at that release, and the release tag. `kast-json` does this as
`TRANSCRIBED_FROM` and `K_RELEASE` in `src/version.ts`.

A package that transcribes **more than one revision** of the same files — `kast-json` speaks both KAST v3
and v4, transcribed from two revisions of the same two Java files — records one manifest entry per
byte-distinct revision, and its `check-k` answers the sharper question "_which_ of my transcriptions does K
vX speak?" (exit 0 on any match, naming the matched revision). The identity-assertion rule below then reads
"one version _or a declared set_, membership checked by exact equality".

Given that manifest, the consumer's real question — _"I am on K vX; does this package hold?"_ — is answered by
fetching those files from `runtimeverification/k` at tag `vX` and comparing hashes. Because the check runs
against whatever tag is asked about, it works for K releases published **after** the package's last release,
and needs no maintainer upkeep.

A declared "verified through vX" range was considered and rejected for this: it
is inherently retroactive, it lags when K releases are not monitored, and it
cannot answer for a release newer than the last observation. The on-demand
check has none of those properties.

The check must report **three** outcomes, never two:

| outcome            | meaning                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `unchanged`        | Every declared file is byte-identical at the requested tag. The transcription holds.         |
| `changed`          | A declared file differs. A human must diff it before the package is trusted at that release. |
| `could not locate` | A declared path does not exist at that tag — K refactored. **Not** a compatibility verdict.  |

The third row is the honest answer to "what if K moves things around". Reporting `changed` there would be
wrong, and reporting `unchanged` would be dangerous.

### The implementation

Each such package exposes the check as a `check-k` command, and exports the same logic for programmatic use.
The exported name is package-specific — `checkKcovrSources`, `checkKleanSources`, `checkKoreRpcSources` and so
on — except in `kast-json`, which speaks more than one revision and so exports `checkKRevisions` over the
single-baseline core `checkKSources`. Exit codes are contractual:

```
$ kast-json check-k v7.1.337
    no   KAST v3 (v7.0.68 – v7.1.295, recorded at v7.1.191)
    no   KAST v3 (v7.1.296 – v7.1.319, recorded at v7.1.296)
  MATCH  KAST v4 (v7.1.320 onward, recorded at v7.1.337)

K v7.1.337 emits KAST v4; this package's transcription is current for it.
```

| code | verdict                                               |
| ---- | ----------------------------------------------------- |
| 0    | matches a recorded revision (`matched`)               |
| 1    | `changed`                                             |
| 3    | `could-not-locate`                                    |
| 2    | could not run — bad usage, or the fetch itself failed |

Code 2 is deliberately separate from every verdict: failing to reach GitHub means the question was not
answered, and reporting that as either a pass or a failure would be a claim about K that was never checked.

`.github/workflows/k-drift.yml` runs this weekly against K's latest release and opens one issue per K release
when anything moves. That is what makes "nobody is monitoring K" survivable: the check runs whether or not
anyone is watching, and stays quiet while the answer is unchanged.

### What this does not prove

Two limits, stated so nobody reads more into a green check than is there:

- Hash equality of the declared files is **necessary but not sufficient**. K can change emitted output through
  code those files call into without touching the files themselves. Only regenerating fixtures against a real
  K install proves the output is unchanged; that needs K in CI, which these checks deliberately do not
  require.
- After a hard refactor the check degrades to `could not locate`. It never silently lies, but it stops
  answering, and someone has to re-establish the manifest by hand.

### Consequence for releases

If the declared files are unchanged at a newer K release, **nothing has changed and there is nothing to
release.** Catching up on ten unwatched K releases is a metadata observation, not ten publishes. A release
happens when a package's own code changes — which is what semver is for.

## What a new package must do

Beyond the checklist in the root `README.md`:

1. Export a manifest naming every K source file it is derived from, each with its sha256 and the K release
   tag those hashes were taken at. Follow the shape of `kast-json`'s `TRANSCRIBED_FROM`.
2. Assert the identity of its input at runtime where the format carries one, and fail with one clear message
   rather than reading a mismatched document leniently. `kast-json` does this with `KAST_FORMAT` /
   `KAST_VERSIONS` — a declared set, membership checked by exact equality, each member read under its own
   version's rules; a format without a self-identifying header has no analogue and should say so.
3. Version independently of every other package here, and of K.
