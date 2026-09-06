export const migrations: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      create table treadle.jobs (
        id               bigint generated always as identity primary key,
        queue            text not null default 'default',
        name             text not null,
        args             jsonb not null default '{}'::jsonb,
        state            text not null default 'available'
                         check (state in ('available','running','completed','retryable','discarded','cancelled')),
        priority         smallint not null default 0,
        run_at           timestamptz not null default now(),
        attempt          smallint not null default 0,
        max_attempts     smallint not null default 25,
        lease_until      timestamptz,
        worker_id        text,
        idempotency_key  text,
        every_ms         integer,
        workflow_run_id  bigint,
        step_index       smallint,
        last_error       text,
        cancel_requested boolean not null default false,
        created_at       timestamptz not null default now(),
        started_at       timestamptz,
        finished_at      timestamptz
      );

      create index jobs_claim_idx on treadle.jobs (queue, priority, run_at)
        where state in ('available', 'retryable');

      create index jobs_rescue_idx on treadle.jobs (lease_until)
        where state = 'running';

      create unique index jobs_idempotency_key_idx on treadle.jobs (idempotency_key)
        where idempotency_key is not null;

      create table treadle.workflow_runs (
        id            bigint generated always as identity primary key,
        name          text not null,
        input         jsonb not null default '{}'::jsonb,
        state         text not null default 'running'
                      check (state in ('running','completed','failed','cancelled')),
        current_step  smallint not null default 0,
        created_at    timestamptz not null default now(),
        finished_at   timestamptz
      );

      create table treadle.step_results (
        workflow_run_id  bigint not null references treadle.workflow_runs (id) on delete cascade,
        step_index       smallint not null,
        result           jsonb,
        finished_at      timestamptz not null default now(),
        primary key (workflow_run_id, step_index)
      );
    `,
  },
];
