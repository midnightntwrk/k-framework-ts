import type { CTerm } from "@kframework-ts/cterm";

import type { KCFGExtendResult, KCFGSymbolic } from "./explore.js";

/** A value or promise accepted by asynchronous semantic hooks. */
export type Awaitable<T> = T | PromiseLike<T>;

/**
 * Product-specific policy for symbolic exploration.
 *
 * The graph package deliberately does not decide which states are terminal,
 * abstractable, or mergeable.  Implement this interface in a language or
 * prover package and pass it to {@link KCFGExplore}.
 */
export interface KCFGSemantics {
  isTerminal(cterm: CTerm): boolean;
  abstractNode(cterm: CTerm): CTerm;
  isLoop(cterm: CTerm): boolean;
  sameLoop(left: CTerm, right: CTerm): boolean;
  canMakeCustomStep(cterm: CTerm): boolean;
  customStep(
    cterm: CTerm,
    symbolic: KCFGSymbolic,
    nodeId: number,
  ): Awaitable<KCFGExtendResult | readonly KCFGExtendResult[] | undefined>;
  isMergeable(left: CTerm, right: CTerm): boolean;
}

/** Conservative, backend-independent default exploration policy. */
export class DefaultKCFGSemantics implements KCFGSemantics {
  isTerminal(_cterm: CTerm): boolean {
    return false;
  }
  abstractNode(cterm: CTerm): CTerm {
    return cterm;
  }
  isLoop(_cterm: CTerm): boolean {
    return false;
  }
  sameLoop(_left: CTerm, _right: CTerm): boolean {
    return false;
  }
  canMakeCustomStep(_cterm: CTerm): boolean {
    return false;
  }
  customStep(_cterm: CTerm, _symbolic: KCFGSymbolic, _nodeId: number): KCFGExtendResult | undefined {
    return undefined;
  }
  isMergeable(_left: CTerm, _right: CTerm): boolean {
    return false;
  }
}

/** Backwards-friendly short spelling for the default policy. */
export { DefaultKCFGSemantics as DefaultSemantics };
