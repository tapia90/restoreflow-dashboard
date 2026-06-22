const stages = ["Assessment", "Stabilizing", "Mitigation", "Abatement", "Monitoring", "Repairs", "Mitigation Complete"];
const stageColors = ["#e5a03f", "#3e7bdd", "#2c9a79", "#d56b35", "#8b98aa", "#7653c8", "#c84646"];
const stageMigration = {Inspection:"Assessment", Estimate:"Assessment", Final:"Mitigation Complete"};
const storageKey = "restoreflow-jobs-v2";
const todoStorageKey = "restoreflow-todos-v1";
const legacyStorageKey = "restoreflow-jobs";
const todoRecordId = "__restoreflow_todos__";
const equipmentKeys = ["dehumidifiers","airMovers","axials","negativeAir"];
const unitStatuses = ["Needs access","No access","Demo needed","Under mitigation","Finished"];
const defaultTasks = () => [
  {id:crypto.randomUUID(),title:"Initial assessment",assignee:"",due:"",done:true},
  {id:crypto.randomUUID(),title:"Work authorization signed",assignee:"",due:"",done:true},
  {id:crypto.randomUUID(),title:"Material test results reviewed",assignee:"",due:"",done:false},
  {id:crypto.randomUUID(),title:"Mitigation / demo completed",assignee:"",due:"",done:false},
  {id:crypto.randomUUID(),title:"Abatement completed if required",assignee:"",due:"",done:false},
  {id:crypto.randomUUID(),title:"Daily moisture documentation",assignee:"",due:"",done:false},
  {id:crypto.randomUUID(),title:"Remove drying equipment",assignee:"",due:"",done:false},
  {id:crypto.randomUUID(),title:"Customer completion certificate",assignee:"",due:"",done:false}
];
const seedJobs = [];

let activeJobId = null;
let pendingDeleteId = null;
let jobs = loadJobs();
let todos = loadTodos();
let cloudClient = null;
let cloudUser = null;
let authMode = "signin";
let cloudReady = false;

function currentTimestamp() {
  return new Date().toISOString();
}

function touchJob(job) {
  job.updatedAt = currentTimestamp();
  return job;
}

function loadJobs() {
  const stored = localStorage.getItem(storageKey);
  if (stored) return normalizeJobs(JSON.parse(stored));
  const legacy = localStorage.getItem(legacyStorageKey);
  if (legacy) return normalizeJobs(JSON.parse(legacy));
  return seedJobs;
}

function loadTodos() {
  return normalizeTodos(JSON.parse(localStorage.getItem(todoStorageKey) || "[]"));
}

function normalizeTodos(list) {
  return Array.isArray(list) ? list.map(todo => ({
    id:todo.id || crypto.randomUUID(),
    title:todo.title || "",
    done:Boolean(todo.done),
    createdAt:todo.createdAt || currentTimestamp(),
    updatedAt:todo.updatedAt || todo.createdAt || currentTimestamp()
  })).filter(todo => todo.title.trim()) : [];
}

function normalizeEquipmentLogs(logs) {
  return Array.isArray(logs) ? logs.map(log => ({
    id:log.id || crypto.randomUUID(),
    date:dateOnly(log.date || log.createdAt),
    technician:log.technician || "",
    dehumidifiers:Number(log.dehumidifiers) || 0,
    airMovers:Number(log.airMovers) || 0,
    axials:Number(log.axials) || 0,
    negativeAir:Number(log.negativeAir) || 0,
    notes:log.notes || "",
    carriedForward:Boolean(log.carriedForward),
    createdAt:log.createdAt || currentTimestamp()
  })).filter(log => log.date) : [];
}

function normalizeUnits(job) {
  const units = Array.isArray(job.units) ? job.units : [];
  const normalized = units.map(unit => ({
    id:unit.id || crypto.randomUUID(),
    name:unit.name || unit.unit || unit.suite || "",
    status:unitStatuses.includes(unit.status) ? unit.status : "Needs access",
    notes:unit.notes || "",
    createdAt:unit.createdAt || currentTimestamp(),
    updatedAt:unit.updatedAt || unit.createdAt || currentTimestamp()
  })).filter(unit => unit.name.trim());
  if (!normalized.length && (job.unitSuite || job.unit || job.suite)) {
    normalized.push({
      id:crypto.randomUUID(),
      name:job.unitSuite || job.unit || job.suite,
      status:"Needs access",
      notes:"",
      createdAt:job.createdAt || currentTimestamp(),
      updatedAt:job.updatedAt || job.createdAt || currentTimestamp()
    });
  }
  return normalized;
}

function normalizeJobs(list) {
  return list.map(job => {
    const targetDate = job.targetDate || parseLegacyDate(job.target);
    const stage = stages.includes(job.stage) ? job.stage : stageMigration[job.stage] || "Mitigation Complete";
    return {
      ...job, id:job.id || job.jobNumber, jobNumber:job.jobNumber || job.id, stage,
      unitSuite:job.unitSuite || job.unit || job.suite || "",
      targetDate, insurer:job.insurer || "Pending", priority:job.priority || "Normal",
      projectDirector:job.projectDirector || job.manager || "",
      documentFolder:job.documentFolder || "",
      materialStatus:job.materialStatus || "Pending",
      abatementStatus:job.abatementStatus || (stage === "Abatement" ? "In progress" : "Not required"),
      units:normalizeUnits(job),
      equipmentLogs:normalizeEquipmentLogs(job.equipmentLogs),
      tasks:Array.isArray(job.tasks) ? job.tasks : defaultTasks(),
      notes:Array.isArray(job.notes) ? job.notes : [],
      createdAt:job.createdAt || currentTimestamp(),
      updatedAt:job.updatedAt || job.createdAt || "1970-01-01T00:00:00.000Z"
    };
  });
}

