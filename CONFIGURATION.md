# ArtGen runtime configuration

## Local development

From `artgen-backend`, run:

```powershell
npm run dev:workspace
```

The launcher reads the backend `PORT` and frontend `FRONTEND_PORT`, reuses a
healthy ArtGen backend if one is already running, and rejects ports occupied by
another program. It also passes the resolved backend address to Next.js without
exposing it to browser code.

## Same-origin API

Browser code always calls `/api`. In development, Next.js rewrites that path to
`BACKEND_INTERNAL_URL`. In production, either configure the same variable at
build time or, preferably, route `/api/*` to the Nest backend in the public
reverse proxy. No backend address belongs in a `NEXT_PUBLIC_*` variable.

`CORS_ALLOWED_ORIGINS` is only needed for browsers that call Nest directly. It
accepts a comma-separated allowlist and intentionally rejects `*`.

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
