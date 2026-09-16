import type { ZodSafeParseResult } from 'zod';
import z, { ZodError } from 'zod';

// ============ Public API ============
export type RecursivePartial<T> = T extends object ? { [P in keyof T]?: RecursivePartial<T[P]> } : T;

export type PartialSafeParseResult<Schema extends z.ZodType> =
    | { success: true; data: z.infer<Schema>; error: never }
    | { success: false; data: RecursivePartial<z.infer<Schema>> | undefined; error: ZodError };

/**
 * Performs a recursive partial safe parse on the provided data using the given Zod schema.
 * - This makes sure that all nested objects are parsed as deeply as possible, returning any successfully parsed data
 *      along with detailed errors for any failures.
 *
 * Parsing cases:
 * - For objects, returns any fields containing at least partially parsed data with nested structures preserved.
 * - For arrays, returns items containing at least partially parsed data.
 * - For primitives, simply returns the error if parsing fails.
 */
export function partialSafeParse<Schema extends z.ZodType>(
    schema: Schema,
    data: unknown,
): PartialSafeParseResult<Schema> {
    const basePath: PropertyKey[] = [];

    return partialSafeParseInternal(schema, data, basePath) as PartialSafeParseResult<Schema>;
}

// ============ Internal Result Type ============

/**
 * A union type used by the internal implementation functions.
 * Since the internals work with non-generic Zod types, we don't need to thread
 * type parameters through — the type safety is provided at the public API boundary via overloads.
 */
type InternalParseResult = ZodSafeParseResult<unknown> | { success: false; data: unknown; error: ZodError };

/**
 * Implementation of the recursive partial safe parse logic.
 * - Due to typescripts and zod's type limitations around generics, we cannot type the full function properly
 *      - So it's easier to just type cast it instead of doing it the proper way.
 * - Wrappers are unwrapped through `def.innerType` rather than by naming wrapper classes, which covers chains such
 *      as `.nullish()` and wrappers we have not thought of
 *      - Wrappers that accept the value (an absent `.optional()`, an applied `.default()`, any `.catch()`) return at
 *          the success check first, so they are never unwrapped
 */
function partialSafeParseInternal(schema: z.core.$ZodType, data: unknown, path: PropertyKey[]): InternalParseResult {
    const result = z.safeParse(schema, data);
    if (result.success) return result;

    if (schema instanceof z.ZodObject && isRecord(data)) {
        return partialSafeParseObject(schema, data, path);
    }

    const isArrayLikeSchema = schema instanceof z.ZodArray || schema instanceof z.ZodTuple;
    if (isArrayLikeSchema && Array.isArray(data)) {
        return partialSafeParseArrayLike(schema, data, path);
    }

    // Wrapper schema - re-enter with the inner type so the checks above get a chance at it
    const innerType = getWrappedInnerType(schema);
    if (innerType) {
        return partialSafeParseInternal(innerType, data, path);
    }

    // Primitive failure
    const errorWithPath = mergeZodErrorWithPath(result.error, path);
    return { error: errorWithPath, success: false };
}

/**
 * Performs a recursive partial safe parse on an object schema, processing each field individually.
 * At least partially parsed fields are collected in `partialData`, while errors for failed fields are aggregated.
 */
function partialSafeParseObject(
    schema: z.ZodObject,
    data: Record<string, unknown>,
    path: PropertyKey[],
): InternalParseResult {
    const partialData: Record<string, unknown> = {};
    const errors: ZodError[] = [];

    for (const key of Object.keys(schema.shape)) {
        const keySchema: z.ZodType = schema.shape[key];
        const fieldResult = partialSafeParseInternal(keySchema, data[key], [...path, key]);

        if (fieldResult.success) {
            partialData[key] = fieldResult.data;
            continue;
        }

        if ('data' in fieldResult) {
            partialData[key] = fieldResult.data;
        }

        errors.push(fieldResult.error);
    }

    const error = new ZodError(errors.flatMap((err) => err.issues));
    return { data: partialData, error, success: false };
}

/**
 * Performs a recursive partial safe parse on array-like schemas (arrays and tuples), processing each item individually.
 * - All at least partially parsed items are collected in `partialData`, while errors for failed items are aggregated.
 */
function partialSafeParseArrayLike(
    schema: z.ZodArray | z.ZodTuple,
    data: unknown[],
    path: PropertyKey[],
): InternalParseResult {
    const partialData: unknown[] = [];
    const errors: ZodError[] = [];

    for (const [index, item] of data.entries()) {
        const itemSchema = getArrayLikeItemSchema(schema, index);
        if ('skipRemainingItems' in itemSchema) break;

        const itemResult = partialSafeParseInternal(itemSchema, item, [...path, index]);
        if (itemResult.success) {
            partialData.push(itemResult.data);
            continue;
        }

        if ('data' in itemResult) {
            partialData.push(itemResult.data);
        }

        errors.push(itemResult.error);
    }

    const error = new ZodError(errors.flatMap((err) => err.issues));
    return { data: partialData, error, success: false };
}

/**
 * Gets the item schema for the given item index in the array like structure.
 * - For regular arrays the schema is the same for all items
 * - For tuples, we have to get the schema for each element separately. If we run out of items we continue onto the rest
 *      attribute, if available, otherwise we skip the remaining items.
 */
function getArrayLikeItemSchema(
    schema: z.ZodArray | z.ZodTuple,
    index: number,
): z.core.$ZodType | { skipRemainingItems: true } {
    if (schema instanceof z.ZodArray) {
        return schema.element;
    }

    return schema.def.items[index] ?? schema.def.rest ?? { skipRemainingItems: true };
}

function getWrappedInnerType(schema: z.core.$ZodType): z.core.$ZodType | undefined {
    if (!(schema instanceof z.ZodType)) return undefined;

    const { def } = schema;
    if (!('innerType' in def)) return undefined;

    return def.innerType instanceof z.ZodType ? def.innerType : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function mergeZodErrorWithPath(error: ZodError, path: PropertyKey[]): ZodError {
    return new ZodError(
        error.issues.map((issue) => ({
            ...issue,
            path: [...path, ...issue.path],
        })),
    );
}
