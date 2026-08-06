// Extracted verbatim from `KOMPILE_DEFINITION` in
// `pyk/src/tests/integration/proof/test_non_det.py:35-62`, which carries its K
// definition inline as a Python string. Only the surrounding quotes and the
// uniform Python indentation are gone; every module, sentence and comment is
// upstream's. See ../PROVENANCE.md.
module NON-DET-SYNTAX
    imports INT-SYNTAX
    syntax A ::= "a" | "b" | "c" | d(Int) | e(Int) | "f"
endmodule

module NON-DET-RULES [symbolic]
    imports NON-DET-SYNTAX
    imports INT

    // Split on new symbolic variable
    rule c => d(?I) ensures ?I >Int 0
    rule c => e(?I) ensures ?I <=Int 0
endmodule

module NON-DET
    imports NON-DET-SYNTAX
    imports NON-DET-RULES

    // Raw non-determinism
    rule a => b
    rule a => c

    // Make it easy to write a claim
    rule b => f
    rule d(_) => f
    rule e(_) => f
endmodule
