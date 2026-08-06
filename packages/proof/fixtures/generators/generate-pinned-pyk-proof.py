#!/usr/bin/env python3
"""Generate `fixtures/pinned-pyk-proof.json` from a real pyk checkout.

The bundle stores each document as the *text* pyk wrote, so the fixture pins
key order as well as values.  Run it with the interpreter of a pyk source
checkout at the K commit named in `fixtures/PROVENANCE.md`:

    /path/to/k/pyk/.venv/bin/python \
        packages/proof/fixtures/generators/generate-pinned-pyk-proof.py

It writes next to itself and prints the resulting SHA-256.
"""

from __future__ import annotations

import hashlib
import json
import logging
import tempfile
from pathlib import Path

logging.disable(logging.CRITICAL)

from pyk.cterm import CTerm
from pyk.kast.inner import KApply, KVariable
from pyk.kast.prelude.kbool import BOOL
from pyk.kast.prelude.kint import intToken
from pyk.kast.prelude.utils import token
from pyk.kcfg.exploration import KCFGExplorationNodeAttr
from pyk.kcfg.kcfg import KCFG, KCFGNodeAttr
from pyk.kore.rpc import LogOrigin, LogRewrite, RewriteFailure, RewriteSuccess
from pyk.proof.implies import EqualityProof, RefutationProof
from pyk.proof.reachability import APRProof

OUT = Path(__file__).resolve().parent.parent / 'pinned-pyk-proof.json'


def term(i: int) -> CTerm:
    inside = token(i) if i <= 10 else KVariable('V' + str(i))
    return CTerm(KApply('<top>', [inside]), ())


def node_dicts(n: int, start: int = 1) -> list[dict]:
    return [{'id': i, 'cterm': term(i).to_dict(), 'attrs': []} for i in range(start, start + n)]


def kcfg(n: int) -> KCFG:
    return KCFG.from_dict({'nodes': node_dicts(n)})


def capture(proof, proof_dir: Path, *, with_kcfg: bool) -> dict:
    proof.write_proof_data()
    subdir = proof_dir / proof.id
    case = {
        'id': proof.id,
        'type': type(proof).__name__,
        'proof_json': (subdir / 'proof.json').read_text(),
        'dict': json.dumps(proof.dict),
    }
    if with_kcfg:
        case['kcfg_json'] = (subdir / 'kcfg' / 'kcfg.json').read_text()
        case['node_json'] = {
            path.stem: path.read_text() for path in sorted((subdir / 'kcfg' / 'nodes').iterdir())
        }
    return case


def tiny_definition():
    """A two-production definition: a function `f(Int)` and a `<top>` cell."""
    from pyk.kast.att import Atts, KAtt
    from pyk.kast.inner import KLabel, KSort
    from pyk.kast.outer import KDefinition, KFlatModule, KNonTerminal, KProduction, KTerminal

    int_sort = KSort('Int')
    f_prod = KProduction(
        int_sort,
        [KTerminal('f'), KTerminal('('), KNonTerminal(int_sort), KTerminal(')')],
        klabel=KLabel('f'),
    )
    top_prod = KProduction(
        KSort('TopCell'),
        [KTerminal('<top>'), KNonTerminal(int_sort), KTerminal('</top>')],
        klabel=KLabel('<top>'),
        att=KAtt([Atts.CELL(None)]),
    )
    return KDefinition('MAIN', [KFlatModule('MAIN', [f_prod, top_prod])])


def from_claim_cases() -> dict:
    from pyk.kast.att import Atts, KAtt
    from pyk.kast.inner import KRewrite, KSort, KVariable
    from pyk.kast.outer import KClaim
    from pyk.kast.prelude.kbool import TRUE, andBool
    from pyk.kast.prelude.kint import geInt, ltInt

    defn = tiny_definition()
    int_sort = KSort('Int')
    x = KVariable('X', int_sort)

    equality_claim = KClaim(
        KRewrite(KApply('f', [x]), x),
        requires=andBool([geInt(x, intToken(0)), ltInt(x, intToken(10))]),
        ensures=TRUE,
        att=KAtt([Atts.LABEL('MAIN.equality-claim')]),
    )
    equality = EqualityProof.from_claim(equality_claim, defn)

    apr_claim = KClaim(
        KRewrite(KApply('<top>', [x]), KApply('<top>', [intToken(0)])),
        requires=geInt(x, intToken(0)),
        ensures=ltInt(x, intToken(10)),
        att=KAtt([Atts.LABEL('MAIN.apr-claim'), Atts.CIRCULARITY(None), Atts.TRUSTED(None)]),
    )
    apr = APRProof.from_claim(defn, apr_claim, logs={})

    return {
        'id': 'from-claim',
        'type': 'APRProof',
        'equality_dict': json.dumps(equality.dict),
        'apr_dict': json.dumps(apr.dict),
    }


