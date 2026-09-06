# Treadle

Background jobs and step workflows for Bun and Postgres.

Status: milestone 2 of 7. Enqueue and workers work. No retries with backoff, no workflows, no dashboard yet. See `docs/scope.md`.

## Develop

Needs a Postgres reachable at `DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/treadle_test`. `docker compose up -d` provides one.

    bun install
    bun test
