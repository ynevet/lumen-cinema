/**
 * A bearer token is as good as a password, and logs get shipped, tailed and pasted into
 * tickets. These tests pin the one property that matters: nothing that authenticates a
 * caller may appear in a log line.
 *
 * No database needed - the assertions are about the serializers, not about routes.
 */
import { describe, expect, it } from 'vitest';
import type { SerializedRequest, SerializedResponse } from 'pino-std-serializers';
import { serializeRequest, serializeResponse } from './httpLogger.js';

const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-payload.signature';

/** The shape pino-http hands a wrapped serializer, minus the `raw` message no log ever sees. */
function asSerialized<T>(value: Partial<T>): T {
  return value as T;
}

function serializedRequest(headers: Record<string, string>): SerializedRequest {
  return serializeRequest(
    asSerialized<SerializedRequest>({
      id: 1,
      method: 'GET',
      url: '/api/screenings',
      query: {},
      params: {},
      headers,
      remoteAddress: '127.0.0.1',
      remotePort: 54_321,
    }),
  );
}

describe('request serializer', () => {
  it('drops the Authorization header', () => {
    const serialized = serializedRequest({ authorization: TOKEN, host: 'localhost:4000' });

    expect(serialized.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(serialized)).not.toContain('super-secret-payload');
  });

  it('drops credential headers whatever case they arrive in', () => {
    const serialized = serializedRequest({ Authorization: TOKEN, Cookie: 'session=abc' });

    expect(serialized.headers).toEqual({});
  });

  it('drops headers nobody thought to name, rather than allowing them through', () => {
    const serialized = serializedRequest({
      'x-api-key': 'k-123',
      'proxy-authorization': TOKEN,
      'x-amz-security-token': 'aws-secret',
    });

    expect(serialized.headers).toEqual({});
  });

  it('keeps the headers that make a log line useful', () => {
    const serialized = serializedRequest({
      authorization: TOKEN,
      host: 'localhost:4000',
      'user-agent': 'vitest',
      'content-type': 'application/json',
      'x-request-id': 'req-7',
    });

    expect(serialized.headers).toEqual({
      host: 'localhost:4000',
      'user-agent': 'vitest',
      'content-type': 'application/json',
      'x-request-id': 'req-7',
    });
  });

  it('leaves the rest of the request line intact', () => {
    const serialized = serializedRequest({ authorization: TOKEN });

    expect(serialized).toMatchObject({
      method: 'GET',
      url: '/api/screenings',
      remoteAddress: '127.0.0.1',
    });
  });

  it('survives a request with no headers at all', () => {
    const bare = asSerialized<SerializedRequest>({ method: 'GET', url: '/' });

    expect(serializeRequest(bare).headers).toEqual({});
  });
});

describe('response serializer', () => {
  it('drops set-cookie but keeps the status code', () => {
    const serialized = serializeResponse(
      asSerialized<SerializedResponse>({
        statusCode: 200,
        headers: { 'set-cookie': 'session=abc', 'content-type': 'application/json' },
      }),
    );

    expect(serialized.statusCode).toBe(200);
    expect(serialized.headers).toEqual({ 'content-type': 'application/json' });
  });
});
