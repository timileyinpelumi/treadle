# Treadle

Background jobs and step workflows for Bun and Postgres.

Status: milestone 6 of 7. Library complete with crash point tests and load scripts. Case study and publish remain. See `docs/scope.md`.

## Develop

Needs a Postgres reachable at `DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/treadle_test`. `docker compose up -d` provides one.

    bun install
    bun test

## Dashboard

    import { dashboard } from "treadle";
    Bun.serve({ fetch: dashboard(sql, { basePath: "/admin/jobs" }) });

Mount it behind your own auth. It shows counts, finished per minute, recent failures with retry and cancel, and workflow runs with their steps. `#run=<id>` in the URL opens that run.

## Benchmarks

    WORKERS=4 JOBS=5000 bun run load
    ROWS=1000000 bun run claim-latency

Both use the `treadle_load` database on the same Postgres and drop the treadle schema there first.
