import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : 500;
  const message = status >= 500 ? 'Internal server error' : String(error.message ?? 'Request failed');

  res.status(status).json({
    success: false,
    error: { message },
  });
};
