# zod-bridge demo

A tiny app that installs `zod-bridge` from a freshly packed tarball (exactly what npm users get)
and walks through every feature against a real Postgres.

```bash
docker compose up --build --abort-on-container-exit
docker compose down -v   # clean up
```

The script is [`main.ts`](./main.ts). No interaction needed; it prints each scenario and exits.
