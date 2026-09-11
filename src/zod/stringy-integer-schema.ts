import { z } from 'zod';

/**
 * This validates the string is a plain non-negative integer and converts it to a `number`.
 * - Also rejects values that would lose precision past `Number.MAX_SAFE_INTEGER`
 */
export const StringyIntegerSchema = z
    .string()
    .regex(/^\d+$/, {
        error: (issue) => `Invalid input: expected numeric string, received ${JSON.stringify(issue.input)}`,
    })
    .transform((value, ctx) => {
        const number = Number(value);
        if (Number.isSafeInteger(number)) return number;

        ctx.addIssue({
            code: 'custom',
            message:
                `Invalid input: stringy integer "${value}" exceeds Number.MAX_SAFE_INTEGER and would lose precision` +
                ' - use z.string() for this field instead',
        });
        return z.NEVER;
    });
