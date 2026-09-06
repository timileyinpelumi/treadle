import { expect, test } from "bun:test";
import { dashboard } from "../src/dashboard";
import { jobState, setup } from "./helpers";

function req(path: string, method = "GET"): Request {
  return new Request(`http://treadle.local${path}`, { method });
}

test("serves the page at the base path and redirects the bare base path", async () => {
  const { sql } = await setup();
  const handle = dashboard(sql, { basePath: "/admin/jobs" });
  const page = await handle(req("/admin/jobs/"));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(await page.text()).toContain("<title>Treadle</title>");
  const bare = await handle(req("/admin/jobs"));
  expect(bare.status).toBe(308);
  expect(bare.headers.get("location")).toBe("/admin/jobs/");
  expect((await handle(req("/elsewhere"))).status).toBe(404);
  await sql.end();
});

test("overview returns counts, per-minute series, failures, and runs", async () => {
  const { sql, treadle } = await setup();
  const handle = dashboard(sql);
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await sql`update treadle.jobs set state = 'discarded', last_error = 'x', finished_at = now() where id = ${id}`;
  await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  const res = await handle(req("/api/overview"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { counts: unknown; perMinute: { state: string }[]; failures: unknown[]; runs: unknown[] };
  expect(body.counts).toEqual([
    { queue: "default", state: "available", n: 1 },
    { queue: "default", state: "discarded", n: 1 },
  ]);
  expect(body.perMinute[0]?.state).toBe("discarded");
  expect(body.failures.length).toBe(1);
  expect(body.runs.length).toBe(1);
  await sql.end();
});

test("actions retry and cancel through the client and report whether they applied", async () => {
  const { sql, treadle } = await setup();
  const handle = dashboard(sql);
  const id = await sql.begin((tx) => treadle.enqueue(tx, "a", {}));
  await sql`update treadle.jobs set state = 'discarded', finished_at = now() where id = ${id}`;
  expect((await handle(req(`/api/jobs/${id}/retry`, "POST"))).status).toBe(200);
  expect(await jobState(sql, id)).toBe("available");
  expect((await handle(req(`/api/jobs/${id}/cancel`, "POST"))).status).toBe(200);
  expect(await jobState(sql, id)).toBe("cancelled");
  expect((await handle(req(`/api/jobs/${id}/cancel`, "POST"))).status).toBe(404);
  expect((await handle(req(`/api/jobs/${id}/retry`))).status).toBe(405);

  const runId = await sql.begin((tx) => treadle.startWorkflow(tx, "wf", {}));
  const detail = await handle(req(`/api/workflows/${runId}`));
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as { steps: unknown[] }).steps.length).toBe(1);
  expect((await handle(req(`/api/workflows/${runId}/cancel`, "POST"))).status).toBe(200);
  expect((await handle(req(`/api/workflows/${runId}/cancel`, "POST"))).status).toBe(404);
  expect((await handle(req(`/api/workflows/nope`))).status).toBe(404);
  await sql.end();
});
