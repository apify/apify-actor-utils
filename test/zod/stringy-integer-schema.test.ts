import { assert, describe, expect, it } from 'vitest';

import { StringyIntegerSchema } from '../../src/zod/stringy-integer-schema.js';

describe('StringyIntegerSchema', () => {
    it('should validate and transform stringy integers correctly', () => {
        // Act
        const result = StringyIntegerSchema.parse('123');

        // Assert
        expect(result).toBe(123);
    });

    it('should throw an error for invalid stringy integers', () => {
        // Act
        const result = StringyIntegerSchema.safeParse('abc');

        // Assert
        assert(result.error);
        expect(result.error.issues[0].message).toStrictEqual('Invalid input: expected numeric string, received "abc"');
    });

    it('should throw an error for number over the maximum safe integer', () => {
        // Act
        const result = StringyIntegerSchema.safeParse('9007199254740992'); // Number.MAX_SAFE_INTEGER + 1

        // Assert
        assert(result.error);
        expect(result.error.issues[0].message).toStrictEqual(
            'Invalid input: stringy integer "9007199254740992" exceeds Number.MAX_SAFE_INTEGER and would lose ' +
                'precision - use z.string() for this field instead',
        );
    });
});
