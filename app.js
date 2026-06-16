const stages = ["Inspection", "Estimate", "Abatement", "Mitigation", "Monitoring", "Repairs", "Final"];
const stageColors = ["#e5a03f", "#8b98aa", "#d56b35", "#3e7bdd", "#2c9a79", "#7653c8", "#3b9a58"];
const storageKey = "restoreflow-jobs-v2";
const legacyStorageKey = "restoreflow-jobs";
const defaultTasks = target => [
  {id:crypto.randomUUID(),title:"Initial site inspection",assignee:"Project manager",due:"",done:true},
  {id:crypto.randomUUID(),title:"Work authorization signed",assignee:"Office",due:"",done:true},
  {id:crypto.randomUUID(),title:"Material test results reviewed",assignee:"Project manager",due:"",done:false},
  {id:crypto.randomUUID(),title:"Abatement completed if required",assignee:"Abatement contractor",due:"",done:false},
  {id:crypto.randomUUID(),title:"Daily moisture documentation",assignee:"Field crew",due:"",done:false},
  {id:crypto.randomUUID(),title:"Remove drying equipment",assignee:"Field crew",due:"",done:false},
  {id:crypto.randomUUID(),title:"Customer completion certificate",assignee:"Office",due:target || "",done:false}
];
const seedJobs = [
  ["RF-1048","Sarah Mitchell","1842 Rosewood Ave, Pasadena, CA","Water","Mitigation","Roy Smith",42,"2026-06-12",28600,"State Farm","High","Pending","Not required"],
  ["RF-1047","David Chen","906 Highland Dr, Glendale, CA","Fire","Estimate","Elena Ruiz",18,"2026-06-14",47250,"Allstate","Normal","Pending","Not required"],
  ["RF-1046","Monica Reyes","3377 Valley View Rd, Burbank, CA","Mold","Abatement","Marcus Lee",63,"2026-06-10",12380,"USAA","High","Hot","In progress"],
  ["RF-1045","James Wilson","420 Oak Crest Ln, Arcadia, CA","Reconstruction","Repairs","Dana Brooks",76,"2026-06-21",68900,"Farmers","Normal","Clear","Completed"],
  ["RF-1044","Priya Patel","1158 E California Blvd, Pasadena, CA","Water","Final","Roy Smith",94,"2026-06-11",19840,"Liberty Mutual","Normal","Clear","Not required"],
  ["RF-1043","Robert Torres","521 Mission St, San Marino, CA","Water","Inspection","Elena Ruiz",8,"2026-06-18",8750,"Progressive","Normal","Pending","Not required"],
  ["RF-1042","Angela Brooks","78 Canyon View, Altadena, CA","Fire","Mitigation","Marcus Lee",35,"2026-06-16",35100,"Travelers","High","Clear","Completed"],
  ["RF-1041","Kevin Park","221 Orange Grove, Pasadena, CA","Water","Monitoring","Dana Brooks",55,"2026-06-09",15400,"State Farm","High","Clear","Not required"],
  ["RF-1040","Lisa Morgan","440 W Broadway, Glendale, CA","Reconstruction","Repairs","Roy Smith",71,"2026-06-28",31900,"Allstate","Normal","Clear","Completed"],
  ["RF-1039","Anthony White","92 Sierra Madre Blvd, Arcadia, CA","Mold","Inspection","Elena Ruiz",5,"2026-06-19",9200,"Self-pay","Normal","Pending","Pending"],
  ["RF-1038","Emily Johnson","670 N Lake Ave, Pasadena, CA","Water","Estimate","Dana Brooks",22,"2026-06-15",16400,"Farmers","Normal","Pending","Not required"],
  ["RF-1037","Michael Davis","188 Grandview Ave, Glendale, CA","Fire","Final","Marcus Lee",97,"2026-06-13",54500,"USAA","Normal","Clear","Completed"]
].map(([id,customer,address,type,stage,manager,progress,targetDate,value,insurer,priority,materialStatus,abatementStatus]) => ({
  id,jobNumber:id,customer,address,type,stage,manager,progress,targetDate,value,insurer,priority,materialStatus,abatementStatus,
  tasks:defaultTasks(targetDate),notes:[],createdAt:new Date().toISOString()
}));

