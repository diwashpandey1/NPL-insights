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

## Health check

`GET http://localhost:5000/api/v1/health` returns a JSON status response.