function parseLegacyDate(value) {
  if (!value) return "";
  const parsed = new Date(`${value}, 2026 12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0,10);
}

async function saveJobs() {
  jobs.forEach(carryForwardEquipmentLogs);
  localStorage.setItem(storageKey, JSON.stringify(jobs));
  localStorage.setItem(todoStorageKey, JSON.stringify(todos));
  renderOverview();
  updateJobCount();
  if (cloudReady && cloudUser) await syncJobsToCloud();
}

async function syncJobsToCloud() {
  const todoUpdatedAt = todos.reduce((latest,todo) => new Date(todo.updatedAt) > new Date(latest) ? todo.updatedAt : latest, "1970-01-01T00:00:00.000Z");
  const records = [
    ...jobs.map(job => ({id:job.id,user_id:cloudUser.id,data:job,updated_at:job.updatedAt || currentTimestamp()})),
    {id:todoRecordId,user_id:cloudUser.id,data:{kind:"todos",items:todos},updated_at:todoUpdatedAt}
  ];
  if (records.length) {
    const {error} = await cloudClient.from("jobs").upsert(records,{onConflict:"user_id,id"});
    if (error) return showToast("Cloud sync failed",error.message);
  }
  const {data:remote,error:readError} = await cloudClient.from("jobs").select("id");
  if (readError) return showToast("Cloud sync failed",readError.message);
  const localIds = new Set([...jobs.map(job=>job.id), todoRecordId]);
  const stale = remote.filter(row=>!localIds.has(row.id)).map(row=>row.id);
  if (stale.length) await cloudClient.from("jobs").delete().in("id",stale);
  setSyncLabel("Saved to cloud");
}

function setSyncLabel(text) {
  const email = document.querySelector("#profileEmail");
  if (email && cloudUser) email.textContent = `${cloudUser.email} · ${text}`;
}

function mergeJobs(localJobs, remoteJobs) {
  const merged = new Map();
  [...localJobs, ...remoteJobs].forEach(job => {
    const existing = merged.get(job.id);
    if (!existing || new Date(job.updatedAt) >= new Date(existing.updatedAt)) merged.set(job.id, job);
  });
  return [...merged.values()].sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function mergeTodos(localTodos, remoteTodos) {
  const merged = new Map();
  [...localTodos, ...remoteTodos].forEach(todo => {
    const existing = merged.get(todo.id);
    if (!existing || new Date(todo.updatedAt) >= new Date(existing.updatedAt)) merged.set(todo.id, todo);
  });
  return [...merged.values()].sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function loadCloudJobs() {
  const {data,error} = await cloudClient.from("jobs").select("data").order("updated_at",{ascending:false});
  if (error) throw error;
  if (data.length) {
    const remoteTodos = data.find(row => row.data?.kind === "todos")?.data?.items || [];
    const remoteJobs = data.map(row=>row.data).filter(item => item && item.kind !== "todos");
    jobs = mergeJobs(normalizeJobs(jobs), normalizeJobs(remoteJobs));
    todos = mergeTodos(normalizeTodos(todos), normalizeTodos(remoteTodos));
    localStorage.setItem(storageKey,JSON.stringify(jobs));
    localStorage.setItem(todoStorageKey,JSON.stringify(todos));
    await syncJobsToCloud();
  } else {
    await syncJobsToCloud();
  }
  cloudReady = true;
  renderOverview(); updateJobCount();
}

const initials = name => (name || "?").split(" ").map(n => n[0]).join("").slice(0,2);
const typeSymbol = type => ({Water:"W",Fire:"F",Mold:"M",Reconstruction:"R"}[type] || "J");
const money = value => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(value)||0);
const slug = text => String(text || "").toLowerCase().replace(/\s/g,"");
const formatDate = value => {
  if (!value) return "Not set";
  const date = dateOnly(value);
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:new Date(date).getFullYear() !== new Date().getFullYear() ? "numeric":undefined});
};
const isLate = () => false;
const completedCount = job => job.tasks.filter(task => task.done).length;
const sortedEquipmentLogs = job => [...(job.equipmentLogs || [])].sort((a,b) => compareDates(b.date,a.date) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
const latestEquipmentLog = job => sortedEquipmentLogs(job)[0];
const equipmentTotal = log => equipmentKeys.reduce((sum,key) => sum + (Number(log?.[key]) || 0),0);
const sortedJobs = list => [...list].sort((a,b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
const unitSummary = job => {
  const total = job.units?.length || 0;
  const finished = (job.units || []).filter(unit => unit.status === "Finished").length;
  return total ? `${finished}/${total} finished` : "No units";
};
const locationLine = job => job.address;

function dateOnly(value) {
  if (!value) return new Date().toISOString().slice(0,10);
  const text = String(value);
  const parsed = new Date(text.includes("T") ? text : `${text}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0,10) : parsed.toISOString().slice(0,10);
}

function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00`);
  parsed.setDate(parsed.getDate() + days);
  return parsed.toISOString().slice(0,10);
}

function compareDates(a,b) {
  return new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`);
}

