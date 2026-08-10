# @kframework-ts/bison

`@kframework-ts/bison` classifies one exact Bison token grammar for LR(1)
membership. The input is the grammar bytes, not a file identity and not a K
definition.

The package uses a supported GNU Bison IELR adapter. It does not invoke K. It
also does not assert that an upstream grammar lowered to the supplied bytes
correctly.

## API

```ts
import { analyzeBisonLr1 } from "@kframework-ts/bison";

const analysis = await analyzeBisonLr1({ source: parserYBytes });
```

The byte-taking API is normative. It immediately copies the supplied bytes and
returns the copy with its SHA-256 digest.

`analyzeBisonLr1File` is a convenience helper. It reads one path once and then
delegates to the byte-taking API.

## Classification

The stable classification is one of:

| Kind                | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `lr1`               | The exact supplied grammar has a conflict-free IELR automaton.        |
| `not-lr1`           | That grammar has an unresolved or Bison-solved parser-table conflict. |
| `invalid-grammar`   | Bison could not construct a valid grammar report from the source.     |
| `unsupported-input` | V1 cannot make the claim for a selected grammar or parser control.    |
| `tool-failure`      | The selected tool, adapter, workspace, or report operation failed.    |

Only `lr1` and `not-lr1` decide LR(1) membership. The other classifications do
not make a grammar-membership claim.

## LR(1) algorithm

The algorithm fixes the lookahead length at one. It does not infer the
lookahead length from the number of automaton states or the size of a parser
table. It also does not try LR(2) when LR(1) fails.

The analyzer does the following work:

1. **Fix the input.** Copy the supplied bytes and compute their digest. Decode a
   strict UTF-8 view for policy inspection; Bison later parses a snapshot of the
   original bytes.
2. **Inspect parser controls.** Report relevant source-policy diagnostics for LR
   mode declarations, `%expect`, and precedence. Reject GLR, a custom skeleton,
   `%dprec`, and `%merge`, because the V1 adapter does not analyze those
   controls.
3. **Select the tool adapter.** Resolve one Bison executable. Reject
   caller-supplied Bison arguments. Observe the executable's version and require
   the exact GNU Bison 3.8.2 XML adapter.
4. **Create an isolated run.** Write the fixed bytes to a read-only `parser.y`
   in an analyzer-owned temporary workspace.
5. **Force one-token IELR.** Invoke Bison with
   `--force-define=lr.type=ielr`. Treat shift/reduce and reduce/reduce conflicts
   as errors. Request the full XML automaton and text report.
6. **Validate the XML automaton.** Validate the grammar, symbols, rules, LR
   items, states, transitions, reductions, solved resolutions, and all
   cross-references in the supported XML report.
7. **Find unresolved conflicts.** Inspect each disabled reduction. A competing
   shift on the same token is a shift/reduce conflict. A competing enabled
   reduction on the same token is a reduce/reduce conflict.
8. **Find solved conflicts.** Treat every conflict that Bison solved through
   precedence or associativity as evidence that the grammar's candidate actions
   conflict. Selecting one action does not make the grammar LR(1).
9. **Classify the grammar.** Return `not-lr1` if the XML automaton contains an
   unresolved or solved conflict. Return `lr1` only if the automaton contains no
   conflict and Bison completed successfully.
10. **Remove the workspace.** Treat a workspace or cleanup failure as a tool
    failure, not as a grammar result.

Bison XML is the machine-readable authority for LR(1) classification. The text
report and process record remain available as audit evidence. Conflict-as-error
flags help Bison produce diagnostics, but its exit status does not decide
`not-lr1`. For example, `%expect` or precedence can let a conflicting run exit
successfully while the XML still records competing actions.

## Why the algorithm works

For a finite grammar, the set of possible LR(1) items is finite. An item has the
form `[A -> α . β, a]`, where `a` is one lookahead token. The sets of items that
form the parser states are also finite. Bison can therefore construct the whole
IELR automaton and terminate.

Each LR(1) parser-table entry is identified by one automaton state and one next
token. The entry can have only one action:

- shift to one state
- reduce by one rule
- accept
- report an error

A shift/reduce conflict gives two possible actions for one entry. A
reduce/reduce conflict also gives two possible actions for one entry. A grammar
with either conflict is not LR(1).

IELR has the recognition power of canonical LR(1). Unlike LALR(1), IELR does
not introduce conflicts only because it merged states with different lookahead
contexts. Therefore, a complete IELR automaton with no competing actions
establishes LR(1) for the exact grammar.

This is an unbounded grammar result. The finite automaton represents every
viable parser prefix and every input of arbitrary finite length. The check does
not test only a finite set of example programs. An LR(1) grammar has a unique
parser action at every step, so its parsing is deterministic and its grammar is
unambiguous.

A conflict does not prove ambiguity. An ambiguous grammar produces a conflict,
but an unambiguous grammar that needs more than one token of lookahead also
produces a conflict. A `not-lr1` result proves only that the exact supplied
grammar is not LR(1).

## Source policy

The analyzer forces IELR for its own transaction. A missing or different
source-selected LR mode therefore does not control the classification.

Source policy is reported separately in `policyDiagnostics`. For example,
`%expect`, a source-selected LALR mode, and unused precedence can be important
consumer-policy facts without changing a conflict-free forced-IELR result.
Precedence or associativity that actually resolves a table conflict is still
`not-lr1`, because the XML automaton records the competing action.

V1 returns `unsupported-input` for GLR controls and source-selected custom
skeletons. The selected tool must be one executable, or one forwarding wrapper
executable. V1 rejects caller-supplied command arguments so that they cannot
alter the forced-IELR transaction.

## Tool identity and evidence

```ts
const analysis = await analyzeBisonLr1({
  source: parserYBytes,
  tool: { command: ["/opt/bison-3.8.2/bin/bison"] },
  env: resolvedToolchainEnv,
});
```

V1 supports one exact report adapter: GNU Bison 3.8.2. The package observes the
selected executable's version before it selects the adapter. It does not assume
that a newer-looking version is compatible.

The package does not copy the executable. It also does not claim to preserve
the executable's shared libraries, skeleton data, M4 toolchain, platform, or
environment. A version is an adapter dispatch key. It is not execution
attestation and not a promise made on Bison's behalf.

The result retains the source bytes and digest, the tool observation, and the
available process, XML, and text-report evidence. The analyzer owns and removes
its unique temporary workspace. Callers do not supply an output path.

## Claim boundary

An `lr1` or `not-lr1` result applies only to the exact supplied token grammar.
Both rely on the selected Bison implementation to construct and report its IELR
automaton correctly.

The result does not establish any of the following properties:

- an upstream grammar lowered to the supplied bytes correctly
- the scanner tokenizes raw source text deterministically
- semantic actions construct the correct syntax tree
- the generated parser implements the reported tables correctly
- the selected toolchain is reproducible

Callers must state and discharge these proof obligations separately.

The `./testing` export contains unstable XML and report adapter helpers for this
repository's conformance tests. It is not a public compatibility contract.