KONTROL = Path(__file__).resolve().parent.parent / 'upstream' / 'kontrol'
KONTROL_IDS = ('assert-test-setup', 'assert-test-test-assert-false')


def rewrite_kontrol() -> dict[str, dict[str, str]]:
    """Re-serialize each vendored Kontrol proof directory with pyk.

    The graph is rebuilt through `from_dict(to_dict())` so every node counts as
    created and is therefore rewritten; `KCFGStore.write_cfg_data` is otherwise
    incremental and would leave the vendored node files in place.
    """
    out: dict[str, dict[str, str]] = {}
    for proof_id in KONTROL_IDS:
        target = Path(tempfile.mkdtemp())
        source = APRProof.read_proof_data(KONTROL, proof_id)
        rebuilt = APRProof(
            id=proof_id,
            kcfg=KCFG.from_dict(source.kcfg.to_dict()),
            terminal=sorted(source.terminal_ids),
            init=source.init,
            target=source.target,
            logs=source.logs,
            proof_dir=target,
            bounded=sorted(source._bounded),
            bmc_depth=source.bmc_depth,
            circularity=source.circularity,
            admitted=source.admitted,
        )
        rebuilt.write_proof_data()
        files: dict[str, str] = {}
        for path in sorted((target / proof_id).rglob('*.json')):
            compact = json.dumps(json.loads(path.read_text()), separators=(',', ':'))
            files[str(path.relative_to(target / proof_id)).replace('\\', '/')] = hashlib.sha256(
                compact.encode()
            ).hexdigest()
        out[proof_id] = files
    return out


