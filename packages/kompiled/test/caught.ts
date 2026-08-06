/**
 * `caught` / `caughtAsync` — get hold of a thrown error *as its class*, so a
 * test can assert on its fields rather than only on its message.
 *
 * `expect(...).toThrow(Class)` proves the class and nothing else, and reaching
 * into the error afterwards needs a cast that the type-aware lint (rightly)
 * rejects.  These narrow through `instanceof` instead, which the compiler
 * understands, so there is no assertion anywhere.
 *
 * An error of a *different* class is re-thrown rather than returned: swallowing
 * it would turn "the wrong thing went wrong" into a passing test.
 */

/** Run `fn`, and return the error it threw, provided it is a `type`. */
export function caught<T>(fn: () => unknown, type: abstract new (...args: never[]) => T): T {
  try {
    fn();
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`expected a ${type.name} to be thrown, but the call returned`);
}

/** Await `promise`, and return the error it rejected with, provided it is a `type`. */
export async function caughtAsync<T>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`expected a ${type.name} to be thrown, but the promise resolved`);
}
