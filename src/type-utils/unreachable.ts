/**
 * Asserts that a code path is unreachable, enabling exhaustiveness checks.
 *
 * Pass a value of type `never` to this function to let the TypeScript compiler
 * verify that all cases of a union have been handled. If a new variant is added
 * to the union but not handled, the call becomes a compile-time error. At
 * runtime, reaching this function throws an `Error`.
 *
 * @param x - The value that should be of type `never` at this point.
 * @throws {Error} Always throws, since this code should never be reached.
 *
 * @example
 * ```ts
 * type Shape = 'circle' | 'square';
 *
 * function area(shape: Shape): number {
 *     switch (shape) {
 *         case 'circle':
 *             return Math.PI;
 *         case 'square':
 *             return 1;
 *         default:
 *             // Compile-time error here if a new Shape variant is unhandled.
 *             return unreachable(shape);
 *     }
 * }
 * ```
 */
export function unreachable(x: never): never {
    throw new Error(`unreachable: ${x}`);
}