let activeJobId = null;
let pendingDeleteId = null;
let jobs = loadJobs();
let cloudClient = null;
let cloudUser = null;
let authMode = "signin";
let cloudReady = false;

function loadJobs() {
  const stored = localStorage.getItem(storageKey);
  if (stored) return normalizeJobs(JSON.parse(stored));
  const legacy = localStorage.getItem(legacyStorageKey);
  if (legacy) return normalizeJobs(JSON.parse(legacy));
  return seedJobs;
}

function normalizeJobs(list) {
  return list.map(job => {
    const targetDate = job.targetDate || parseLegacyDate(job.target);
    const stage = stages.includes(job.stage) ? job.stage : "Final";
    return {
      ...job, id:job.id || job.jobNumber, jobNumber:job.jobNumber || job.id, stage,
      targetDate, insurer:job.insurer || "Pending", priority:job.priority || "Normal",
      materialStatus:job.materialStatus || "Pending",
      abatementStatus:job.abatementStatus || (stage === "Abatement" ? "In progress" : "Not required"),
      tasks:Array.isArray(job.tasks) ? job.tasks : defaultTasks(targetDate),
      notes:Array.isArray(job.notes) ? job.notes : []
    };
  });
}

function parseLegacyDate(value) {
  if (!value) return "";
  const parsed = new Date(`${value}, 2026 12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0,10);
}

async function saveJobs() {
  localStorage.setItem(storageKey, JSON.stringify(jobs));
  renderOverview();
  updateJobCount();
  if (cloudReady && cloudUser) await syncJobsToCloud();
}

async function syncJobsToCloud() {
  const records = jobs.map(job => ({id:job.id,user_id:cloudUser.id,data:job,updated_at:new Date().toISOString()}));
  if (records.length) {
    const {error} = await cloudClient.from("jobs").upsert(records,{onConflict:"user_id,id"});
    if (error) return showToast("Cloud sync failed",error.message);
  }
  const {data:remote,error:readError} = await cloudClient.from("jobs").select("id");
  if (readError) return showToast("Cloud sync failed",readError.message);
  const localIds = new Set(jobs.map(job=>job.id));
  const stale = remote.filter(row=>!localIds.has(row.id)).map(row=>row.id);
  if (stale.length) await cloudClient.from("jobs").delete().in("id",stale);
  setSyncLabel("Saved to cloud");
}

function setSyncLabel(text) {
  const email = document.querySelector("#profileEmail");
  if (email && cloudUser) email.textContent = `${cloudUser.email} · ${text}`;
}

async function loadCloudJobs() {
  const {data,error} = await cloudClient.from("jobs").select("data").order("updated_at",{ascending:false});
  if (error) throw error;
  if (data.length) {
    jobs = normalizeJobs(data.map(row=>row.data));
    localStorage.setItem(storageKey,JSON.stringify(jobs));
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
const formatDate = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString("en-US",{month:"short",day:"numeric",year:new Date(value).getFullYear() !== new Date().getFullYear() ? "numeric":undefined}) : "Not set";
const isLate = job => job.targetDate && job.stage !== "Final" && new Date(`${job.targetDate}T23:59:59`) < new Date();
const completedCount = job => job.tasks.filter(task => task.done).length;

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

function jobRow(job,includeValue=false) {
  return `<tr data-job="${job.id}">
    <td><div class="job-cell"><span class="job-type-icon ${slug(job.type)}">${typeSymbol(job.type)}</span><div><strong>${escapeHtml(job.jobNumber)} · ${escapeHtml(job.customer)}</strong><span>${escapeHtml(job.address)}</span></div></div></td>
    <td>${escapeHtml(job.type)}</td><td><span class="status ${slug(job.stage)}">${escapeHtml(job.stage)}</span></td>
    <td><div class="manager-cell"><span class="mini-avatar">${initials(job.manager)}</span>${escapeHtml(job.manager)}</div></td>
    ${includeValue?`<td><strong>${money(job.value)}</strong></td>`:""}
    <td><div class="progress-cell"><div class="mini-progress"><span style="width:${job.progress}%"></span></div>${job.progress}%</div></td>
    <td class="${isLate(job)?"late-date":""}">${formatDate(job.targetDate)}${isLate(job)?" · Late":""}</td>
    ${includeValue?"":`<td class="kebab">•••</td>`}
  </tr>`;
}

function renderOverview() {
  const openTasks = jobs.reduce((sum,job) => sum + job.tasks.filter(task => !task.done).length,0);
  const lateJobs = jobs.filter(isLate);
  const activeValue = jobs.reduce((sum,job) => sum + Number(job.value || 0),0);
  const metrics = document.querySelectorAll(".metric-card");
  metrics[0].querySelector("h2").textContent = jobs.length;
  metrics[0].querySelector("small").textContent = `Across ${stages.length} project stages`;
  metrics[1].querySelector("h2").textContent = openTasks;
  metrics[1].querySelector(".trend").textContent = `${lateJobs.length} overdue`;
  metrics[2].querySelector("h2").textContent = activeValue >= 1000 ? `$${(activeValue/1000).toFixed(1)}k` : money(activeValue);
  document.querySelector(".attention-banner strong").textContent = `${lateJobs.length} jobs need attention`;
  document.querySelector(".attention-banner span").textContent = lateJobs.length ? `${lateJobs.length} project${lateJobs.length===1?" is":"s are"} past the target date.` : "No projects are currently past their target date.";

  const counts = stages.map(stage => jobs.filter(job => job.stage === stage).length);
  document.querySelector("#pipelineChart").innerHTML = stages.map((stage,i) =>
    `<div class="chart-row"><span>${stage}</span><div class="chart-track"><div class="chart-bar" style="width:${Math.max(counts[i]*28,7)}%;background:${stageColors[i]}"></div></div><strong>${counts[i]}</strong></div>`
  ).join("");

  const priorities = jobs.flatMap(job => job.tasks.filter(task => !task.done).map(task => ({job,task}))).slice(0,5);
  document.querySelector(".priorities-panel .pill").textContent = `${priorities.length} tasks`;
  document.querySelector("#priorityList").innerHTML = priorities.length ? priorities.map(({job,task}) => {
    const overdue = task.due && new Date(`${task.due}T23:59:59`) < new Date();
    return `<div class="priority-item"><span class="priority-marker ${overdue?"overdue":job.priority==="High"?"warning":""}"></span><div><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(job.jobNumber)} · ${escapeHtml(job.customer)}</p></div><time class="${overdue?"overdue":""}">${task.due?formatDate(task.due):"Open"}</time></div>`;
  }).join("") : `<div class="empty-state">No open tasks. Nice work.</div>`;
  document.querySelector("#activeJobsTable").innerHTML = jobs.slice(0,5).map(job => jobRow(job)).join("");
  bindJobRows();
}

function renderPipeline() {
  document.querySelector("#kanbanBoard").innerHTML = stages.map((stage,i) => {
    const stageJobs = jobs.filter(job => job.stage === stage);
    return `<section class="kanban-column"><div class="kanban-header"><strong><span style="color:${stageColors[i]}">●</span> ${stage}</strong><span>${stageJobs.length}</span></div>
      ${stageJobs.map(job => `<article class="job-card" data-job="${job.id}">
        <div class="job-card-top"><span class="status ${slug(job.type)}">${job.type}</span><span class="priority-label ${slug(job.priority)}">${job.priority}</span></div>
        <h4>${escapeHtml(job.customer)}</h4><p>${escapeHtml(job.jobNumber)}<br>${escapeHtml(job.address)}</p>
        <div class="job-card-footer"><span class="mini-avatar">${initials(job.manager)}</span><time class="${isLate(job)?"late-date":""}">${formatDate(job.targetDate)}</time></div>
      </article>`).join("") || `<div class="empty-column">No jobs</div>`}
    </section>`;
  }).join("");
  bindJobRows();
}

function renderJobs() {
  const query = (document.querySelector("#jobSearch")?.value || "").toLowerCase();
  const stage = document.querySelector("#stageFilter")?.value || "";
  const type = document.querySelector("#typeFilter")?.value || "";
  const filtered = jobs.filter(job => (!query || `${job.jobNumber} ${job.customer} ${job.address} ${job.manager}`.toLowerCase().includes(query)) && (!stage || job.stage===stage) && (!type || job.type===type));
  document.querySelector("#allJobsTable").innerHTML = filtered.map(job => jobRow(job,true)).join("") || `<tr><td colspan="7" class="empty-state">No matching jobs found.</td></tr>`;
  bindJobRows();
}

function renderDetail(id) {
  const job = jobs.find(item => item.id===id);
  if (!job) return showView("jobs");
  activeJobId = id;
  const done = completedCount(job);
  const open = job.tasks.length-done;
  document.querySelector("#jobDetail").innerHTML = `
    <div class="detail-heading">
      <div><p class="eyebrow">${escapeHtml(job.jobNumber)} · ${escapeHtml(job.type.toUpperCase())} LOSS</p><h1>${escapeHtml(job.customer)}</h1><p>${escapeHtml(job.address)}</p></div>
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
            <div class="info-item"><span>Job number</span><strong>${escapeHtml(job.jobNumber)}</strong></div><div class="info-item"><span>Insurance carrier</span><strong>${escapeHtml(job.insurer)}</strong></div><div class="info-item"><span>Loss type</span><strong>${escapeHtml(job.type)}</strong></div>
            <div class="info-item"><span>Project manager</span><strong>${escapeHtml(job.manager)}</strong></div><div class="info-item"><span>Target completion</span><strong class="${isLate(job)?"late-date":""}">${formatDate(job.targetDate)}</strong></div><div class="info-item"><span>Priority</span><strong>${escapeHtml(job.priority)}</strong></div>
          </div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Project checklist</h3><p>${done} of ${job.tasks.length} completed</p></div><button class="text-btn" id="addTaskBtn">＋ Add task</button></div>
          <div id="taskList">${job.tasks.map(task => `<div class="task-row ${task.done?"done":""}" data-task="${task.id}">
            <input type="checkbox" ${task.done?"checked":""} aria-label="Complete ${escapeHtml(task.title)}">
            <div><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.assignee)}</span></div>
            <time>${task.due?formatDate(task.due):"No due date"}</time><button class="task-delete" aria-label="Delete task">×</button>
          </div>`).join("") || `<div class="empty-state">No tasks yet.</div>`}</div>
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
          <div class="side-stat"><span>Contract value</span><strong>${money(job.value)}</strong></div><div class="side-stat"><span>Open tasks</span><strong>${open}</strong></div>
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
  document.querySelector("#saveWorkflowBtn").onclick = () => {
    job.stage = document.querySelector("#detailStage").value;
    job.progress = Number(progress.value);
    saveJobs(); renderDetail(job.id); showToast("Workflow saved","Stage and progress were updated.");
  };
  document.querySelector("#saveSafetyBtn").onclick = () => {
    job.materialStatus = document.querySelector("#materialStatus").value;
    job.abatementStatus = document.querySelector("#abatementStatus").value;
    if (job.materialStatus==="Hot" && job.abatementStatus!=="Completed") job.stage="Abatement";
    saveJobs(); renderDetail(job.id); showToast("Safety status saved","Testing and abatement were updated.");
  };
  document.querySelector('[data-action="edit-job"]').onclick=()=>openJobModal(job);
  document.querySelector('[data-action="delete-job"]').onclick=()=>openDeleteConfirm(job.id);
  document.querySelector("#addTaskBtn").onclick=()=>openTaskModal(job.id);
  document.querySelectorAll("[data-task]").forEach(row => {
    row.querySelector('input[type="checkbox"]').onchange = event => {
      const task = job.tasks.find(item=>item.id===row.dataset.task);
      task.done=event.target.checked; saveJobs(); renderDetail(job.id);
    };
    row.querySelector(".task-delete").onclick = () => {
      job.tasks=job.tasks.filter(item=>item.id!==row.dataset.task); saveJobs(); renderDetail(job.id); showToast("Task removed","The checklist was updated.");
    };
  });
  document.querySelector("#noteForm").onsubmit = event => {
    event.preventDefault();
    const text=document.querySelector("#noteText").value.trim();
    if (!text) return;
    job.notes.push({id:crypto.randomUUID(),text,createdAt:new Date().toISOString()});
    saveJobs(); renderDetail(job.id); showToast("Note added","The update was saved to this job.");
  };
}

