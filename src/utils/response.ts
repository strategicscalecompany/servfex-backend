import { Response } from 'express';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const sendSuccess = <T>(
  res: Response,
  data: T,
  statusCode = 200,
  pagination?: PaginationMeta
) => {
  return res.status(statusCode).json({
    success: true,
    data,
    ...(pagination ? { pagination } : {}),
  });
};

export const sendError = (
  res: Response,
  code: string,
  message: string,
  statusCode = 400
) => {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
  });
};
