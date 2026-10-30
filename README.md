# Imlaa TTS service

The Express service handles authenticated text-to-speech only. Supabase
PostgREST, protected by RLS, is the application's data API; the service does
not expose CRUD, admin, access-ID, or progress routes.

The frontend sends TTS requests to `POST /api/tts`. Supabase Auth verifies the
bearer token; requests are limited by client IP and signed-in user. Public
landing-page audio uses browser speech synthesis and does not call this
service.

## Requirements

- Node.js
- Supabase project URL and anon key in `.env`, copied from `.env.example`
- The service does not need or use a Supabase service-role key

## Run locally

Run these commands from the `server` directory:

```bash
npm ci
npm run dev
```

The server listens on port `5000` by default. Set `PORT` to override it and
`CORS_ORIGINS` to a comma-separated list of exact frontend origins (include
the production site and any allowed preview origins).

## Deployment and security

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `CORS_ORIGINS` in the hosting
environment. TTS requests require a valid Supabase session. The service applies
in-memory limits of 120 requests per minute per IP and 30 per minute per user.
For multi-instance or serverless deployments, configure an additional shared
rate limit at the hosting edge; in-memory counters are not shared across
instances and reset on restart.

The Supabase schema and security migration are maintained in the frontend
repository's `database/` directory. Normal data access remains in the browser
using the anon key and RLS.

The generated-audio cache is temporary and may be cleared when the service
restarts.