function carriedEquipmentLog(job, sourceLog, date) {
  return {
    id:`carry-${job.id}-${date}`,
    date,
    technician:"Auto carry-forward",
    dehumidifiers:Number(sourceLog.dehumidifiers) || 0,
    airMovers:Number(sourceLog.airMovers) || 0,
    axials:Number(sourceLog.axials) || 0,
    negativeAir:Number(sourceLog.negativeAir) || 0,
    notes:"Carried forward from last saved equipment count.",
    carriedForward:true,
    createdAt:currentTimestamp()
  };
}

function carryForwardEquipmentLogs(job) {
  const logs = normalizeEquipmentLogs(job.equipmentLogs);
  const actualLogs = logs.filter(log => !log.carriedForward);
  if (!actualLogs.length) {
    job.equipmentLogs = logs;
    return job.equipmentLogs;
  }

  const actualByDate = new Map();
  actualLogs.forEach(log => {
    const existing = actualByDate.get(log.date);
    if (!existing || new Date(log.createdAt || 0) >= new Date(existing.createdAt || 0)) actualByDate.set(log.date, log);
  });

  const dates = [...actualByDate.keys()].sort(compareDates);
  const today = new Date().toISOString().slice(0,10);
  const nextLogs = [];
  let latestActual = null;

  dates.forEach(date => {
    if (latestActual) {
      for (let day = addDays(latestActual.date,1); compareDates(day,date) < 0 && compareDates(day,today) <= 0; day = addDays(day,1)) {
        nextLogs.push(carriedEquipmentLog(job,latestActual,day));
      }
    }
    latestActual = actualByDate.get(date);
    nextLogs.push(latestActual);
  });

  if (latestActual) {
    for (let day = addDays(latestActual.date,1); compareDates(day,today) <= 0; day = addDays(day,1)) {
      nextLogs.push(carriedEquipmentLog(job,latestActual,day));
    }
  }

  job.equipmentLogs = nextLogs.sort((a,b) => compareDates(b.date,a.date) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return job.equipmentLogs;
}

function showToast(title,message) {
  document.querySelector("#toastTitle").textContent = title;
  document.querySelector("#toastMessage").textContent = message;
  const toast = document.querySelector("#toast");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"),2600);
}

function updateJobCount() {
  document.querySelector(".nav-count").textContent = jobs.length;
}

function jobRow(job,showMenu=false) {
  return `<tr data-job="${job.id}">
    <td><div class="job-cell"><span class="job-type-icon ${slug(job.type)}">${typeSymbol(job.type)}</span><div><strong>${escapeHtml(job.jobNumber)} · ${escapeHtml(locationLine(job))}</strong><span>${escapeHtml(job.customer)}</span></div></div></td>
    <td>${formatDate(job.createdAt)}</td>
    <td>${escapeHtml(job.type)}</td><td><span class="status ${slug(job.stage)}">${escapeHtml(job.stage)}</span></td>
    <td><span class="unit-table-summary">${escapeHtml(unitSummary(job))}</span></td>
    <td><div class="manager-cell"><span class="mini-avatar">${initials(job.projectDirector)}</span>${escapeHtml(job.projectDirector || "Not assigned")}</div></td>
    ${showMenu?`<td class="kebab">•••</td>`:""}
  </tr>`;
}

function renderOverview() {
  const openTasks = jobs.reduce((sum,job) => sum + job.tasks.filter(task => !task.done).length,0);
  const openTodos = todos.filter(todo => !todo.done).length;
  const metrics = document.querySelectorAll(".metric-card");
  metrics[0].querySelector("h2").textContent = jobs.length;
  metrics[0].querySelector("small").textContent = `Across ${stages.length} project stages`;
  metrics[1].querySelector("h2").textContent = openTasks;
  metrics[1].querySelector(".trend").textContent = `${openTasks} open`;
  metrics[2].querySelector("h2").textContent = openTodos;
  metrics[2].querySelector("small").textContent = "Billing questions and follow-ups";
  document.querySelector(".attention-banner strong").textContent = `${openTodos} to-dos to complete`;
  document.querySelector(".attention-banner span").textContent = openTodos ? "Billing or office follow-ups need your attention." : "No billing follow-ups are currently open.";

  const counts = stages.map(stage => jobs.filter(job => job.stage === stage).length);
  document.querySelector("#pipelineChart").innerHTML = stages.map((stage,i) =>
    `<div class="chart-row"><span>${stage}</span><div class="chart-track"><div class="chart-bar" style="width:${Math.max(counts[i]*28,7)}%;background:${stageColors[i]}"></div></div><strong>${counts[i]}</strong></div>`
  ).join("");

  renderTodos();
  document.querySelector("#activeJobsTable").innerHTML = sortedJobs(jobs).slice(0,5).map(job => jobRow(job,true)).join("");
  bindJobRows();
}

function renderPipeline() {
  document.querySelector("#kanbanBoard").innerHTML = stages.map((stage,i) => {
    const stageJobs = sortedJobs(jobs).filter(job => job.stage === stage);
    return `<section class="kanban-column"><div class="kanban-header"><strong><span style="color:${stageColors[i]}">●</span> ${stage}</strong><span>${stageJobs.length}</span></div>
      ${stageJobs.map(job => `<article class="job-card" data-job="${job.id}">
        <div class="job-card-top"><span class="status ${slug(job.type)}">${job.type}</span><span class="priority-label ${slug(job.priority)}">${job.priority}</span></div>
        <h4>${escapeHtml(job.jobNumber)}</h4><p>${escapeHtml(locationLine(job))}<br>${escapeHtml(job.customer)}</p>
        <div class="job-card-footer"><span class="mini-avatar">${initials(job.projectDirector)}</span><span>${escapeHtml(job.projectDirector || "Not assigned")}</span></div>
      </article>`).join("") || `<div class="empty-column">No jobs</div>`}
    </section>`;
  }).join("");
  bindJobRows();
}

function renderJobs() {
  const query = (document.querySelector("#jobSearch")?.value || "").toLowerCase();
  const stage = document.querySelector("#stageFilter")?.value || "";
  const type = document.querySelector("#typeFilter")?.value || "";
  const filtered = sortedJobs(jobs).filter(job => (!query || `${job.jobNumber} ${job.customer} ${job.address} ${job.unitSuite} ${(job.units || []).map(unit => unit.name).join(" ")} ${job.projectDirector}`.toLowerCase().includes(query)) && (!stage || job.stage===stage) && (!type || job.type===type));
  document.querySelector("#allJobsTable").innerHTML = filtered.map(job => jobRow(job)).join("") || `<tr><td colspan="6" class="empty-state">No matching jobs found.</td></tr>`;
  bindJobRows();
}

function renderDetail(id) {
  const job = jobs.find(item => item.id===id);
  if (!job) return showView("jobs");
  carryForwardEquipmentLogs(job);
  activeJobId = id;
  const done = completedCount(job);
  const open = job.tasks.length-done;
  const latestEquipment = latestEquipmentLog(job) || {};
  document.querySelector("#jobDetail").innerHTML = `
    <div class="detail-heading">
      <div><p class="eyebrow">${escapeHtml(job.jobNumber)} · ${escapeHtml(job.type.toUpperCase())} LOSS</p><h1>${escapeHtml(job.customer)}</h1><p>${escapeHtml(locationLine(job))}</p></div>
      <div class="detail-actions"><button class="btn secondary" data-action="edit-job">Edit job</button><button class="btn danger-outline" data-action="delete-job">Delete</button></div>
    </div>
    <div class="workflow-strip panel">
      <div><span>Current stage</span><select id="detailStage">${stages.map(stage=>`<option ${stage===job.stage?"selected":""}>${stage}</option>`).join("")}</select></div>
      <div><span>Progress</span><div class="range-wrap"><input id="detailProgress" type="range" min="0" max="100" value="${job.progress}"><strong id="progressValue">${job.progress}%</strong></div></div>
      <button class="btn primary" id="saveWorkflowBtn">Save workflow</button>
    </div>
    <div class="detail-layout">
      <div class="detail-main">
        <article class="panel">
          <div class="panel-header"><div><h3>Job information</h3><p>Key project details</p></div></div>
          <div class="info-grid">
            <div class="info-item"><span>Job number</span><strong>${escapeHtml(job.jobNumber)}</strong></div><div class="info-item"><span>Created</span><strong>${formatDate(job.createdAt)}</strong></div><div class="info-item"><span>Insurance carrier</span><strong>${escapeHtml(job.insurer)}</strong></div><div class="info-item"><span>Loss type</span><strong>${escapeHtml(job.type)}</strong></div>
            <div class="info-item"><span>Units / suites</span><strong>${escapeHtml(unitSummary(job))}</strong></div><div class="info-item"><span>Project director</span><strong>${escapeHtml(job.projectDirector || "Not assigned")}</strong></div><div class="info-item"><span>Priority</span><strong>${escapeHtml(job.priority)}</strong></div>
            <div class="info-item"><span>Documents</span>${job.documentFolder?`<a href="${escapeAttribute(job.documentFolder)}" target="_blank" rel="noopener">Open document folder</a>`:`<strong>Not added</strong>`}</div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Units / suites tracker</h3><p>Track access, demo, mitigation, and finished areas</p></div><span class="pill">${escapeHtml(unitSummary(job))}</span></div>
          <form class="unit-form" id="unitForm">
            <label>Unit / suite / office<input name="name" required placeholder="Unit 204, Suite B, Office 3"></label>
            <label>Status<select name="status">${unitStatuses.map(status => `<option>${status}</option>`).join("")}</select></label>
            <label class="full">Notes<input name="notes" placeholder="Tenant issue, no access, demo needed, complete, etc."></label>
            <button class="btn primary full">Add unit / suite</button>
          </form>
          <div class="unit-list">${renderUnits(job)}</div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Project checklist</h3><p>${done} of ${job.tasks.length} completed</p></div><button class="text-btn" id="addTaskBtn">＋ Add task</button></div>
          <div id="taskList">${job.tasks.map(task => `<div class="task-row ${task.done?"done":""}" data-task="${task.id}">
            <input type="checkbox" ${task.done?"checked":""} aria-label="Complete ${escapeHtml(task.title)}">
            <div><strong>${escapeHtml(task.title)}</strong></div>
            <button class="task-delete" aria-label="Delete task">×</button>
          </div>`).join("") || `<div class="empty-state">No tasks yet.</div>`}</div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Equipment tracker</h3><p>Daily count of equipment left on site</p></div></div>
          ${equipmentSummary(job)}
          <form class="equipment-form" id="equipmentForm">
            <label>Date<input name="date" type="date" required value="${new Date().toISOString().slice(0,10)}"></label>
            <label>Technician<input name="technician" placeholder="Who counted equipment?"></label>
            <label>Dehumidifiers<input name="dehumidifiers" type="number" min="0" value="${Number(latestEquipment.dehumidifiers)||0}"></label>
            <label>Air movers<input name="airMovers" type="number" min="0" value="${Number(latestEquipment.airMovers)||0}"></label>
            <label>Axials<input name="axials" type="number" min="0" value="${Number(latestEquipment.axials)||0}"></label>
            <label>Negative air<input name="negativeAir" type="number" min="0" value="${Number(latestEquipment.negativeAir)||0}"></label>
            <label class="full">Notes<input name="notes" placeholder="Added/removed equipment, missing unit, picked up, etc."></label>
            <button class="btn primary full">Save daily equipment count</button>
          </form>
          <div class="equipment-log-list">${renderEquipmentLogs(job)}</div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Job notes</h3><p>Updates are saved with the project</p></div></div>
          <form class="note-form" id="noteForm"><textarea id="noteText" required placeholder="Add a field update, customer call, or project note..."></textarea><button class="btn primary">Add note</button></form>
          <div class="notes-list">${job.notes.length ? [...job.notes].reverse().map(note=>`<div class="note-item"><p>${escapeHtml(note.text)}</p><span>${new Date(note.createdAt).toLocaleString()}</span></div>`).join("") : `<div class="empty-state">No notes have been added.</div>`}</div>
        </article>
      </div>
      <aside class="detail-sidebar">
        <article class="panel">
          <div class="panel-header"><div><h3>Testing & abatement</h3><p>Required safety checkpoints</p></div></div>
          <label class="control-label">Material test result<select id="materialStatus"><option>Pending</option><option>Clear</option><option>Hot</option></select></label>
          <label class="control-label">Abatement status<select id="abatementStatus"><option>Not required</option><option>Pending</option><option>In progress</option><option>Completed</option></select></label>
          <button class="btn primary full-btn" id="saveSafetyBtn">Save status</button>
        </article>
        <article class="panel"><div class="panel-header"><div><h3>Job health</h3><p>Current project snapshot</p></div></div>
          <div class="side-stat"><span>Progress</span><strong>${job.progress}%</strong></div><div class="mini-progress health-progress"><span style="width:${job.progress}%"></span></div>
          <div class="side-stat"><span>Open tasks</span><strong>${open}</strong></div>
          <div class="side-stat"><span>Equipment on site</span><strong>${equipmentTotal(latestEquipmentLog(job))}</strong></div>
          <div class="side-stat"><span>Material testing</span><strong class="${job.materialStatus==="Hot"?"hot-status":""}">${job.materialStatus}</strong></div><div class="side-stat"><span>Abatement</span><strong>${job.abatementStatus}</strong></div>
        </article>
      </aside>
    </div>`;
  document.querySelector("#materialStatus").value = job.materialStatus;
  document.querySelector("#abatementStatus").value = job.abatementStatus;
  bindDetailActions(job);
  showView("jobDetail");
}

function bindDetailActions(job) {
  const progress = document.querySelector("#detailProgress");
  progress.addEventListener("input",()=>document.querySelector("#progressValue").textContent=`${progress.value}%`);
  document.querySelector("#saveWorkflowBtn").onclick = async () => {
    job.stage = document.querySelector("#detailStage").value;
    job.progress = Number(progress.value);
    touchJob(job);
    await saveJobs(); renderDetail(job.id); showToast("Workflow saved","Stage and progress were updated.");
  };
  document.querySelector("#saveSafetyBtn").onclick = async () => {
    job.materialStatus = document.querySelector("#materialStatus").value;
    job.abatementStatus = document.querySelector("#abatementStatus").value;
    if (job.materialStatus==="Hot" && job.abatementStatus!=="Completed") job.stage="Abatement";
    touchJob(job);
    await saveJobs(); renderDetail(job.id); showToast("Safety status saved","Testing and abatement were updated.");
  };
  document.querySelector('[data-action="edit-job"]').onclick=()=>openJobModal(job);
  document.querySelector('[data-action="delete-job"]').onclick=()=>openDeleteConfirm(job.id);
  document.querySelector("#addTaskBtn").onclick=()=>openTaskModal(job.id);
  document.querySelectorAll("[data-task]").forEach(row => {
    row.querySelector('input[type="checkbox"]').onchange = event => {
      const task = job.tasks.find(item=>item.id===row.dataset.task);
      task.done=event.target.checked; touchJob(job); saveJobs(); renderDetail(job.id);
    };
    row.querySelector(".task-delete").onclick = () => {
      job.tasks=job.tasks.filter(item=>item.id!==row.dataset.task); touchJob(job); saveJobs(); renderDetail(job.id); showToast("Task removed","The checklist was updated.");
    };
  });
  document.querySelector("#noteForm").onsubmit = event => {
    event.preventDefault();
    const text=document.querySelector("#noteText").value.trim();
    if (!text) return;
    job.notes.push({id:crypto.randomUUID(),text,createdAt:currentTimestamp()});
    touchJob(job); saveJobs(); renderDetail(job.id); showToast("Note added","The update was saved to this job.");
  };
  document.querySelector("#unitForm").onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    job.units = job.units || [];
    job.units.push({
      id:crypto.randomUUID(),
      name:data.name,
      status:unitStatuses.includes(data.status) ? data.status : "Needs access",
      notes:data.notes || "",
      createdAt:currentTimestamp(),
      updatedAt:currentTimestamp()
    });
    touchJob(job); saveJobs(); renderDetail(job.id); showToast("Unit added","The unit tracker was updated.");
  };
  document.querySelectorAll("[data-unit-status]").forEach(select => {
    select.onchange = event => {
      const unit = job.units.find(item => item.id === select.dataset.unitStatus);
      if (!unit) return;
      unit.status = event.target.value;
      unit.updatedAt = currentTimestamp();
      touchJob(job); saveJobs(); renderDetail(job.id); showToast("Unit status saved",`${unit.name} is now marked ${unit.status}.`);
    };
  });
  document.querySelectorAll("[data-unit-delete]").forEach(button => {
    button.onclick = () => {
      job.units = (job.units || []).filter(unit => unit.id !== button.dataset.unitDelete);
      touchJob(job); saveJobs(); renderDetail(job.id); showToast("Unit removed","The unit tracker was updated.");
    };
  });
  document.querySelector("#equipmentForm").onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    job.equipmentLogs = (job.equipmentLogs || []).filter(log => log.date !== data.date);
    job.equipmentLogs.unshift({
      id:crypto.randomUUID(),
      date:data.date,
      technician:data.technician || "",
      dehumidifiers:Number(data.dehumidifiers) || 0,
      airMovers:Number(data.airMovers) || 0,
      axials:Number(data.axials) || 0,
      negativeAir:Number(data.negativeAir) || 0,
      notes:data.notes || "",
      carriedForward:false,
      createdAt:currentTimestamp()
    });
    touchJob(job); saveJobs(); renderDetail(job.id); showToast("Equipment count saved","The daily equipment count was saved.");
  };
}

