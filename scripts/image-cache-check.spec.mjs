import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseImageCacheCheckUrl,
  validateCloudflareObservation,
  validateImageCacheHeaders,
} from './image-cache-check.mjs';

function healthyHeaders() {
  return new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': '12345',
    'content-type': 'image/webp',
    etag: '"variant-1"',
  });
}

test('accepts immutable image responses with validators and ranges', () => {
  assert.deepEqual(validateImageCacheHeaders(healthyHeaders()), []);
});

test('reports every missing image cache contract', () => {
  const issues = validateImageCacheHeaders(
    new Headers({
      'cache-control': 'max-age=14400',
      'content-type': 'text/plain',
    }),
  );
  assert.equal(issues.length, 7);
});

test('rejects non-http and credential-bearing targets', () => {
  assert.throws(() => parseImageCacheCheckUrl('file:///tmp/image.webp'));
  assert.throws(() =>
    parseImageCacheCheckUrl('https://user:secret@example.com/image.webp'),
  );
});

test('requires a second-request Cloudflare hit with age and PoP', () => {
  assert.deepEqual(
    validateCloudflareObservation({ cache: 'HIT', age: '12', rayColo: 'SIN' }),
    [],
  );
  assert.equal(
    validateCloudflareObservation({ cache: null, age: null, rayColo: null })
      .length,
    3,
  );
  assert.equal(
    validateCloudflareObservation({
      cache: 'REVALIDATED',
      age: '0',
      rayColo: 'SIN',
    }).length,
    1,
  );
});
