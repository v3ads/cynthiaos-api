# cynthiaos-api

CynthiaOS API service (backend-for-frontend). Reads Gold analytics objects from Neon Postgres, enforces RBAC, assembles role-scoped context for the AI Copilot, and routes operational writes to AppFolio.

> **Status:** Scaffold only (TASK-011). Business logic is not yet implemented.

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev
```

Health check: `GET http://localhost:3003/health`

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Run with hot-reload (ts-node-dev) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run typecheck` | Type-check without emitting |

## Docker

```bash
docker build -t cynthiaos-api .
docker run -p 3003:3003 --env-file .env cynthiaos-api
```

## Railway Deployment

- **Start command:** `node dist/index.js`
- **Build command:** `npm ci && npm run build`
- **Port:** Set `PORT` environment variable in Railway dashboard

## Environment Variables

See `.env.example` for all required variables.
