import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError, ZodObject, ZodTypeAny } from 'zod';
import { sendError } from '../utils/response';

/** True when schema is `{ body?, query?, params? }` request wrapper — not a payload that merely has a string field named `body`. */
function isRequestWrapperSchema(schema: ZodTypeAny): boolean {
  const shape = (schema as ZodObject<any>)?.shape;
  if (!shape || typeof shape !== 'object') return false;
  if (shape.query !== undefined || shape.params !== undefined) return true;
  const bodyField = shape.body;
  // Wrapper uses nested ZodObject for req.body. Flat schemas like `{ body: z.string() }` are payload schemas.
  return bodyField instanceof ZodObject;
}

export const validate = (schema: ZodTypeAny | { body?: AnyZodObject; query?: AnyZodObject; params?: AnyZodObject }) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if ('parseAsync' in schema) {
        if (isRequestWrapperSchema(schema as ZodTypeAny)) {
          // Full request schema with body, query, params
          const parsed = await (schema as ZodTypeAny).parseAsync({
            body: req.body,
            query: req.query,
            params: req.params,
          }) as any;

          if (parsed.body !== undefined) req.body = parsed.body;
          if (parsed.query !== undefined) req.query = parsed.query;
          if (parsed.params !== undefined) req.params = parsed.params;
        } else {
          // Schema is directly for req.body (e.g. chatMessageSchema `{ body: string }`)
          req.body = await (schema as ZodTypeAny).parseAsync(req.body);
        }
      } else {
        if (schema.body) {
          req.body = await schema.body.parseAsync(req.body);
        }
        if (schema.query) {
          req.query = await schema.query.parseAsync(req.query);
        }
        if (schema.params) {
          req.params = await schema.params.parseAsync(req.params);
        }
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errorDetails = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        }));

        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: error.errors[0]?.message || 'Invalid input data',
            details: errorDetails,
          },
        });
        return;
      }

      sendError(res, 'BAD_REQUEST', 'Invalid request format', 400);
    }
  };
};
