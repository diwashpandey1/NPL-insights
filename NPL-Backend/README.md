# NPL Cricket Analytics Backend

The backend foundation for the NPL Cricket Analytics platform. It provides a versioned Express API, validated environment configuration, centralized error handling, and a server-only Supabase client placeholder. Cricket data APIs and ingestion are not implemented yet.

## Technology

Node.js, TypeScript, Express, Supabase JavaScript client, Zod, dotenv, Helmet, CORS, and Morgan.

## Structure

```text
src/
├── config/       # Environment and Supabase setup
├── middleware/   # Shared Express middleware
├── routes/       # Versioned API route handlers
├── controllers/  # Future request handlers
├── services/     # Future application logic
├── repositories/ # Future data access
├── modules/      # Future cricket domains
├── types/        # Shared TypeScript types
├── utils/        # Shared helpers
├── app.ts        # Express app configuration
└── server.ts     # HTTP server entry point
```

## Setup

```sh
npm install
Copy-Item .env.example .env
```

Set `PORT`, `NODE_ENV`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Supabase values are optional for the health endpoint. Keep the service role key on the server and out of source control.

## Commands

- `npm run dev` — start with watch mode
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server
- `npm run typecheck` — check types without emitting files
- `npm run ingest:inspect` — inspect source files and their integrity metadata
- `npm run ingest:validate` — validate the configured 2024/25 sources without writing to the database
- `npm run ingest:dry-run` — generate an ingestion dry-run report from the current source feed
- `npm run ingest:season -- 2024/25` — run the configured season ingest flow
- `npm run ingest:all` — run all supported season inventory through the pipeline
- `npm run ingest:report` — generate a human-readable ingestion report summary

## Ingestion status

The backend now includes a modular ingestion scaffold for the normalized 2024/25 delivery feed and NPL match feed under `src/ingestion/`. It validates source rows, canonicalizes known alias variants (for example, `Gorkhas`/`Gurkhas`), and produces actionable issue records without mutating the authoritative processing project. The 2026/27 Cricsheet archive is intentionally left out of the default run unless its mapping is explicitly reviewed.

## Health check

`GET http://localhost:5000/api/v1/health` returns a JSON status response.
