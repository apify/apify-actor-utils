import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';

import { partialSafeParse } from '../../src/zod/partial-safe-parse.js';

describe('partialSafeParse()', () => {
    it('should return success for a valid object', () => {
        // Arrange
        const schema = z.object({ name: z.string(), age: z.number() });
        const data = { name: 'John', age: 30 };

        // Act
        const result = partialSafeParse(schema, data);

        // Assert
        expect(result).toStrictEqual({ data, success: true });
    });

    it('should return undefined data and errors for a completely invalid object', () => {
        // Arrange
        const schema = z.object({ name: z.string() });
        const data = null;

        // Act
        const result = partialSafeParse(schema, data);

        // Assert
        expect(result).toStrictEqual({ error: expect.any(ZodError), success: false });

        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]).toStrictEqual({
            code: 'invalid_type',
            expected: 'object',
            message: 'Invalid input: expected object, received null',
            path: [],
        });
    });

    it('should return partial data and errors for an invalid object', () => {
        // Arrange
        const schema = z.object({
            name: z.string(),
            age: z.number(),
            address: z.object({ street: z.string(), city: z.string() }),
            account: z.object({ username: z.string(), password: z.string() }),
        });
        const data = {
            name: 'John',
            age: 'thirty',
            address: { street: '123 Main St', city: 456 },
            account: { username: 'john_doe', password: 'password' },
        };

        // Act
        const result = partialSafeParse(schema, data);

        // Assert
        expect(result).toStrictEqual({
            data: {
                name: 'John',
                address: { street: '123 Main St' },
                account: { username: 'john_doe', password: 'password' },
            },
            error: expect.any(ZodError),
            success: false,
        });

        expect(result.error.issues).toHaveLength(2);
        expect(result.error.issues[0]).toStrictEqual({
            code: 'invalid_type',
            expected: 'number',
            message: 'Invalid input: expected number, received string',
            path: ['age'],
        });
        expect(result.error.issues[1]).toStrictEqual({
            code: 'invalid_type',
            expected: 'string',
            message: 'Invalid input: expected string, received number',
            path: ['address', 'city'],
        });
    });

    it('should return partial data and errors for an array', () => {
        // Arrange
        const schema = z.array(z.object({ id: z.number(), name: z.string() }));
        const data = [{ id: 1, name: 'Item 1' }, { id: '2', name: 'Item 2' }, null];

        // Act
        const result = partialSafeParse(schema, data);

        // Assert
        expect(result).toStrictEqual({
            data: [{ id: 1, name: 'Item 1' }, { name: 'Item 2' }],
            error: expect.any(ZodError),
            success: false,
        });

        expect(result.error.issues).toHaveLength(2);
        expect(result.error.issues[0]).toStrictEqual({
            code: 'invalid_type',
            expected: 'number',
            message: 'Invalid input: expected number, received string',
            path: [1, 'id'],
        });
        expect(result.error.issues[1]).toStrictEqual({
            code: 'invalid_type',
            expected: 'object',
            message: 'Invalid input: expected object, received null',
            path: [2],
        });
    });

    describe('tuples', () => {
        it('should return partial data and errors', () => {
            // Arrange
            const schema = z.tuple([z.object({ id: z.string() })]);
            const data = [{ id: '1' }, { id: 2 }];

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: [{ id: '1' }],
                error: expect.any(ZodError),
                success: false,
            });
        });

        it('should return partial data and errors for a tuple with rest elements', () => {
            // Arrange
            const schema = z.tuple([z.object({ id: z.string() })]).rest(z.object({ id: z.string() }));
            const data = [{ id: '1' }, { id: 2 }, { id: '3' }];

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: [{ id: '1' }, {}, { id: '3' }],
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received number',
                path: [1, 'id'],
            });
        });
    });

    describe('optional fields', () => {
        const schema = z.object({ optionalField: z.array(z.object({ id: z.string() })).optional() });

        it('should parse them recursively partially', () => {
            // Arrange
            const data = { optionalField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: { optionalField: [{ id: '1' }, {}] },
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: ['optionalField', 1, 'id'],
            });
        });

        it('should parse missing optional fields successfully', () => {
            // Arrange
            const data = {};

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({ data: {}, success: true });
        });
    });

    describe('nullable fields', () => {
        const schema = z.object({ nullableField: z.array(z.object({ id: z.string() })).nullable() });

        it('should parse them recursively partially', () => {
            // Arrange
            const data = { nullableField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: { nullableField: [{ id: '1' }, {}] },
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: ['nullableField', 1, 'id'],
            });
        });

        it('should parse null nullable fields successfully', () => {
            // Arrange
            const data = { nullableField: null };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({ data: { nullableField: null }, success: true });
        });

        it('should parse a nullable schema at the root recursively partially', () => {
            // Arrange
            const rootSchema = z.array(z.object({ id: z.string() })).nullable();
            const data = [{ id: '1' }, { invalid: true }];

            // Act
            const result = partialSafeParse(rootSchema, data);

            // Assert
            expect(result).toStrictEqual({
                data: [{ id: '1' }, {}],
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: [1, 'id'],
            });
        });
    });

    describe('nullish fields', () => {
        const schema = z.object({ nullishField: z.array(z.object({ id: z.string() })).nullish() });

        it('should parse them recursively partially', () => {
            // Arrange
            const data = { nullishField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: { nullishField: [{ id: '1' }, {}] },
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: ['nullishField', 1, 'id'],
            });
        });

        it('should parse null nullish fields successfully', () => {
            // Arrange
            const data = { nullishField: null };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({ data: { nullishField: null }, success: true });
        });

        it('should parse missing nullish fields successfully', () => {
            // Arrange
            const data = {};

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({ data: {}, success: true });
        });
    });

    describe('fields with a default', () => {
        const schema = z.object({ defaultField: z.array(z.object({ id: z.string() })).default([]) });

        it('should parse them recursively partially', () => {
            // Arrange
            const data = { defaultField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: { defaultField: [{ id: '1' }, {}] },
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: ['defaultField', 1, 'id'],
            });
        });

        it('should parse missing fields with a default successfully', () => {
            // Arrange
            const data = {};

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({ data: { defaultField: [] }, success: true });
        });
    });

    describe('readonly fields', () => {
        const schema = z.object({ readonlyField: z.array(z.object({ id: z.string() })).readonly() });

        it('should parse them recursively partially', () => {
            // Arrange
            const data = { readonlyField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: { readonlyField: [{ id: '1' }, {}] },
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: ['readonlyField', 1, 'id'],
            });
        });
    });

    describe('chained wrappers', () => {
        const schema = z.object({
            chainedField: z
                .array(z.object({ id: z.string() }))
                .optional()
                .nullable(),
        });

        it('should parse them recursively partially', () => {
            // Arrange
            const data = { chainedField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({
                data: { chainedField: [{ id: '1' }, {}] },
                error: expect.any(ZodError),
                success: false,
            });

            expect(result.error.issues).toHaveLength(1);
            expect(result.error.issues[0]).toStrictEqual({
                code: 'invalid_type',
                expected: 'string',
                message: 'Invalid input: expected string, received undefined',
                path: ['chainedField', 1, 'id'],
            });
        });
    });

    describe('caught fields', () => {
        const schema = z.object({ caughtField: z.array(z.object({ id: z.string() })).catch([]) });

        it('should return the fallback successfully instead of partial data', () => {
            // Arrange
            const data = { caughtField: [{ id: '1' }, { invalid: true }] };

            // Act
            const result = partialSafeParse(schema, data);

            // Assert
            expect(result).toStrictEqual({ data: { caughtField: [] }, success: true });
        });
    });
});