function bindJobRows() {
  document.querySelectorAll("[data-job]").forEach(row=>row.onclick=()=>renderDetail(row.dataset.job));
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
function openJobModal(job=null) {
  jobForm.reset();
  jobForm.elements.originalId.value=job?.id || "";
  document.querySelector("#jobModalEyebrow").textContent=job?"EDIT PROJECT":"NEW PROJECT";
  document.querySelector("#jobModalTitle").textContent=job?"Edit job":"Create a job";
  document.querySelector("#jobSubmitBtn").textContent=job?"Save changes":"Create job";
  if (job) {
    ["customer","type","address","jobNumber","manager","stage","priority","insurer","value"].forEach(key=>jobForm.elements[key].value=job[key] ?? "");
    jobForm.elements.target.value=job.targetDate || "";
  } else {
    jobForm.elements.stage.value="Inspection";
    jobForm.elements.priority.value="Normal";
  }
  jobModal.classList.add("open");
  jobForm.elements.customer.focus();
}
function closeJobModal(){jobModal.classList.remove("open");}

const taskModal=document.querySelector("#taskModal");
function openTaskModal(jobId){document.querySelector("#newTaskForm").reset();document.querySelector('#newTaskForm [name="jobId"]').value=jobId;taskModal.classList.add("open");}
function closeTaskModal(){taskModal.classList.remove("open");}

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
    Object.assign(editing,{customer:data.customer,address:data.address,type:data.type,manager:data.manager,stage:data.stage,priority:data.priority,insurer:data.insurer||"Pending",value:Number(data.value)||0,targetDate:data.target,jobNumber});
    closeJobModal();saveJobs();renderDetail(editing.id);showToast("Job updated","Your changes were saved.");
  } else {
    const job={id:jobNumber,jobNumber,customer:data.customer,address:data.address,type:data.type,manager:data.manager,stage:data.stage,priority:data.priority,insurer:data.insurer||"Pending",value:Number(data.value)||0,targetDate:data.target,progress:5,materialStatus:"Pending",abatementStatus:"Not required",tasks:defaultTasks(data.target),notes:[],createdAt:new Date().toISOString()};
    jobs.unshift(job);closeJobModal();saveJobs();renderDetail(job.id);showToast("Job created","The project is ready to manage.");
  }
};

document.querySelector("#newTaskForm").onsubmit=event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(event.target));
  const job=jobs.find(item=>item.id===data.jobId);
  if (!job) return;
  job.tasks.push({id:crypto.randomUUID(),title:data.title,assignee:data.assignee,due:data.due,done:false});
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
  document.querySelector("#authSubmit").disabled=true;
  const result=authMode==="signup"
    ? await cloudClient.auth.signUp({email,password})
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

renderOverview();
updateJobCount();
initializeCloud();
