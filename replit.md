# DonutSMP Stats

Unofficial stats site for the DonutSMP Minecraft server. Shows player stats (money, shards, playtime, kills, etc.) fetched from the DonutSMP API. Includes an optional Discord moderation/ticket bot.

## Stack

- **Runtime:** Node.js 20 (pnpm workspace monorepo)
- **Server:** Express 5 + TypeScript, compiled with esbuild
- **Bot:** discord.js 14
- **DB:** PostgreSQL via `pg` (optional — used for bot data backup)

## How to run

The **Discord Bot** workflow builds and starts the server:

```
cd artifacts/api-server && pnpm run dev
```

Serves on port 5000.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | Port to listen on (Replit sets this to `5000`) |
| `DONUTSMP_API_TOKEN` | No | Bearer token for the DonutSMP API — without it, player stat lookups return errors |
| `DISCORD_TOKEN` | No | Discord bot token |
| `BOT_ENABLED` | No | Set to `1` to enable the Discord bot (production only by default) |
| `DATABASE_URL` | No | PostgreSQL connection string for bot data backup |

## Project structure

```
artifacts/api-server/   Express server + Discord bot
  src/app.ts            HTML page routes (home, players, player profile)
  src/index.ts          Server entry — starts Express + bot
  src/routes/donut.ts   Proxy routes to the DonutSMP API
  src/bot/bot.ts        Discord bot (slash commands, moderation, tickets)
  src/bot/storage.ts    Bot data storage (JSON file + optional PostgreSQL backup)
lib/api-zod/            Zod schemas generated from the OpenAPI spec
lib/api-client-react/   React query hooks for the API (unused by the server)
lib/db/                 Drizzle ORM schema (placeholder — not yet used)
```

## User preferences

- Keep the existing project structure and stack.
- `DONUTSMP_API_TOKEN` is intentionally left blank for now.