function renderUnits(job) {
  const units = job.units || [];
  return units.length ? units.map(unit => `<div class="unit-item ${slug(unit.status)}">
    <div><strong>${escapeHtml(unit.name)}</strong><span>Updated ${formatDate(unit.updatedAt)}</span></div>
    <select data-unit-status="${unit.id}">${unitStatuses.map(status => `<option ${status===unit.status?"selected":""}>${status}</option>`).join("")}</select>
    <button class="unit-delete" data-unit-delete="${unit.id}" aria-label="Remove ${escapeHtml(unit.name)}">×</button>
    ${unit.notes?`<p>${escapeHtml(unit.notes)}</p>`:""}
  </div>`).join("") : `<div class="empty-state">No units, suites, or offices added yet.</div>`;
}

function equipmentSummary(job) {
  const latest = latestEquipmentLog(job);
  if (!latest) return `<div class="equipment-summary empty">No equipment count has been recorded for this job yet.</div>`;
  return `<div class="equipment-summary">
    <div><span>Last count</span><strong>${formatDate(latest.date)}</strong></div>
    <div><span>Dehus</span><strong>${Number(latest.dehumidifiers)||0}</strong></div>
    <div><span>Air movers</span><strong>${Number(latest.airMovers)||0}</strong></div>
    <div><span>Axials</span><strong>${Number(latest.axials)||0}</strong></div>
    <div><span>Negative air</span><strong>${Number(latest.negativeAir)||0}</strong></div>
  </div>`;
}