def main() -> None:
    proof_dir = Path(tempfile.mkdtemp())
    cases: dict[str, dict] = {}

    # 1. The plainest possible APRProof: one node, init == target.
    cases['apr-plain'] = capture(
        APRProof(id='apr_proof_1', kcfg=kcfg(1), terminal=[], init=1, target=1, logs={}, proof_dir=proof_dir),
        proof_dir,
        with_kcfg=True,
    )

    # 2. Node attributes: `vacuous` survives via the index, `terminal` via proof.json.
    attributed = kcfg(3)
    attributed.add_attr(1, KCFGNodeAttr.VACUOUS)
    attributed.add_attr(2, KCFGExplorationNodeAttr.TERMINAL)
    attributed.add_attr(3, KCFGNodeAttr.STUCK)
    cases['apr-attrs'] = capture(
        APRProof(id='apr_proof_attrs', kcfg=attributed, terminal=[], init=1, target=3, logs={}, proof_dir=proof_dir),
        proof_dir,
        with_kcfg=True,
    )

    # 3. BMC configuration: `bmc_depth` present, `bounded` sorted.
    bmc = APRProof(
        id='aprbmc_proof_1',
        kcfg=kcfg(6),
        terminal=[],
        init=1,
        target=1,
        logs={},
        proof_dir=proof_dir,
        bmc_depth=1,
    )
    for nid in (5, 2, 4):
        bmc.add_bounded(nid)
    cases['apr-bmc'] = capture(bmc, proof_dir, with_kcfg=True)

    # 4. Every optional field at once, plus a real subproof and a node refutation.
    equality = EqualityProof(
        id='equality_proof_1', lhs_body=intToken(1), rhs_body=intToken(1), sort=BOOL, proof_dir=proof_dir
    )
    cases['equality'] = capture(equality, proof_dir, with_kcfg=False)

    constraint = KApply('_>=Int_', [KVariable('X'), intToken(0)])
    refutation = RefutationProof(
        id='apr_proof_rich.node-infeasible-2',
        pre_constraints=[KApply('_<Int_', [KVariable('X'), intToken(7)])],
        last_constraint=constraint,
        proof_dir=proof_dir,
    )
    cases['refutation'] = capture(refutation, proof_dir, with_kcfg=False)

    rich = APRProof(
        id='apr_proof_rich',
        kcfg=kcfg(5),
        terminal=[3, 1],
        init=1,
        target=4,
        logs={
            2: (LogRewrite(LogOrigin.BOOSTER, RewriteSuccess('RULE-A')),),
            5: (LogRewrite(LogOrigin.KORE_RPC, RewriteFailure(None, 'no rule applies')),),
        },
        proof_dir=proof_dir,
        bmc_depth=3,
        bounded=[5, 2],
        circularity=True,
        admitted=True,
        subproof_ids=['equality_proof_1', 'apr_proof_rich.node-infeasible-2'],
        node_refutations={2: 'apr_proof_rich.node-infeasible-2'},
        prior_loops_cache={2: (1,), 5: (1, 2)},
        _exec_time=3661.4,
    )
    cases['apr-rich'] = capture(rich, proof_dir, with_kcfg=True)
    cases['apr-rich']['summary'] = [line for line in rich.summary.lines]
    cases['apr-rich']['one_line_summary'] = rich.one_line_summary
    # The `'node_refutation'` typo guard (`reachability.py:390`): `from_dict`
    # restores nothing, `read_proof_data` restores correctly.
    cases['apr-rich']['from_dict_node_refutations'] = {
        str(k): v.id for k, v in APRProof.from_dict(rich.dict, proof_dir=proof_dir).node_refutations.items()
    }
    cases['apr-rich']['read_proof_data_node_refutations'] = {
        str(k): v.id for k, v in APRProof.read_proof_data(proof_dir, rich.id).node_refutations.items()
    }

    # 6. `formatted_exec_time` uses Python's round-half-to-even.
    timing = APRProof(id='timing', kcfg=kcfg(1), terminal=[], init=1, target=1, logs={})
    formatted = {}
    for seconds in [0, 0.5, 1.4, 1.5, 2.5, 59.6, 60, 3599, 3600, 3661, 7322.2]:
        timing.set_exec_time(seconds)
        formatted[repr(seconds)] = timing.formatted_exec_time()
    cases['formatted-exec-time'] = {'id': 'timing', 'type': 'APRProof', 'formatted': formatted}

    # 5. The `RefutationProof` antecedent-wrapper asymmetry, one round trip at a time.
    wrapped = RefutationProof(
        id='refutation_round_trip', pre_constraints=[constraint], last_constraint=constraint, proof_dir=proof_dir
    )
    antecedents = [json.dumps(wrapped.antecedent.to_dict())]
    current = wrapped
    for _ in range(2):
        current.write_proof_data()
        current = RefutationProof.read_proof_data(proof_dir, 'refutation_round_trip')
        antecedents.append(json.dumps(current.antecedent.to_dict()))
    cases['refutation-round-trip'] = {
        'id': 'refutation_round_trip',
        'type': 'RefutationProof',
        'antecedents': antecedents,
    }

    # 7. `from_claim` on both proof kinds, over a two-production definition.
    cases['from-claim'] = from_claim_cases()

    # 8. What pyk at this release writes when it re-serializes the vendored
    #    Kontrol directories.  Hashes are taken over the *compact* rendering
    #    (`separators=(',', ':')`) so they are directly comparable with
    #    `JSON.stringify` output: everything but Python's default whitespace.
    cases['kontrol-rewrite'] = {'id': 'kontrol-rewrite', 'type': 'APRProof', 'files': rewrite_kontrol()}

    document = {
        'k_release': 'v7.1.337',
        'k_commit': '4a46d1231473b599c699160132fd6e76a5c46406',
        'cases': cases,
    }
    text = json.dumps(document, indent=2, sort_keys=True) + '\n'
    OUT.write_text(text)
    print(f'{hashlib.sha256(text.encode()).hexdigest()}  {OUT}')


if __name__ == '__main__':
    main()
