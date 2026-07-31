# ArtGen runtime configuration

## Development

Start the backend from `artgen-backend`:

```powershell
npm run dev
```

Then start the frontend from `artgen-frontend`:

```powershell
npm run dev
```

The backend treats `PORT` from `.env.development` as its preferred port and
defaults to `3001`. If that port is occupied, it automatically tries the next
port until it finds one that is available. The selected URL is published to a
git-ignored runtime descriptor in `artgen-backend/.artgen-dev/backend.json`.

The frontend waits for that descriptor and for the backend health check, then
starts Next.js with the selected backend URL. Browser requests continue to use
the same-origin `/api/*` path; no frontend source configuration changes when
the backend moves from `3001` to `3002` or another port.

Set `BACKEND_INTERNAL_URL` in the frontend process environment or its
`.env.development` file only when you need to override automatic development
discovery.

Next.js resolves its rewrite destination when the frontend starts. If the
backend is later restarted on a different port, restart the frontend with
`npm run dev` so it reads the new runtime URL.

## Image generation worker

`IMAGE_WORKER_CONCURRENCY` controls how many queued image jobs one backend
process can execute at the same time. It defaults to `10` and accepts values
from `1` to `20`:

```env
IMAGE_WORKER_CONCURRENCY=10
```

## Production

Build each service before starting it in production mode:

```powershell
npm run build
npm run prod
```

The backend loads `.env.production`. The frontend must receive
`BACKEND_INTERNAL_URL` when it is built, or `/api/*` must be routed to Nest by
the public reverse proxy. Development port discovery is not used in
production.

## Same-origin API

Browser code always calls `/api`. In development, Next.js rewrites that path to
`BACKEND_INTERNAL_URL`. In production, either configure the same variable at
build time or, preferably, route `/api/*` to the Nest backend in the public
reverse proxy. No backend address belongs in a `NEXT_PUBLIC_*` variable.

CORS is disabled by default. This is the recommended setup when Next.js or the
production reverse proxy serves `/api/*` from the same public origin.

Only set `ENABLE_CORS=true` when browser clients call Nest directly from a
different origin. In that case, `CORS_ALLOWED_ORIGINS` must contain the
comma-separated browser origins; wildcard origins are intentionally rejected.

## AI lines

`AI_LINES_CONFIG_FILE` points to the server-only JSON file that defines the
available lines. The default file is `config/ai-lines.json`:

```json
{
  "defaultLineId": "line-a",
  "lines": [
    {
      "id": "line-a",
      "name": "Line A",
      "baseUrlEnv": "AI_LINE_A_BASE_URL",
      "apiKeyEnv": "AI_LINE_A_API_KEY",
      "fallbackApiKeyEnv": "SUB2API_KEY"
    }
  ]
}
```

To add or remove a line, edit this JSON file and provide the referenced values
in the selected backend environment file. No DTO or frontend change is needed.
`enabled: false` can temporarily hide a line. API keys remain server-side and
are never returned by `GET /api/images/lines`.

`AI_DEFAULT_LINE` may override `defaultLineId` for a specific environment. The
selected default must refer to an enabled line.
