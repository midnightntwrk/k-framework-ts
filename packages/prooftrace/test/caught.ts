/**
 * `caught` / `caughtAsync` — get hold of a thrown error *as its class*, so a
 * test can assert on its fields rather than only on its message.
 *
 * The same helper `packages/kfuzz/test/caught.ts`, `packages/ktool/test/caught.ts`
 * and `packages/kompiled/test/caught.ts` carry, for the same reason:
 * `expect(...).toThrow(Class)` proves the class and nothing else, and reaching
 * into the error afterwards needs a cast the type-aware lint (rightly) rejects.
 * This narrows through `instanceof` instead.
 *
 * Both forms are needed here: parsing is synchronous, generation is not.
 *
 * An error of a *different* class is re-thrown rather than returned: swallowing
 * it would turn "the wrong thing went wrong" into a passing test.
 */

/** Run `body`, and return the error it threw, provided it is a `type`. */
export function caught<T>(body: () => unknown, type: abstract new (...args: never[]) => T): T {
  try {
    body();
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`expected a ${type.name} to be thrown, but nothing was`);
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
