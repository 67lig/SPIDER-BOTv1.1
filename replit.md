# DonutSMP Stats & Discord Bot

A community tool for the DonutSMP Minecraft server with two main functions:
- **Stats Dashboard** — web UI to search and view player stats (money, shards, playtime, K/D, etc.) via the official DonutSMP API.
- **Discord Bot** — multi-function bot with support tickets, giveaways, moderation (warns, automod), XP/leveling, invite tracking, and player stats lookup.

## Stack

- **Backend**: Node.js + Express v5, TypeScript, esbuild
- **Database**: PostgreSQL (Replit built-in) + Drizzle ORM
- **Discord**: discord.js v14
- **Monorepo**: pnpm workspaces

## How to run

The API server workflow (`artifacts/api-server: API Server`) starts the app:

```
pnpm --filter @workspace/api-server run dev
```

This builds then starts the server. It serves the web UI and runs the Discord bot automatically when `BOT_ENABLED=1`.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `PORT` | Yes | Server port — set to `8080` |
| `BOT_ENABLED` | No | Set to `1` to launch the Discord bot |
| `DISCORD_BOT_TOKEN` | Yes (bot) | Secret — Discord bot token |
| `DONUTSMP_API_KEY` | Yes (stats) | Secret — DonutSMP API bearer token |
| `DATABASE_URL` | Yes (DB) | Runtime-managed by Replit |

## Database

Schema is managed via Drizzle Kit (`lib/db`). To push schema changes to the dev DB:

```
pnpm --filter db push
```

Bot storage uses a `bot_data_backup` PostgreSQL table (created automatically on first run) alongside a local `bot-data.json` file for active state.

## Project structure

```
artifacts/
  api-server/        # Express server + Discord bot
    src/
      app.ts         # Express app + web UI
      index.ts       # Entry point (server + bot bootstrap)
      bot/           # Discord bot logic
      routes/        # API routes (DonutSMP proxy)
      lib/           # Logger and shared utilities
lib/
  db/                # Drizzle schema + migrations
  api-spec/          # OpenAPI spec
  api-zod/           # Generated Zod schemas
  api-client-react/  # Generated React Query client
```

## User preferences

- Keep the existing monorepo structure (pnpm workspaces).
- Do not restructure or migrate the project stack.
