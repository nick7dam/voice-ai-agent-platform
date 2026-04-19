import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../common/constants/injection-tokens';
import { AppError } from '../../../common/types/errors';
import { requestText } from '../../../common/utils/http-client';
import { describeNetworkError } from '../../../common/utils/network-error';
import type { AppConfig } from '../../../config/app.config';

type QueryValue = string | number | boolean | null | undefined;

@Injectable()
export class BookingApiClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async getWithFallback<T>(
    primaryPath: string,
    fallbackPath: string,
  ): Promise<T> {
    try {
      return await this.get<T>(primaryPath);
    } catch (error) {
      if (error instanceof AppError && error.code === 'BOOKING_API_NOT_FOUND') {
        return this.get<T>(fallbackPath);
      }

      throw error;
    }
  }

  async checkReachability(): Promise<{
    reachable: boolean;
    skipped?: boolean;
    error?: unknown;
  }> {
    if (!this.config.bookingApi.configured) {
      return {
        reachable: false,
        skipped: true,
        error: 'BOOKING_API_BASE_URL is not configured.',
      };
    }

    try {
      await this.get<unknown>(this.config.bookingApi.healthPath);
      return { reachable: true };
    } catch (error) {
      return {
        reachable: false,
        error:
          error instanceof AppError
            ? {
                code: error.code,
                message: error.message,
                details: error.details,
              }
            : error instanceof Error
              ? describeNetworkError(error)
              : 'Unknown booking API health check error.',
      };
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    const api = this.config.bookingApi;
    if (!api.configured) {
      throw new AppError(
        'BOOKING_API_NOT_CONFIGURED',
        'Booking API is not configured.',
      );
    }

    const url = this.buildUrl(api.baseUrl, path, query);
    const requestBody = body === undefined ? undefined : JSON.stringify(body);

    try {
      const response = await requestText(url, {
        method,
        timeoutMs: api.timeoutMs,
        body: requestBody,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(api.apiKey.trim()
            ? {
                'X-API-Key': api.apiKey.trim(),
              }
            : {}),
        },
      });

      const parsedBody = this.parseJson(response.body);
      if (response.status >= 200 && response.status < 300) {
        return parsedBody as T;
      }

      const details = {
        method,
        path,
        status: response.status,
        body: parsedBody ?? response.body,
      };

      if (response.status === 404) {
        throw new AppError(
          'BOOKING_API_NOT_FOUND',
          'The booking API did not find a matching record.',
          details,
        );
      }

      throw new AppError(
        'BOOKING_API_REQUEST_FAILED',
        `Booking API returned HTTP ${response.status}.`,
        details,
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        'BOOKING_API_CONNECTION_FAILED',
        `Could not reach booking API at ${api.baseUrl}.`,
        {
          method,
          path,
          baseUrl: api.baseUrl,
          networkError:
            error instanceof Error ? describeNetworkError(error) : error,
        },
      );
    }
  }

  private buildUrl(
    baseUrl: string,
    path: string,
    query?: Record<string, QueryValue>,
  ): string {
    const url = new URL(
      `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
    );

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private parseJson(body: string): unknown {
    if (!body.trim()) {
      return null;
    }

    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
}