function renderEquipmentLogs(job) {
  const logs = sortedEquipmentLogs(job);
  return logs.length ? logs.map(log => `<div class="equipment-log-item ${log.carriedForward?"carried":""}">
    <div><strong>${formatDate(log.date)}</strong><span>${log.carriedForward?"Auto carry-forward":escapeHtml(log.technician || "Technician not listed")}</span></div>
    <div class="equipment-counts"><span>DH ${Number(log.dehumidifiers)||0}</span><span>AM ${Number(log.airMovers)||0}</span><span>AX ${Number(log.axials)||0}</span><span>NA ${Number(log.negativeAir)||0}</span></div>
    ${log.carriedForward?`<p>This count was carried forward automatically from the last saved field count.</p>`:(log.notes?`<p>${escapeHtml(log.notes)}</p>`:"")}
  </div>`).join("") : `<div class="empty-state">No equipment history yet.</div>`;
}

function bindJobRows() {
  document.querySelectorAll("[data-job]").forEach(row=>row.onclick=()=>renderDetail(row.dataset.job));
}

function renderTodos() {
  const openTodos = todos.filter(todo => !todo.done);
  document.querySelector(".priorities-panel .pill").textContent = `${openTodos.length} open`;
  document.querySelector("#priorityList").innerHTML = `
    <form class="todo-form" id="todoForm">
      <input id="todoInput" placeholder="Add billing question or follow-up..." required>
      <button class="btn primary small">Add</button>
    </form>
    <div class="todo-list">${todos.length ? todos.map(todo => `<div class="todo-item ${todo.done?"done":""}" data-todo="${todo.id}">
      <input type="checkbox" ${todo.done?"checked":""} aria-label="Complete ${escapeHtml(todo.title)}">
      <span>${escapeHtml(todo.title)}</span>
      <button class="todo-delete" aria-label="Delete to-do">×</button>
    </div>`).join("") : `<div class="empty-state">No to-dos yet. Add billing questions or follow-ups here.</div>`}</div>
  `;
  document.querySelector("#todoForm").onsubmit = event => {
    event.preventDefault();
    const input = document.querySelector("#todoInput");
    const title = input.value.trim();
    if (!title) return;
    todos.unshift({id:crypto.randomUUID(),title,done:false,createdAt:currentTimestamp(),updatedAt:currentTimestamp()});
    input.value = "";
    saveJobs(); showToast("To-do added","Your follow-up was added.");
  };
  document.querySelectorAll("[data-todo]").forEach(row => {
    const todo = todos.find(item => item.id === row.dataset.todo);
    row.querySelector('input[type="checkbox"]').onchange = event => {
      todo.done = event.target.checked;
      todo.updatedAt = currentTimestamp();
      saveJobs();
    };
    row.querySelector(".todo-delete").onclick = () => {
      todos = todos.filter(item => item.id !== row.dataset.todo);
      saveJobs(); showToast("To-do removed","Your follow-up list was updated.");
    };
  });
}

