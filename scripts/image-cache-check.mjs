import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateImageCacheHeaders(headers) {
  const issues = [];
  const cacheControl = headers.get('cache-control') || '';
  const contentLength = Number(headers.get('content-length'));
  const contentType = headers.get('content-type') || '';

  if (!/^image\//i.test(contentType))
    issues.push('content-type is not an image');
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    issues.push('content-length is missing');
  }
  if (!/(?:^|,)\s*public(?:\s*,|$)/i.test(cacheControl)) {
    issues.push('cache-control is not public');
  }
  if (!/(?:^|,)\s*max-age=31536000(?:\s*,|$)/i.test(cacheControl)) {
    issues.push('cache-control max-age is not one year');
  }
  if (!/(?:^|,)\s*immutable(?:\s*,|$)/i.test(cacheControl)) {
    issues.push('cache-control is not immutable');
  }
  if (!headers.get('etag')) issues.push('etag is missing');
  if (headers.get('accept-ranges') !== 'bytes') {
    issues.push('byte ranges are not enabled');
  }

  return issues;
}

export function parseImageCacheCheckUrl(value) {
  if (!value)
    throw new Error('Usage: npm run check:image-cache -- <image-url>');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error('Image URL must use HTTP(S) without credentials');
  }
  return url;
}

export function validateCloudflareObservation(observation) {
  const issues = [];
  if (observation.cache !== 'HIT') {
    issues.push('second Cloudflare request is not a cache hit');
  }
  if (!/^\d+$/.test(observation.age || '')) {
    issues.push('Cloudflare Age is missing');
  }
  if (!observation.rayColo) issues.push('Cloudflare PoP is missing');
  return issues;
}

async function main() {
  const url = parseImageCacheCheckUrl(process.argv[2]);
  const observations = [];
  for (let run = 1; run <= 2; run += 1) {
    const startedAt = performance.now();
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    observations.push({
      run,
      status: response.status,
      milliseconds: Number((performance.now() - startedAt).toFixed(1)),
      cache: response.headers.get('cf-cache-status'),
      age: response.headers.get('age'),
      rayColo: (response.headers.get('cf-ray') || '').split('-').at(-1) || null,
    });
    if (!response.ok) throw new Error(`Image returned HTTP ${response.status}`);
    const issues = validateImageCacheHeaders(response.headers);
    if (issues.length) throw new Error(issues.join('; '));
  }

  const cloudflareIssues = validateCloudflareObservation(observations[1]);
  if (cloudflareIssues.length) throw new Error(cloudflareIssues.join('; '));
  console.log(
    JSON.stringify(
      {
        target: `${url.origin}${url.pathname}`,
        observations,
      },
      null,
      2,
    ),
  );
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
