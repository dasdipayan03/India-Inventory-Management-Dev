(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  const duration = (seconds) => { const s = Math.max(0, Math.floor(Number(seconds) || 0)); const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60); return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`; };
  const num = (v) => new Intl.NumberFormat("en-IN").format(Number(v) || 0);
  const item = (label, value, tone = "") => `<div class="detail"><span>${esc(label)}</span><span class="${tone}">${esc(value)}</span></div>`;
  function render(m, health) {
    const r=m.requests||{}, db=m.db_pool||{}, jobs=m.background_jobs||{}, memory=m.memory_mb||{};
    const errorRate=r.total ? ((r.errors/r.total)*100).toFixed(1) : "0.0";
    $("uptime").textContent=duration(m.uptime_seconds); $("database").textContent=db.ready ? "Connected" : "Problem";
    $("dbNote").textContent=`Pool: ${db.total||0} total · ${db.waiting||0} waiting`;
    $("response").textContent=`${Number(r.avg_duration_ms||0).toFixed(1)} ms`; $("slow").textContent=`Slow requests: ${num(r.slow)}`;
    $("memory").textContent=`${Number(memory.rss||0).toFixed(1)} MB`; $("memoryNote").textContent=`Heap used: ${Number(memory.heap_used||0).toFixed(1)} MB`;
    const unhealthy=health?.overall_status === "critical" || !db.ready || (r.by_status_class?.["5xx"]||0)>0;
    $("overall").innerHTML=`<i class="dot"></i> ${unhealthy ? "Needs attention" : "System healthy"}`; $("overall").style.background=unhealthy?"#fef3c7":"#dcfce7"; $("overall").style.color=unhealthy?"#b45309":"#15803d";
    $("headline").textContent=unhealthy ? "The service is running, but review the error count below." : "Application, database, and scheduled jobs are operating normally.";
    const alerts=(health?.checks||[]).filter((check)=>check.severity !== "healthy");
    $("alerts").innerHTML=alerts.map((check)=>`<div class="detail"><span><strong class="${check.severity === "critical" ? "error" : ""}">${esc(check.severity.toUpperCase())}</strong> · ${esc(check.area)} · ${esc(check.title)}<br><small>${esc(check.detail)}${check.action ? ` Action: ${esc(check.action)}` : ""}</small></span></div>`).join("");
    $("noAlerts").hidden=alerts.length > 0;
    $("events").innerHTML=(health?.recent_events||[]).map((event)=>item(`${event.level.toUpperCase()} · ${event.event}`,new Date(event.ts).toLocaleString("en-IN"),event.level === "error" ? "error" : "")).join("") || '<p class="note">No warning or error event has been recorded since this app instance started.</p>';
    $("traffic").innerHTML=[item("Total requests",num(r.total)),item("Successful (2xx)",num(r.by_status_class?.["2xx"])),item("Redirects (3xx)",num(r.by_status_class?.["3xx"])),item("Client/auth errors (4xx)",num(r.by_status_class?.["4xx"])),item("Server errors (5xx)",num(r.by_status_class?.["5xx"]), (r.by_status_class?.["5xx"]||0)?"error":""),item("Overall error rate",`${errorRate}%`)].join("");
    $("services").innerHTML=[item("Database pool",db.ready?"Ready":"Not ready",db.ready?"":"error"),item("Background jobs",jobs.started?"Running":"Stopped",jobs.started?"":"error"),item("Last cleanup",jobs.lastCleanupAt?new Date(jobs.lastCleanupAt).toLocaleString("en-IN"):"—"),item("Export queue",`${jobs.exports?.queued||0} queued / ${jobs.exports?.active||0} active`),item("Cache entries",`${jobs.cache?.entries||0} / ${jobs.cache?.max_entries||0}`),item("Database",m.database?.database_version?"PostgreSQL connected":"Unavailable")].join("");
    $("routes").innerHTML=(r.top_routes||[]).slice(0,10).map(x=>`<tr><td>${esc(x.route)}</td><td class="right">${num(x.count)}</td><td class="right">${Number(x.avg_duration_ms||0).toFixed(1)} ms</td><td class="right ${x.errors?"error":""}">${num(x.errors)}</td></tr>`).join("") || '<tr><td colspan="4">No route data yet.</td></tr>';
    $("updated").textContent=`Live data updated: ${new Date(m.timestamp).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"medium"})}`; $("report").hidden=false;
  }
  async function load() { $("problem").hidden=true; $("refresh").disabled=true; $("refresh").textContent="Refreshing…"; try { const response=await fetch("/api/ops/health-report",{credentials:"same-origin",cache:"no-store"}); if(response.status===401||response.status===403){location.replace("/");return;} if(!response.ok) throw new Error(`Report request failed (${response.status})`); const data=await response.json(); if(!data.success) throw new Error(data.error||"Could not load report"); render(data.metrics,data.health); } catch(error) { $("problem").textContent=`Could not load the health report: ${error.message}`; $("problem").hidden=false; } finally { $("refresh").disabled=false; $("refresh").textContent="Refresh report"; } }
  $("refresh").addEventListener("click",load); load();
})();