function showView(name) {
  document.querySelectorAll(".view").forEach(view=>view.classList.remove("active"));
  const known=["overview","pipeline","jobs","jobDetail"];
  const target=known.includes(name)?document.querySelector(`#${name}View`):document.querySelector("#placeholderView");
  target.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(item=>item.classList.toggle("active",item.dataset.view===name));
  if (!known.includes(name)) document.querySelector("#placeholderTitle").textContent=name[0].toUpperCase()+name.slice(1);
  if (name==="pipeline") renderPipeline();
  if (name==="jobs") renderJobs();
  window.scrollTo({top:0,behavior:"smooth"});
}

const jobModal=document.querySelector("#jobModal");
const jobForm=document.querySelector("#newJobForm");
function updateModalLock() {
  document.body.classList.toggle("modal-open", jobModal.classList.contains("open") || taskModal.classList.contains("open"));
}
function openJobModal(job=null) {
  jobForm.reset();
  jobForm.elements.originalId.value=job?.id || "";
  document.querySelector("#jobModalEyebrow").textContent=job?"EDIT PROJECT":"NEW PROJECT";
  document.querySelector("#jobModalTitle").textContent=job?"Edit job":"Create a job";
  document.querySelector("#jobSubmitBtn").textContent=job?"Save changes":"Create job";
  if (job) {
    ["customer","type","address","jobNumber","unitSuite","projectDirector","stage","priority","insurer","documentFolder"].forEach(key=>jobForm.elements[key].value=job[key] ?? "");
  } else {
    jobForm.elements.stage.value="Assessment";
    jobForm.elements.priority.value="Normal";
  }
  jobModal.classList.add("open");
  updateModalLock();
  jobForm.elements.customer.focus();
}
function closeJobModal(){jobModal.classList.remove("open");updateModalLock();}

