# Backend Agent Instructions & Governance (AGENTS.md)

This service is a hardened, authenticated text-to-speech (TTS) microservice for the Imlaa platform.

---

## 1. Project Map

- `index.js`: Express application with structured JSON logging, security headers, request timeouts (10s), input validation, rate limiting, and graceful shutdown handlers.
- `middleware/requireSupabaseAuth.js`: Supabase bearer-token validation middleware using `@supabase/supabase-js`.
- `test/`: Native Node.js test suite (`ttsApp.test.js`, `requireSupabaseAuth.test.js`).
- `scripts/scan-secrets.mjs`: Automated secret scanner.

---

## 2. Local Commands

```bash
npm ci                  # Clean dependency installation
npm run dev             # Launch development server with watch mode (PORT 5000)
npm run check           # Syntax and static module check (node --check)
npm test                # Automated unit test suite (node --test)
npm run security:scan   # Secret scanner (must find 0 credentials)
```

---

## 3. Strict Prohibitions

- **NEVER** expose CRUD, database tables, progress, or admin moderation endpoints from Express. All application data access belongs exclusively in Supabase PostgREST governed by RLS.
- **NEVER** store or require a Supabase `service_role` key in this service. Authentication verification requires only the anonymous key (`SUPABASE_ANON_KEY`).
- **NEVER** disable rate limiters or security headers.
- **NEVER** read, log, or commit `.env` or production credentials.

---

## 4. Pre-Submission Checklist

Before proposing or merging any backend changes:
- [ ] `npm run check` passes with 0 syntax errors.
- [ ] `npm test` passes all tests.
- [ ] `npm run security:scan` confirms 0 credential leaks.
- [ ] All new routes include strict input validation schemas and error handling.
