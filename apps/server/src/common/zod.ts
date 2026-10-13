import { BadRequestException, type PipeTransform, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

/** Validates and transforms input with a Zod schema; 400 with field errors on failure. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: 'object' };
  }
}

/** Swagger documentation for a Zod-validated body. Pair with `@Body(new ZodPipe(schema))`. */
export function ApiZodBody(schema: z.ZodType): MethodDecorator {
  return applyDecorators(ApiBody({ schema: jsonSchema(schema) }));
}

/** Swagger documentation for Zod-validated query params. */
export function ApiZodQuery(schema: z.ZodObject): MethodDecorator {
  const decorators = Object.entries(schema.shape).map(([name, field]) =>
    ApiQuery({
      name,
      required: !(field as z.ZodType).safeParse(undefined).success,
      schema: jsonSchema(field as z.ZodType),
    }),
  );
  return applyDecorators(...decorators);
}

/** Parse an untrusted socket payload; returns null instead of throwing. */
export function safeParse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null {
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}
