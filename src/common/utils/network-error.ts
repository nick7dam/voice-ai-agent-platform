export interface NetworkErrorDetails {
  name?: string;
  message: string;
  cause?: unknown;
}

function serializeCause(cause: unknown): unknown {
  if (!cause || typeof cause !== 'object') {
    return cause;
  }

  const record = cause as Record<string, unknown>;

  return {
    name: record.name,
    message: record.message,
    code: record.code,
    errno: record.errno,
    syscall: record.syscall,
    address: record.address,
    port: record.port,
  };
}

export function describeNetworkError(error: unknown): NetworkErrorDetails {
  if (!(error instanceof Error)) {
    return {
      message: 'Unknown network error.',
      cause: error,
    };
  }

  return {
    name: error.name,
    message: error.message,
    cause: serializeCause((error as Error & { cause?: unknown }).cause),
  };
}
