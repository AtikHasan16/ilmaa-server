# Imlaa backend

The Express server provides the legacy REST endpoints and the text-to-speech
endpoint. It uses Supabase for persistence; it does not use MongoDB or a local
JSON database.

The React frontend's data adapter talks directly to Supabase. The frontend uses
this server separately for `/api/v1/tts`, with browser speech synthesis as a
fallback.

## Requirements

- Node.js
- Supabase project URL and server key configured in `server/.env`
- Do not expose a Supabase service-role key to the browser or commit it

## Run locally

Run these commands from the `server` directory. The backend has its own
`package.json`; installing the frontend dependencies does not install these.

```bash
npm install
npm run dev
```

By default, the server listens on port `5000`; set `PORT` to override it.

## Deployment and security

Admin endpoints require a valid Supabase bearer token and an administrator
profile. User progress endpoints require a valid bearer token and only permit
access to the caller's own account. Legacy device-token authentication returns
`410 Gone`; it is not part of the current Supabase Auth flow.

The database policies in the root `supabase_schema.sql` must also be applied
to the Supabase project. Frontend route guards are not a substitute for RLS.

The audio cache is temporary and may be cleared when the server restarts.
