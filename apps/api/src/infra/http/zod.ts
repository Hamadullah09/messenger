import { applyDecorators, type PipeTransform } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { ApiError } from './api-error';

export function zodIssuesToDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Parse with a shared schema, converting failures into a 400 VALIDATION_FAILED. */
export function parseOrThrow<S extends ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = zodIssuesToDetails(result.error);
    throw new ApiError('VALIDATION_FAILED', details[0]?.message ?? 'Invalid request', details);
  }
  return result.data;
}

export class ZodPipe<S extends ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    return parseOrThrow(this.schema, value);
  }
}

function jsonSchema(schema: ZodType): Record<string, unknown> {
  // `io: 'input'` documents what clients send (before defaults/transforms).
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}

/** Documents a request body in OpenAPI from the same Zod schema used for validation. */
export function ApiZodBody(schema: ZodType): MethodDecorator {
  return applyDecorators(ApiBody({ schema: jsonSchema(schema) as never }));
}

/** Documents query parameters in OpenAPI from a Zod object schema. */
export function ApiZodQuery(schema: ZodType): MethodDecorator {
  const json = jsonSchema(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const decorators = Object.entries(json.properties ?? {}).map(([name, property]) =>
    ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: property as never }),
  );
  return applyDecorators(...decorators);
}
