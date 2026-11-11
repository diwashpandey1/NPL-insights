# NPL Cricket Analytics Frontend

A responsive Nepal Premier League cricket experience with league branding, team directories, standings, match centre, player index, and head-to-head comparisons. The frontend currently has no connected league data feed, so unavailable scores, results, and statistics are shown as clearly labeled placeholders rather than invented records.

## Technology

React, Vite, TypeScript, Tailwind CSS v4, React Router, Lucide React, Framer Motion, React Toastify, Axios, and Recharts.

## Structure

```text
src/
├── components/  # Shared cricket and interface components
├── layouts/     # League-wide navigation and page shell
├── pages/       # Overview, players, teams, matches, standings, comparisons
├── routes/      # Application routes
├── services/    # Axios API client
├── constants/   # Team identity and logo mapping
├── App.tsx
└── main.tsx
```

## Setup

```sh
npm install
Copy-Item .env.example .env
```

Set `VITE_API_BASE_URL` to the backend API root. Its default is `http://localhost:5000/api/v1`. Never put server secrets in frontend environment variables.

## Commands

- `npm run dev` — start the Vite development server
- `npm run build` — type-check and build for production
- `npm run preview` — preview the production build
- `npm run lint` — run ESLint

## Routes

- `/` — Overview
- `/players` — Player index and role filters
- `/teams` — Eight-franchise directory
- `/matches` — Match centre and fixture status filters
- `/standings` — NPL points table
- `/head-to-head` — Franchise comparison

See [asset-attribution.md](./docs/asset-attribution.md) for branding and team-mark sources and usage notes.
