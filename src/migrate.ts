import type { Sql } from "./sql";
import { migrations } from "./schema";

export async function migrate(sql: Sql): Promise<void> {
  await sql`create schema if not exists treadle`;
  await sql`
    create table if not exists treadle.migrations (
      version     integer primary key,
      applied_at  timestamptz not null default now()
    )`;

  await sql.begin(async (tx) => {
    // Serialise concurrent migrate calls from several workers starting at once.
    await tx`select pg_advisory_xact_lock(7231001)`;
    const applied = new Set(
      (await tx`select version from treadle.migrations`).map((r) => Number(r.version)),
    );
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await tx.unsafe(m.sql);
      await tx`insert into treadle.migrations (version) values (${m.version})`;
    }
  });
}
