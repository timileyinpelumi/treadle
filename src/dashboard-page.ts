export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Treadle</title>
<style>
  :root { --ink: #16181d; --mute: #6b7078; --rule: #d9dce2; --ground: #f6f7f9; --bad: #9b2c2c; --good: #2f6b4f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 1.5rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1.5rem; }
  h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
  header span { color: var(--mute); font-size: 0.85rem; }
  h2 { margin: 2rem 0 0.5rem; font-size: 0.95rem; font-weight: 600; }
  .states { display: grid; grid-template-columns: repeat(6, 1fr); border-top: 1px solid var(--ink); }
  .states div { padding: 0.75rem 0; border-bottom: 1px solid var(--rule); }
  .states b { display: block; font-size: 1.5rem; font-weight: 600; line-height: 1.1; }
  .states span { color: var(--mute); font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; border-top: 1px solid var(--ink); }
  th, td { text-align: left; padding: 0.5rem 0.5rem 0.5rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { font-weight: 500; color: var(--mute); font-size: 0.85rem; }
  td.num, th.num { text-align: right; padding-right: 1rem; }
  .err { color: var(--bad); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; white-space: pre-wrap; max-width: 40rem; }
  button { font: inherit; font-size: 0.85rem; color: var(--ink); background: none; border: 1px solid var(--rule); border-radius: 3px; padding: 0.15rem 0.5rem; cursor: pointer; margin-right: 0.25rem; }
  button:hover { border-color: var(--ink); }
  .minutes { display: flex; align-items: flex-end; gap: 2px; height: 3rem; border-bottom: 1px solid var(--rule); padding-bottom: 2px; }
  .minutes div { flex: 1; display: flex; flex-direction: column-reverse; height: 100%; }
  .minutes i { display: block; background: var(--good); }
  .minutes i.bad { background: var(--bad); }
  .steps { margin: 0.25rem 0 0.5rem 1rem; }
  .steps div { padding: 0.25rem 0; border-bottom: 1px dashed var(--rule); }
  .state-completed { color: var(--good); } .state-discarded, .state-failed { color: var(--bad); } .state-cancelled { color: var(--mute); }
  .empty { color: var(--mute); padding: 0.75rem 0; }
  a.run { cursor: pointer; text-decoration: underline; }
  @media (max-width: 640px) { .states { grid-template-columns: repeat(3, 1fr); } }
</style>
</head>
<body>
<main>
  <header><h1>Treadle</h1><span id="updated">Loading</span></header>
  <div class="states" id="states"></div>
  <div id="queues"></div>
  <h2>Finished per minute, last hour</h2>
  <div class="minutes" id="minutes"></div>
  <h2>Recent failures</h2>
  <div id="failures"></div>
  <h2>Workflow runs</h2>
  <div id="runs"></div>
</main>
<script>
  const STATES = ["available", "running", "retryable", "completed", "discarded", "cancelled"];
  const open = new Set();
  if (location.hash.startsWith("#run=")) open.add(location.hash.slice(5));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const el = (id) => document.getElementById(id);

  async function act(path) {
    const r = await fetch("api/" + path, { method: "POST" });
    if (!r.ok) el("updated").textContent = "Action did not apply";
    load();
  }

  function renderStates(counts) {
    const total = {};
    for (const c of counts) total[c.state] = (total[c.state] || 0) + c.n;
    el("states").innerHTML = STATES.map((s) => "<div><b>" + (total[s] || 0) + "</b><span>" + s + "</span></div>").join("");
    const queues = [...new Set(counts.map((c) => c.queue))];
    if (queues.length < 2) { el("queues").innerHTML = ""; return; }
    el("queues").innerHTML = "<table><tr><th>Queue</th>" + STATES.map((s) => '<th class="num">' + s + "</th>").join("") + "</tr>" +
      queues.map((q) => "<tr><td>" + esc(q) + "</td>" + STATES.map((s) => '<td class="num">' + (counts.find((c) => c.queue === q && c.state === s)?.n || 0) + "</td>").join("") + "</tr>").join("") + "</table>";
  }

  function renderMinutes(rows) {
    const now = Date.now();
    const bins = [];
    for (let i = 59; i >= 0; i--) {
      const t = new Date(Math.floor(now / 60000) * 60000 - i * 60000).toISOString().slice(0, 17) + "00Z";
      bins.push({ t, completed: 0, discarded: 0 });
    }
    for (const r of rows) { const b = bins.find((x) => x.t === r.minute); if (b) b[r.state] = r.n; }
    const max = Math.max(1, ...bins.map((b) => b.completed + b.discarded));
    el("minutes").innerHTML = bins.map((b) =>
      '<div title="' + b.t.slice(11, 16) + ": " + b.completed + " completed, " + b.discarded + ' discarded">' +
      '<i style="height:' + (b.completed / max * 100) + '%"></i><i class="bad" style="height:' + (b.discarded / max * 100) + '%"></i></div>').join("");
  }

  function renderFailures(rows) {
    if (!rows.length) { el("failures").innerHTML = '<div class="empty">No failures on record.</div>'; return; }
    el("failures").innerHTML = "<table><tr><th>Job</th><th>Queue</th><th>State</th><th class=\\"num\\">Attempt</th><th>Error</th><th></th></tr>" +
      rows.map((r) => "<tr><td>" + esc(r.name) + " <span style=\\"color:var(--mute)\\">#" + r.id + "</span></td><td>" + esc(r.queue) + "</td>" +
        '<td class="state-' + r.state + '">' + r.state + '</td><td class="num">' + r.attempt + " / " + r.max_attempts + "</td>" +
        '<td class="err">' + esc(r.last_error.split("\\n")[0]) + "</td>" +
        '<td><button onclick="act(\\'jobs/' + r.id + '/retry\\')">Retry now</button><button onclick="act(\\'jobs/' + r.id + '/cancel\\')">Cancel</button></td></tr>').join("") + "</table>";
  }

  async function renderRuns(rows) {
    if (!rows.length) { el("runs").innerHTML = '<div class="empty">No workflow runs yet.</div>'; return; }
    let html = "<table><tr><th>Run</th><th>State</th><th class=\\"num\\">Step</th><th>Started</th><th></th></tr>";
    for (const r of rows) {
      html += '<tr><td><a class="run" onclick="toggle(\\'' + r.id + '\\')">' + esc(r.name) + " #" + r.id + "</a></td>" +
        '<td class="state-' + r.state + '">' + r.state + '</td><td class="num">' + r.current_step + "</td><td>" + esc(r.created_at.slice(0, 19)) + "</td>" +
        "<td>" + (r.state === "running" ? '<button onclick="act(\\'workflows/' + r.id + '/cancel\\')">Cancel</button>' : "") + "</td></tr>";
      if (open.has(r.id)) {
        const d = await (await fetch("api/workflows/" + r.id)).json();
        html += '<tr><td colspan="5"><div class="steps">' + d.steps.map((s) =>
          "<div>Step " + s.step_index + ' <span class="state-' + s.state + '">' + s.state + "</span>, attempt " + s.attempt +
          (s.has_result ? " <span style=\\"color:var(--mute)\\">result " + esc(JSON.stringify(s.result)) + "</span>" : "") +
          (s.last_error ? '<div class="err">' + esc(s.last_error.split("\\n")[0]) + "</div>" : "") +
          (s.state === "discarded" ? ' <button onclick="act(\\'jobs/' + s.job_id + '/retry\\')">Retry step</button>' : "") + "</div>").join("") + "</div></td></tr>";
      }
    }
    el("runs").innerHTML = html + "</table>";
  }

  function toggle(id) { open.has(id) ? open.delete(id) : open.add(id); load(); }

  async function load() {
    try {
      const d = await (await fetch("api/overview")).json();
      renderStates(d.counts); renderMinutes(d.perMinute); renderFailures(d.failures); await renderRuns(d.runs);
      el("updated").textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) { el("updated").textContent = "Could not reach the API"; }
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 3000);
</script>
</body>
</html>`;