const taskModal=document.querySelector("#taskModal");
function openTaskModal(jobId){document.querySelector("#newTaskForm").reset();document.querySelector('#newTaskForm [name="jobId"]').value=jobId;taskModal.classList.add("open");updateModalLock();}
function closeTaskModal(){taskModal.classList.remove("open");updateModalLock();}

jobForm.onsubmit=event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(jobForm));
  const editing=jobs.find(job=>job.id===data.originalId);
  const numbers=jobs.map(job=>Number((job.id.match(/\d+/)||[0])[0])).filter(Number.isFinite);
  const generated=`RF-${Math.max(1048,...numbers)+1}`;
  const jobNumber=data.jobNumber.trim()||generated;
  const duplicate=jobs.some(job=>job.id!==editing?.id && job.jobNumber.toLowerCase()===jobNumber.toLowerCase());
  if (duplicate) return showToast("Job number in use","Choose a unique job number.");
  if (editing) {
    Object.assign(editing,{customer:data.customer,address:data.address,unitSuite:data.unitSuite||"",type:data.type,projectDirector:data.projectDirector||"",stage:data.stage,priority:data.priority,insurer:data.insurer||"Pending",documentFolder:data.documentFolder||"",jobNumber});
    touchJob(editing);
    closeJobModal();saveJobs();renderDetail(editing.id);showToast("Job updated","Your changes were saved.");
  } else {
    const createdAt=currentTimestamp();
    const starterUnit = data.unitSuite ? [{id:crypto.randomUUID(),name:data.unitSuite,status:"Needs access",notes:"",createdAt,updatedAt:createdAt}] : [];
    const job={id:jobNumber,jobNumber,customer:data.customer,address:data.address,unitSuite:data.unitSuite||"",units:starterUnit,type:data.type,projectDirector:data.projectDirector||"",stage:data.stage,priority:data.priority,insurer:data.insurer||"Pending",documentFolder:data.documentFolder||"",progress:5,materialStatus:"Pending",abatementStatus:"Not required",equipmentLogs:[],tasks:defaultTasks(),notes:[],createdAt,updatedAt:createdAt};
    jobs.push(job);closeJobModal();saveJobs();renderDetail(job.id);showToast("Job created","The project is ready to manage.");
  }
};

document.querySelector("#newTaskForm").onsubmit=event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(event.target));
  const job=jobs.find(item=>item.id===data.jobId);
  if (!job) return;
  job.tasks.push({id:crypto.randomUUID(),title:data.title,assignee:"",due:"",done:false});
  touchJob(job);
  closeTaskModal();saveJobs();renderDetail(job.id);showToast("Task added","The checklist was updated.");
};

