export type ErrorDetails = unknown;

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails,
    public readonly recoverable = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: ErrorDetails;
  recoverable: boolean;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      recoverable: error.recoverable,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: error.message || 'Unexpected server error.',
      recoverable: true,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Unexpected server error.',
    recoverable: true,
  };
}
