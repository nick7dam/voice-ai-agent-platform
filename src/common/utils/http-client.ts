import {
  IncomingHttpHeaders,
  request as httpRequest,
  RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface HttpTextResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

export interface HttpBufferResponse {
  status: number;
  body: Buffer;
  headers: IncomingHttpHeaders;
}

export interface HttpTextRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpStreamRequestOptions extends HttpTextRequestOptions {
  onChunk: (chunk: string) => void | Promise<void>;
}

export interface HttpBufferStreamRequestOptions extends HttpTextRequestOptions {
  onChunk: (
    chunk: Buffer,
    response: { status: number; headers: IncomingHttpHeaders },
  ) => void | Promise<void>;
  shouldStreamResponse?: (
    status: number,
    headers: IncomingHttpHeaders,
  ) => boolean;
}

export function requestText(
  url: string,
  options: HttpTextRequestOptions,
): Promise<HttpTextResponse> {
  const parsedUrl = new URL(url);
  const transport =
    parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return Promise.reject(
      new Error(`Unsupported protocol for HTTP request: ${parsedUrl.protocol}`),
    );
  }

  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const headers = {
      ...options.headers,
    };

    if (body && !headers['Content-Length']) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET',
      headers,
    };

    const req = transport(parsedUrl, requestOptions, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');

      response.on('data', (chunk: string) => {
        responseBody += chunk;
      });

      response.on('end', () => {
        clearTimeout(timeout);
        resolve({
          status: response.statusCode ?? 0,
          body: responseBody,
          headers: response.headers,
        });
      });
    });

    const timeout = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

export function requestBuffer(
  url: string,
  options: HttpTextRequestOptions,
): Promise<HttpBufferResponse> {
  const parsedUrl = new URL(url);
  const transport =
    parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return Promise.reject(
      new Error(`Unsupported protocol for HTTP request: ${parsedUrl.protocol}`),
    );
  }

  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const headers = {
      ...options.headers,
    };

    if (body && !headers['Content-Length']) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET',
      headers,
    };

    const req = transport(parsedUrl, requestOptions, (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      response.on('end', () => {
        clearTimeout(timeout);
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
          headers: response.headers,
        });
      });
    });

    const timeout = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

export function requestTextStream(
  url: string,
  options: HttpStreamRequestOptions,
): Promise<HttpTextResponse> {
  const parsedUrl = new URL(url);
  const transport =
    parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return Promise.reject(
      new Error(`Unsupported protocol for HTTP request: ${parsedUrl.protocol}`),
    );
  }

  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const headers = {
      ...options.headers,
    };

    if (body && !headers['Content-Length']) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET',
      headers,
    };

    const responseChunks: string[] = [];
    const pendingCallbacks: Array<Promise<void>> = [];

    const req = transport(parsedUrl, requestOptions, (response) => {
      response.setEncoding('utf8');

      response.on('data', (chunk: string) => {
        responseChunks.push(chunk);
        try {
          const result = options.onChunk(chunk);

          if (result instanceof Promise) {
            pendingCallbacks.push(
              result.catch((error: unknown) => {
                req.destroy(
                  error instanceof Error ? error : new Error(String(error)),
                );
                throw error;
              }),
            );
          }
        } catch (error) {
          req.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });

      response.on('end', () => {
        clearTimeout(timeout);
        void Promise.allSettled(pendingCallbacks).then(() => {
          resolve({
            status: response.statusCode ?? 0,
            body: responseChunks.join(''),
            headers: response.headers,
          });
        });
      });
    });

    const timeout = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

export function requestBufferStream(
  url: string,
  options: HttpBufferStreamRequestOptions,
): Promise<HttpBufferResponse> {
  const parsedUrl = new URL(url);
  const transport =
    parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return Promise.reject(
      new Error(`Unsupported protocol for HTTP request: ${parsedUrl.protocol}`),
    );
  }

  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const headers = {
      ...options.headers,
    };

    if (body && !headers['Content-Length']) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET',
      headers,
    };

    const responseChunks: Buffer[] = [];
    const pendingCallbacks: Array<Promise<void>> = [];

    const req = transport(parsedUrl, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      const shouldStream =
        options.shouldStreamResponse?.(status, response.headers) ?? true;

      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseChunks.push(buffer);

        if (!shouldStream) {
          return;
        }

        try {
          const result = options.onChunk(buffer, {
            status,
            headers: response.headers,
          });

          if (result instanceof Promise) {
            pendingCallbacks.push(
              result.catch((error: unknown) => {
                req.destroy(
                  error instanceof Error ? error : new Error(String(error)),
                );
                throw error;
              }),
            );
          }
        } catch (error) {
          req.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });

      response.on('end', () => {
        clearTimeout(timeout);
        void Promise.allSettled(pendingCallbacks).then(() => {
          resolve({
            status,
            body: Buffer.concat(responseChunks),
            headers: response.headers,
          });
        });
      });
    });

    const timeout = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    req.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}