function openDeleteConfirm(id){pendingDeleteId=id;document.querySelector("#confirmBar").classList.add("show");}
function closeDeleteConfirm(){pendingDeleteId=null;document.querySelector("#confirmBar").classList.remove("show");}
document.querySelector("#confirmDeleteBtn").onclick=()=>{
  jobs=jobs.filter(job=>job.id!==pendingDeleteId);closeDeleteConfirm();saveJobs();showView("jobs");showToast("Job deleted","The project was removed.");
};
document.querySelector("#cancelDeleteBtn").onclick=closeDeleteConfirm;

document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>showView(button.dataset.view));
document.querySelectorAll("[data-view-target]").forEach(button=>button.onclick=()=>showView(button.dataset.viewTarget));
document.querySelector("#newJobBtn").onclick=()=>openJobModal();
document.querySelectorAll(".new-job-trigger").forEach(button=>button.onclick=()=>openJobModal());
document.querySelector(".modal-close").onclick=closeJobModal;
document.querySelector(".modal-cancel").onclick=closeJobModal;
document.querySelector(".task-modal-close").onclick=closeTaskModal;
document.querySelector(".task-modal-cancel").onclick=closeTaskModal;
jobModal.onclick=event=>{if(event.target===jobModal)closeJobModal();};
taskModal.onclick=event=>{if(event.target===taskModal)closeTaskModal();};

document.querySelector("#stageFilter").innerHTML+=stages.map(stage=>`<option>${stage}</option>`).join("");
["jobSearch","stageFilter","typeFilter"].forEach(id=>document.querySelector(`#${id}`).addEventListener(id==="jobSearch"?"input":"change",renderJobs));
document.querySelector("#globalSearch").onkeydown=event=>{
  if(event.key==="Enter"){showView("jobs");document.querySelector("#jobSearch").value=event.target.value;renderJobs();}
};
document.querySelector("#exportBtn").onclick=()=>{
  const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),jobs},null,2)],{type:"application/json"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`restoreflow-backup-${new Date().toISOString().slice(0,10)}.json`;link.click();URL.revokeObjectURL(link.href);
  showToast("Backup exported","Your job data was downloaded.");
};
function cloudConfigured() {
  const config=window.RESTOREFLOW_CONFIG||{};
  return Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
}

function showAuth() { document.querySelector("#authScreen").classList.add("visible"); }
function hideAuth() { document.querySelector("#authScreen").classList.remove("visible"); }
function setAuthError(message="") { document.querySelector("#authError").textContent=message; }

async function initializeCloud() {
  if (!cloudConfigured()) {
    showAuth();
    document.querySelector("#cloudSetupNotice").classList.add("visible");
    document.querySelector("#authForm").style.display="none";
    return;
  }
  cloudClient=window.supabase.createClient(window.RESTOREFLOW_CONFIG.supabaseUrl,window.RESTOREFLOW_CONFIG.supabaseAnonKey);
  const {data:{session}}=await cloudClient.auth.getSession();
  if (session?.user) await enterCloudApp(session.user);
  else showAuth();
  cloudClient.auth.onAuthStateChange(async(event,session)=>{
    if (event==="SIGNED_OUT"){cloudUser=null;cloudReady=false;showAuth();}
  });
}

async function enterCloudApp(user) {
  cloudUser=user;
  document.querySelector("#profileName").textContent=user.email.split("@")[0];
  setSyncLabel("Syncing");
  try {
    await loadCloudJobs();
    hideAuth();
  } catch(error) {
    showAuth(); setAuthError(error.message);
  }
}

document.querySelector("#authSwitch").onclick=()=>{
  authMode=authMode==="signin"?"signup":"signin";
  const signup=authMode==="signup";
  document.querySelector("#authTitle").textContent=signup?"Create owner account":"Sign in";
  document.querySelector("#authCopy").textContent=signup?"Create the secure account you will use on every device.":"Use the same account on your computer, iPad, and phone.";
  document.querySelector("#authSubmit").textContent=signup?"Create account":"Sign in";
  document.querySelector("#authSwitch").textContent=signup?"Already have an account? Sign in":"Create the owner account";
  setAuthError();
};
document.querySelector("#authForm").onsubmit=async event=>{
  event.preventDefault(); setAuthError();
  const email=document.querySelector("#authEmail").value.trim();
  const password=document.querySelector("#authPassword").value;
  const redirectTo="https://tapia90.github.io/restoreflow-dashboard/";
  document.querySelector("#authSubmit").disabled=true;
  const result=authMode==="signup"
    ? await cloudClient.auth.signUp({email,password,options:{emailRedirectTo:redirectTo}})
    : await cloudClient.auth.signInWithPassword({email,password});
  document.querySelector("#authSubmit").disabled=false;
  if (result.error) return setAuthError(result.error.message);
  if (result.data.session) await enterCloudApp(result.data.user);
  else setAuthError("Check your email to confirm the account, then sign in.");
};
document.querySelector("#signOutBtn").onclick=()=>cloudClient?.auth.signOut();
document.addEventListener("keydown",event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();document.querySelector("#globalSearch").focus();}
  if(event.key==="Escape"){closeJobModal();closeTaskModal();closeDeleteConfirm();}
});

function escapeHtml(value){const div=document.createElement("div");div.textContent=String(value??"");return div.innerHTML;}
function escapeAttribute(value){return escapeHtml(value).replace(/"/g,"&quot;");}

renderOverview();
updateJobCount();
initializeCloud();
