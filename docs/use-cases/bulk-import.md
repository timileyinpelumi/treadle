# Bulk import in chunks

**For:** CSV imports, backfills, migrations, batch recomputation. Any job too big to run as one unit.

**Code:** [examples/bulk-import.ts](../../examples/bulk-import.ts)

## The problem

A hundred thousand row import as one job takes an hour, holds one worker, and restarts from zero after a crash. Split into chunks it runs in parallel and a crash costs one chunk, but now something has to know when every chunk is done, and re-running the import must not double the rows.

## The shape

Fan out to one job per chunk in the same transaction that records the import, with a key per chunk:

```ts
for (const part of chunk(rows, 500)) {
  await treadle.enqueue(tx, "import-chunk", { importId, index: i, rows: part }, {
    queue: "imports",
    priority: 5,
    idempotencyKey: `import:${importId}:${i}`,
  });
  i++;
}
```

Re-running `startImport` for the same id enqueues nothing new. The chunk rows travel in the job args, which is fine at 500 rows; for larger chunks store the file and pass offsets.

Priority 5 puts import chunks behind interactive work sharing the queue. Or give imports their own queue and worker, which is what the example does, so an import never takes slots from anything else.

Each chunk is safe to run twice because the row insert is `on conflict do nothing`, and the completion count is protected by a per-chunk marker row that can only be inserted once:

```ts
const rows = await sql`
  insert into import_chunks_done (import_id, index) values (${args.importId}, ${args.index})
  on conflict do nothing returning index`;
if (rows.length === 1) {
  await sql`update imports set done_chunks = done_chunks + 1, ... where id = ${args.importId}`;
}
```

Without that marker, a chunk re-run after a crash would count itself twice and the import would finish early.

## Joining

Treadle has no fan-in primitive. The counter above is the join: the last chunk to increment the counter sets `finished_at`. If the import needs a final step, such as building an index or sending a summary, the chunk that observes `done_chunks + 1 = total_chunks` enqueues it, inside the same transaction as the update so it cannot be lost.

## When it fails

One chunk has bad data: it throws, retries, and is discarded, with the chunk index in the job and the error on the dashboard. The other chunks finish. The import shows `done_chunks` one short of `total_chunks`. Fix the data or the handler, retry the chunk from the dashboard, and the import completes.

## What to look at

`done_chunks` against `total_chunks` per import in your own table is the progress bar. Discarded `import-chunk` jobs on the dashboard, grouped by import id, are the chunks needing attention.
