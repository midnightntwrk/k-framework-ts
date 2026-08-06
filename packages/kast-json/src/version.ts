/**
 * Identity of the serialisations this package reads, and of the K releases its
 * decoders were transcribed from.
 *
 * KAST JSON carries its own identity in every document, which KORE emission
 * has no analogue of.  Asserting that identity before trusting any read means
 * a K release that reshapes the JSON fails here with one clear message rather
 * than as a hundred confusing failures downstream.
 */

/** The only `format` value this package accepts. */
export const KAST_FORMAT = "KAST" as const;

/** A KAST JSON version this package can read. */
export type KastVersion = 3 | 4;

/**
 * Every `version` this package accepts, as JSON **numbers**.
 *
 * K's own reader compares the version with exact equality, not `>=`
 * (`JsonParser.parseJson`, v3 `JsonParser.java:396` / v4 `JsonParser.java:398`),
 * and so does this package: a document is read as the one version it declares,
 * never leniently as another.
 *
 * Version 3 became version 4 in K commit `79fae65c1e` ("Handle sort parameters
 * correctly in JSON Kast format", #4913), first released in **v7.1.320**:
 * `KSort` changed from `{node, name}` — where `name` was a flat string that
 * inlined any sort parameters, e.g. `"Map{Int,Int}"` — to
 * `{node, name, params: [...]}` with a bare `name`.  A v4 document is
 * therefore *not* a v3 document with extra keys; the meaning of an existing
 * key changed.  This package reads both, each under its own version's rules.
 */
export const KAST_VERSIONS: readonly [3, 4] = [3, 4];

/**
 * The newest K release this package transcribes.  A consumer can assert this
 * against its own K pin; the per-version baselines are in `TRANSCRIBED_FROM`.
 */
export const K_RELEASE = "v7.1.337" as const;

/** One K source file this package is derived from, hashed at a known release. */
export interface TranscribedSource {
  /** Path within the `runtimeverification/k` tree. */
  readonly path: string;
  /** Lowercase hex sha256 of the file at `recordedAt` of its revision. */
  readonly sha256: string;
  /** Line count at that same release — a human-scale cross-check. */
  readonly lines: number;
}

/**
 * One revision of the two files KAST JSON is specified by.
 *
 * `ToJson.java` is the **writer** — the authority on what K emits — and
 * `JsonParser.java` is the **reader** — the authority on what K reads back.
 * The bytes of both were confirmed identical at `firstRelease`, `recordedAt`,
 * and (where present) `lastRelease` against a checkout of
 * `runtimeverification/k`; the releases between those points were established
 * by enumerating every commit that touches either file
 * (`git log v7.1.191..v7.1.337 -- <the two paths>` shows exactly two:
 * `fc09a5c6de`, formatting only, and `79fae65c1e`, the v4 break).
 */
export interface KastRevision {
  /** The `version` KAST documents carry under this revision. */
  readonly kastVersion: KastVersion;
  /** The earliest K release tag whose files carry exactly these bytes. */
  readonly firstRelease: string;
  /** The release the hashes were recorded at (a release we ran or diffed). */
  readonly recordedAt: string;
  /**
   * The last K release carrying these bytes, when a later revision exists.
   * Absent on the newest revision: its end is not yet known.
   */
  readonly lastRelease?: string;
  /** Why this revision is distinct from its neighbour, in one sentence. */
  readonly note: string;
  readonly toJson: TranscribedSource;
  readonly jsonParser: TranscribedSource;
}

const TO_JSON_PATH = "k-frontend/src/main/java/org/kframework/unparser/ToJson.java";
const JSON_PARSER_PATH = "k-frontend/src/main/java/org/kframework/parser/json/JsonParser.java";

/**
 * Every revision of `ToJson.java` / `JsonParser.java` this package's decoders
 * were transcribed from, oldest first.
 *
 * The middle entry exists so `check-k` answers honestly across
 * v7.1.296–v7.1.319: commit `fc09a5c6de` ("Resolve Spotless + Java 17",
 * #4869) re-wrapped two `throw` statements in `JsonParser.java` and changed
 * nothing else, so those releases still speak KAST v3 byte-compatibly while
 * hashing differently.  Without it, two dozen releases would report `changed`
 * over whitespace.
 */
export const TRANSCRIBED_FROM: readonly [KastRevision, KastRevision, KastRevision] = [
  {
    kastVersion: 3,
    firstRelease: "v7.0.68",
    recordedAt: "v7.1.191",
    lastRelease: "v7.1.295",
    note: "The original KAST v3 transcription baseline: sorts are flat strings.",
    toJson: {
      path: TO_JSON_PATH,
      sha256: "8756c9d8bb1fd9dab3d1e0b6ff7bd9ba019596afb1e04b4c09ad11bf7c1e2c7b",
      lines: 493,
    },
    jsonParser: {
      path: JSON_PARSER_PATH,
      sha256: "288e39a57fc0bba901d37738ff5d067c94181ae289c2f2868ff223f2a3d1d1fd",
      lines: 468,
    },
  },
  {
    kastVersion: 3,
    firstRelease: "v7.1.296",
    recordedAt: "v7.1.296",
    lastRelease: "v7.1.319",
    note: "Formatting-only variant of the v3 revision (Spotless re-wrap, fc09a5c6de).",
    toJson: {
      path: TO_JSON_PATH,
      sha256: "8756c9d8bb1fd9dab3d1e0b6ff7bd9ba019596afb1e04b4c09ad11bf7c1e2c7b",
      lines: 493,
    },
    jsonParser: {
      path: JSON_PARSER_PATH,
      sha256: "7e0e2ecffdb71715ba1d9b9c485449aa2d8b95d25cf74472e864ea16c6b47c94",
      lines: 470,
    },
  },
  {
    kastVersion: 4,
    firstRelease: "v7.1.320",
    recordedAt: "v7.1.337",
    note: "KAST v4 (79fae65c1e, #4913): KSort carries structured `params`, `name` is bare.",
    toJson: {
      path: TO_JSON_PATH,
      sha256: "1003e8c003abad22cdbdcd14dc64471246e7a5fa39760471297613de7def1c65",
      lines: 493,
    },
    jsonParser: {
      path: JSON_PARSER_PATH,
      sha256: "ee7152871ff838531bc8fb670c95071f5295bcf9c918a1d7aaffe183ef8ee416",
      lines: 474,
    },
  },
];

/**
 * The third authority file: `ADT.Sort.toString` (`ADT.scala:73-80`) defines
 * the flat spelling a v3 `KSort.name` carries — `Name`, or `Name{P1,P2}`
 * recursively, no spaces.  `flattenSort` in `term.ts` is a transcription of
 * it, which is how this package reads v4 sorts through the same flat-string
 * `KTerm` shape as v3.  The file is byte-identical at every release in
 * `TRANSCRIBED_FROM` (confirmed at v7.1.191, v7.1.296, v7.1.319, v7.1.320 and
 * v7.1.337), so it is recorded once, not per revision.
 */
export const SORT_SPELLING_SOURCE: TranscribedSource = {
  path: "k-frontend/src/main/scala/org/kframework/kore/ADT.scala",
  sha256: "369b9cd8591d02ff2f07db4fdbec0fd26c18a505b041d4f0519e962c944b5ec2",
  lines: 125,
};
