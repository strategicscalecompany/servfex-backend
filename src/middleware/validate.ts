import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError, ZodTypeAny } from 'zod';
import { sendError } from '../utils/response';

export const validate = (schema: ZodTypeAny | { body?: AnyZodObject; query?: AnyZodObject; params?: AnyZodObject }) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if ('parseAsync' in schema) {
        const hasWrapperShape = (schema as any).shape && (
          (schema as any).shape.body !== undefined ||
          (schema as any).shape.query !== undefined ||
          (schema as any).shape.params !== undefined
        );

        if (hasWrapperShape) {
          // Full request schema with body, query, params
          const parsed = await schema.parseAsync({
            body: req.body,
            query: req.query,
            params: req.params,
          }) as any;

          if (parsed.body !== undefined) req.body = parsed.body;
          if (parsed.query !== undefined) req.query = parsed.query;
          if (parsed.params !== undefined) req.params = parsed.params;
        } else {
          // Schema is directly for req.body
          req.body = await schema.parseAsync(req.body);
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
