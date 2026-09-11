import { assert, describe, expect, it } from 'vitest';

import { StringyNumberSchema } from '../../src/zod/stringy-number-schema.js';

describe('StringyNumberSchema', () => {
    it('should validate and transform stringy numbers correctly', () => {
        // Act
        const result = StringyNumberSchema.parse('123');

        // Assert
        expect(result).toBe(123);
    });

    it('should throw an error for invalid stringy numbers', () => {
        // Act
        const result = StringyNumberSchema.safeParse('abc');

        // Assert
        assert(result.error);
        expect(result.error.issues[0].message).toStrictEqual('Invalid input: expected numeric string, received "abc"');
    });

    it('should throw an error for number over the maximum safe integer', () => {
        // Act
        const result = StringyNumberSchema.safeParse('9007199254740992'); // Number.MAX_SAFE_INTEGER + 1

        // Assert
        assert(result.error);
        expect(result.error.issues[0].message).toStrictEqual(
            'Invalid input: stringy number "9007199254740992" exceeds Number.MAX_SAFE_INTEGER and would lose ' +
                'precision - use z.string() for this field instead',
        );
    });
});
