import { PAGE } from "./dashboard-page";
import { overview, recentFailures, workflowRun, workflowRuns } from "./dashboard-queries";
import type { Sql } from "./sql";
import { Treadle } from "./treadle";

export interface DashboardOptions {
  basePath?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function dashboard(sql: Sql, options: DashboardOptions = {}) {
  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const treadle = new Treadle(sql);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (base && !url.pathname.startsWith(base)) return new Response("Not found", { status: 404 });
    const path = url.pathname.slice(base.length);

    if (path === "") return Response.redirect(`${base}/`, 308);
    if (path === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/api/overview") {
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const [o, failures, runs] = await Promise.all([overview(sql), recentFailures(sql), workflowRuns(sql)]);
      return json({ ...o, failures, runs });
    }

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/workflows\/([^/]+)$/))) {
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const detail = await workflowRun(sql, m[1]!);
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }
    if ((m = path.match(/^\/api\/(jobs|workflows)\/(\d+)\/(retry|cancel)$/))) {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const [, kind, id, action] = m;
      let ok = false;
      if (kind === "jobs" && action === "retry") ok = await treadle.retry(id!);
      else if (kind === "jobs" && action === "cancel") ok = await treadle.cancel(id!);
      else if (kind === "workflows" && action === "cancel") ok = await treadle.cancelWorkflow(id!);
      else return json({ error: "not found" }, 404);
      return ok ? json({ ok: true }) : json({ ok: false }, 404);
    }
    return new Response("Not found", { status: 404 });
  };
}
