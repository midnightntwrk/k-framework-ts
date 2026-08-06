/** Errors raised while constructing or editing a KCFG. */
export class KCFGError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = new.target.name;
  }
}

export class KCFGDictionaryError extends KCFGError {}
export class UnknownKCFGNodeError extends KCFGError {}
export class DuplicateKCFGSuccessorError extends KCFGError {}
export class KCFGInvariantError extends KCFGError {}
