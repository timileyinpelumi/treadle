# Treadle

Background jobs and step workflows for Bun and Postgres.

Status: milestone 5 of 7. Jobs, retries, cancel and retry, periodic jobs, step workflows, and a dashboard. See `docs/scope.md`.

## Develop

Needs a Postgres reachable at `DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/treadle_test`. `docker compose up -d` provides one.

    bun install
    bun test

## Dashboard

    import { dashboard } from "treadle";
    Bun.serve({ fetch: dashboard(sql, { basePath: "/admin/jobs" }) });

Mount it behind your own auth. It shows counts, finished per minute, recent failures with retry and cancel, and workflow runs with their steps. `#run=<id>` in the URL opens that run.
