const stages = ["Assessment", "Stabilizing", "Mitigation", "Abatement", "Monitoring", "Repairs", "Mitigation Complete", "Lost Job"];
const stageColors = ["#e5a03f", "#3e7bdd", "#2c9a79", "#d56b35", "#8b98aa", "#7653c8", "#c84646", "#6f7785"];
const stageMigration = {Inspection:"Assessment", Estimate:"Assessment", Final:"Mitigation Complete", Lost:"Lost Job"};
const storageKey = "restoreflow-jobs-v2";
const todoStorageKey = "restoreflow-todos-v1";
const reminderStorageKey = "restoreflow-reminders-v1";
const serviceCallStorageKey = "restoreflow-service-calls-v1";
const legacyStorageKey = "restoreflow-jobs";
const todoRecordId = "__restoreflow_todos__";
const reminderRecordId = "__restoreflow_reminders__";
const serviceCallRecordId = "__restoreflow_service_calls__";
const equipmentKeys = ["dehumidifiers","airMovers","axials","negativeAir","hepaVacuums","extractors"];
const carryForwardEquipmentKeys = ["dehumidifiers","airMovers","axials","negativeAir"];
const unitStatuses = ["Needs access","No access","Demo needed","Under mitigation","Finished"];
const routeStatuses = ["Not started","On the way","On site","Done"];
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
let reminders = loadReminders();
let serviceCalls = loadServiceCalls();
let cloudClient = null;
let cloudUser = null;
let authMode = "signin";
let cloudReady = false;
const authRedirectTo = "https://tapia90.github.io/restoreflow-dashboard/";
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const bindClick = (selector, handler) => {
  const element = $(selector);
  if (element) element.onclick = handler;
};

function currentTimestamp() {
  return new Date().toISOString();
}

function touchJob(job) {
  job.updatedAt = currentTimestamp();
  return job;
}

function ensureTmPacketReminder(job) {
  const title = `Complete T&M packet - ${job.jobNumber} · ${job.address}`;
  const exists = reminders.some(reminder => reminder.title === title && !reminder.done);
  if (!exists) {
    reminders.push({
      id:crypto.randomUUID(),
      title,
      date:new Date().toISOString().slice(0,10),
      jobId:job.id,
      done:false,
      createdAt:currentTimestamp(),
      updatedAt:currentTimestamp()
    });
  }
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

function loadReminders() {
  return normalizeReminders(JSON.parse(localStorage.getItem(reminderStorageKey) || "[]"));
}

function loadServiceCalls() {
  return normalizeServiceCalls(JSON.parse(localStorage.getItem(serviceCallStorageKey) || "[]"));
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

function normalizeReminders(list) {
  return Array.isArray(list) ? list.map(reminder => ({
    id:reminder.id || crypto.randomUUID(),
    title:reminder.title || "",
    date:dateOnly(reminder.date || reminder.createdAt),
    jobId:reminder.jobId || "",
    done:Boolean(reminder.done),
    createdAt:reminder.createdAt || currentTimestamp(),
    updatedAt:reminder.updatedAt || reminder.createdAt || currentTimestamp()
  })).filter(reminder => reminder.title.trim()) : [];
}

function normalizeServiceCalls(list) {
  return Array.isArray(list) ? list.map(call => ({
    id:call.id || crypto.randomUUID(),
    date:dateOnly(call.date || call.createdAt),
    order:Number(call.order) || "",
    title:call.title || "",
    type:call.type || "Equipment checkup",
    notes:call.notes || "",
    status:routeStatuses.includes(call.status) ? call.status : (call.completed ? "Done" : "Not started"),
    completed:call.status === "Done" || Boolean(call.completed),
    createdAt:call.createdAt || currentTimestamp(),
    updatedAt:call.updatedAt || call.createdAt || currentTimestamp()
  })).filter(call => call.title.trim()) : [];
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
    hepaVacuums:Number(log.hepaVacuums) || 0,
    extractors:Number(log.extractors) || 0,
    notes:log.notes || "",
    pickupReminderDate:log.pickupReminderDate || "",
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
      contactName:job.contactName || job.pointOfContact || job.contact || "",
      contactPhone:job.contactPhone || job.phone || job.contactNumber || "",
      documentFolder:job.documentFolder || "",
      materialStatus:job.materialStatus || "Pending",
      abatementStatus:job.abatementStatus || (stage === "Abatement" ? "In progress" : "Not required"),
      lostReason:job.lostReason || "",
      lostDate:job.lostDate || "",
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
  localStorage.setItem(reminderStorageKey, JSON.stringify(reminders));
  localStorage.setItem(serviceCallStorageKey, JSON.stringify(serviceCalls));
  renderOverview();
  updateJobCount();
  if (cloudReady && cloudUser) await syncJobsToCloud();
}

async function syncJobsToCloud() {
  const todoUpdatedAt = todos.reduce((latest,todo) => new Date(todo.updatedAt) > new Date(latest) ? todo.updatedAt : latest, "1970-01-01T00:00:00.000Z");
  const reminderUpdatedAt = reminders.reduce((latest,reminder) => new Date(reminder.updatedAt) > new Date(latest) ? reminder.updatedAt : latest, "1970-01-01T00:00:00.000Z");
  const serviceCallUpdatedAt = serviceCalls.reduce((latest,call) => new Date(call.updatedAt) > new Date(latest) ? call.updatedAt : latest, "1970-01-01T00:00:00.000Z");
  const records = [
    ...jobs.map(job => ({id:job.id,user_id:cloudUser.id,data:job,updated_at:job.updatedAt || currentTimestamp()})),
    {id:todoRecordId,user_id:cloudUser.id,data:{kind:"todos",items:todos},updated_at:todoUpdatedAt},
    {id:reminderRecordId,user_id:cloudUser.id,data:{kind:"reminders",items:reminders},updated_at:reminderUpdatedAt},
    {id:serviceCallRecordId,user_id:cloudUser.id,data:{kind:"serviceCalls",items:serviceCalls},updated_at:serviceCallUpdatedAt}
  ];
  if (records.length) {
    const {error} = await cloudClient.from("jobs").upsert(records,{onConflict:"user_id,id"});
    if (error) return showToast("Cloud sync failed",error.message);
  }
  const {data:remote,error:readError} = await cloudClient.from("jobs").select("id");
  if (readError) return showToast("Cloud sync failed",readError.message);
  const localIds = new Set([...jobs.map(job=>job.id), todoRecordId, reminderRecordId, serviceCallRecordId]);
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

function mergeReminders(localReminders, remoteReminders) {
  const merged = new Map();
  [...localReminders, ...remoteReminders].forEach(reminder => {
    const existing = merged.get(reminder.id);
    if (!existing || new Date(reminder.updatedAt) >= new Date(existing.updatedAt)) merged.set(reminder.id, reminder);
  });
  return [...merged.values()].sort((a,b) => compareDates(a.date,b.date) || new Date(b.updatedAt) - new Date(a.updatedAt));
}

function mergeServiceCalls(localCalls, remoteCalls) {
  const merged = new Map();
  [...localCalls, ...remoteCalls].forEach(call => {
    const existing = merged.get(call.id);
    if (!existing || new Date(call.updatedAt) >= new Date(existing.updatedAt)) merged.set(call.id, call);
  });
  return [...merged.values()].sort((a,b) => compareDates(b.date,a.date) || (Number(a.order)||999) - (Number(b.order)||999));
}

async function loadCloudJobs() {
  const {data,error} = await cloudClient.from("jobs").select("data").order("updated_at",{ascending:false});
  if (error) throw error;
  if (data.length) {
    const remoteTodos = data.find(row => row.data?.kind === "todos")?.data?.items || [];
    const remoteReminders = data.find(row => row.data?.kind === "reminders")?.data?.items || [];
    const remoteServiceCalls = data.find(row => row.data?.kind === "serviceCalls")?.data?.items || [];
    const remoteJobs = data.map(row=>row.data).filter(item => item && item.kind !== "todos" && item.kind !== "reminders" && item.kind !== "serviceCalls");
    jobs = mergeJobs(normalizeJobs(jobs), normalizeJobs(remoteJobs));
    todos = mergeTodos(normalizeTodos(todos), normalizeTodos(remoteTodos));
    reminders = mergeReminders(normalizeReminders(reminders), normalizeReminders(remoteReminders));
    serviceCalls = mergeServiceCalls(normalizeServiceCalls(serviceCalls), normalizeServiceCalls(remoteServiceCalls));
    localStorage.setItem(storageKey,JSON.stringify(jobs));
    localStorage.setItem(todoStorageKey,JSON.stringify(todos));
    localStorage.setItem(reminderStorageKey,JSON.stringify(reminders));
    localStorage.setItem(serviceCallStorageKey,JSON.stringify(serviceCalls));
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
const carryForwardEquipmentTotal = log => carryForwardEquipmentKeys.reduce((sum,key) => sum + (Number(log?.[key]) || 0),0);
const equipmentLabels = {dehumidifiers:"Dehus", airMovers:"Air movers", axials:"Axials", negativeAir:"Negative air", hepaVacuums:"HEPA vacuums", extractors:"Extractors"};
const latestPickupReminder = job => sortedEquipmentLogs(job).find(log => !log.carriedForward && carryForwardEquipmentTotal(log) > 0 && log.pickupReminderDate)?.pickupReminderDate || "";
const pickupReminderStatus = date => {
  const today = new Date().toISOString().slice(0,10);
  if (compareDates(date,today) < 0) return "Overdue";
  if (compareDates(date,today) === 0) return "Due today";
  return "Upcoming";
};
const equipmentReminderJobs = () => sortedJobs(jobs).map(job => ({job,latest:latestEquipmentLog(job),pickupDate:latestPickupReminder(job)})).filter(item => item.pickupDate && carryForwardEquipmentTotal(item.latest) > 0);
const equipmentOnSiteJobs = () => sortedJobs(jobs).map(job => ({job,latest:latestEquipmentLog(job)})).filter(item => carryForwardEquipmentTotal(item.latest) > 0);
const sortedReminders = () => [...reminders].sort((a,b) => compareDates(a.date,b.date) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
const reminderStatus = reminder => reminder.done ? "Done" : pickupReminderStatus(reminder.date);
const tmPacketReminders = () => sortedReminders().filter(reminder => !reminder.done && reminder.title.startsWith("Complete T&M packet -"));
const serviceCallsForDate = date => serviceCalls.filter(call => call.date === date).sort((a,b) => (Number(a.order)||999) - (Number(b.order)||999) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
const serviceCallStatus = call => routeStatuses.includes(call.status) ? call.status : (call.completed ? "Done" : "Not started");
const sortedJobs = list => [...list].sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
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
    hepaVacuums:0,
    extractors:0,
    notes:"Carried forward from last saved equipment count.",
    carriedForward:true,
    createdAt:currentTimestamp()
  };
}

function parseEquipmentFromNote(text, job) {
  const lower = text.toLowerCase();
  const latest = latestEquipmentLog(job) || {};
  const counts = {
    dehumidifiers:Number(latest.dehumidifiers) || 0,
    airMovers:Number(latest.airMovers) || 0,
    axials:Number(latest.axials) || 0,
    negativeAir:Number(latest.negativeAir) || 0,
    hepaVacuums:Number(latest.hepaVacuums) || 0,
    extractors:Number(latest.extractors) || 0
  };
  const found = new Set();
  if (/(all\s+equipment|equipment)\s+(was\s+)?(removed|picked\s+up)|(?:removed|picked\s+up)\s+all\s+equipment/.test(lower)) {
    equipmentKeys.forEach(key => {
      counts[key] = 0;
      found.add(key);
    });
  }
  const patterns = [
    ["dehumidifiers", /(\d+)\s*(dehus?|dehumidifiers?|dh\b)/gi],
    ["airMovers", /(\d+)\s*(air\s*movers?|airmovers?|blowers?|fans?|ams?\b)/gi],
    ["axials", /(\d+)\s*(axials?|axial\s*fans?|af\b)/gi],
    ["negativeAir", /(\d+)\s*(negative\s*airs?|air\s*scrubbers?|scrubbers?|na\b)/gi],
    ["hepaVacuums", /(\d+)\s*(hepa\s*vacs?|hepa\s*vacuums?|vacuums?|vacs?\b)/gi],
    ["extractors", /(\d+)\s*(extractors?|extraction\s*machines?|water\s*extractors?)/gi]
  ];
  patterns.forEach(([key, pattern]) => {
    [...text.matchAll(pattern)].forEach(match => {
      const amount = Number(match[1]) || 0;
      const before = lower.slice(Math.max(0,match.index - 32), match.index);
      const isRemoval = /(remove|removed|pickup|picked\s+up|pull|pulled|take|took)\s*$/.test(before);
      counts[key] = isRemoval ? Math.max(0, counts[key] - amount) : amount;
      found.add(key);
    });
  });
  if (!found.size) return null;
  return counts;
}

function equipmentReviewText(counts) {
  return equipmentKeys.map(key => `${equipmentLabels[key]}: ${counts[key]}`).join("\n");
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

  if (latestActual && carryForwardEquipmentTotal(latestActual) > 0) {
    for (let day = addDays(latestActual.date,1); compareDates(day,today) <= 0; day = addDays(day,1)) {
      nextLogs.push(carriedEquipmentLog(job,latestActual,day));
    }
  }

  job.equipmentLogs = nextLogs.sort((a,b) => compareDates(b.date,a.date) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return job.equipmentLogs;
}

function showToast(title,message) {
  $("#toastTitle").textContent = title;
  $("#toastMessage").textContent = message;
  const toast = $("#toast");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"),2600);
}

function updateJobCount() {
  document.querySelector(".nav-count").textContent = jobs.length;
}

function jobRow(job,showMenu=false) {
  return `<tr data-job="${job.id}">
    <td><div class="job-cell"><span class="job-type-icon ${slug(job.type)}">${typeSymbol(job.type)}</span><div><strong>${escapeHtml(job.jobNumber)} · ${escapeHtml(locationLine(job))}</strong><span>${escapeHtml(job.customer)}</span>${job.contactName || job.contactPhone ? `<span class="contact-line">POC: ${escapeHtml(job.contactName || "No name")}${job.contactPhone?` · ${escapeHtml(job.contactPhone)}`:""}</span>`:""}</div></div></td>
    <td>${formatDate(job.createdAt)}</td>
    <td>${escapeHtml(job.type)}</td><td><span class="status ${slug(job.stage)}">${escapeHtml(job.stage)}</span></td>
    <td><span class="unit-table-summary">${escapeHtml(unitSummary(job))}</span></td>
    <td><div class="manager-cell"><span class="mini-avatar">${initials(job.projectDirector)}</span>${escapeHtml(job.projectDirector || "Not assigned")}</div></td>
    ${showMenu?`<td class="kebab">•••</td>`:""}
  </tr>`;
}

function renderOverview() {
  const openTodos = todos.filter(todo => !todo.done).length;
  const reminders = equipmentReminderJobs();
  const calendarOpen = remindersListOpenCount();
  const dueReminders = reminders.filter(item => pickupReminderStatus(item.pickupDate) !== "Upcoming").length;
  document.querySelector(".attention-banner strong").textContent = `${openTodos} to-dos to complete`;
  document.querySelector(".attention-banner span").textContent = calendarOpen ? `${calendarOpen} calendar reminder${calendarOpen===1?"":"s"} open.` : (dueReminders ? `${dueReminders} equipment pickup reminder${dueReminders===1?"":"s"} due now.` : (openTodos ? "Billing or office follow-ups need your attention." : "No urgent follow-ups are currently open."));

  const counts = stages.map(stage => jobs.filter(job => job.stage === stage).length);
  document.querySelector("#pipelineChart").innerHTML = stages.map((stage,i) =>
    `<div class="chart-row"><span>${stage}</span><div class="chart-track"><div class="chart-bar" style="width:${Math.max(counts[i]*28,7)}%;background:${stageColors[i]}"></div></div><strong>${counts[i]}</strong></div>`
  ).join("");

  renderCalendarReminders();
  renderServiceCalls();
  renderTmPacketReminders();
  renderTodos();
  renderEquipmentReminders(reminders);
  renderEquipmentOnSite();
  document.querySelector("#activeJobsTable").innerHTML = sortedJobs(jobs).slice(0,8).map(job => jobRow(job,true)).join("") || `<tr><td colspan="7" class="empty-state">No active jobs yet. Add your first job when you are ready.</td></tr>`;
  bindJobRows();
}

function renderPipeline() {
  document.querySelector("#kanbanBoard").innerHTML = stages.map((stage,i) => {
    const stageJobs = sortedJobs(jobs).filter(job => job.stage === stage);
    return `<section class="kanban-column"><div class="kanban-header"><strong><span style="color:${stageColors[i]}">●</span> ${stage}</strong><span>${stageJobs.length}</span></div>
      ${stageJobs.map(job => `<article class="job-card" data-job="${job.id}">
        <div class="job-card-top"><span class="status ${slug(job.type)}">${job.type}</span><span class="priority-label ${slug(job.priority)}">${job.priority}</span></div>
        <h4>${escapeHtml(job.jobNumber)}</h4><p>${escapeHtml(locationLine(job))}<br>${escapeHtml(job.customer)}${job.contactName || job.contactPhone ? `<br>POC: ${escapeHtml(job.contactName || "No name")}${job.contactPhone?` · ${escapeHtml(job.contactPhone)}`:""}`:""}</p>
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
  const filtered = sortedJobs(jobs).filter(job => (!query || `${job.jobNumber} ${job.customer} ${job.address} ${job.unitSuite} ${(job.units || []).map(unit => unit.name).join(" ")} ${job.contactName} ${job.contactPhone} ${job.projectDirector}`.toLowerCase().includes(query)) && (!stage || job.stage===stage) && (!type || job.type===type));
  document.querySelector("#allJobsTable").innerHTML = filtered.map(job => jobRow(job)).join("") || `<tr><td colspan="6" class="empty-state">No matching jobs found.</td></tr>`;
  bindJobRows();
}

function renderDetail(id, options = {}) {
  const keepPosition = Boolean(options.keepPosition);
  const currentPosition = window.scrollY;
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
            <div class="info-item"><span>Point of contact</span><strong>${escapeHtml(job.contactName || "Not added")}</strong></div><div class="info-item"><span>Contact phone</span><strong>${escapeHtml(job.contactPhone || "Not added")}</strong></div>
            <div class="info-item"><span>Units / suites</span><strong>${escapeHtml(unitSummary(job))}</strong></div><div class="info-item"><span>Project director</span><strong>${escapeHtml(job.projectDirector || "Not assigned")}</strong></div><div class="info-item"><span>Priority</span><strong>${escapeHtml(job.priority)}</strong></div>
            <div class="info-item"><span>Documents</span>${job.documentFolder?`<a href="${escapeAttribute(job.documentFolder)}" target="_blank" rel="noopener">Open document folder</a>`:`<strong>Not added</strong>`}</div>
            ${job.stage==="Lost Job"?`<div class="info-item"><span>Lost date</span><strong>${formatDate(job.lostDate)}</strong></div><div class="info-item"><span>Lost reason</span><strong>${escapeHtml(job.lostReason || "Not added")}</strong></div>`:""}
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
          <div class="panel-header"><div><h3>Lost job / no work</h3><p>Use this when the assessment happened but the job did not move forward</p></div></div>
          <form class="lost-job-form" id="lostJobForm">
            <label>Status<select name="lostStatus"><option value="">Still active</option><option value="Lost Job" ${job.stage==="Lost Job"?"selected":""}>Lost job / no work</option></select></label>
            <label>Date<input name="lostDate" type="date" value="${job.lostDate || ""}"></label>
            <label class="full">Reason<input name="lostReason" placeholder="Management declined, client canceled, no work approved..." value="${escapeAttribute(job.lostReason || "")}"></label>
            <button class="btn secondary full">Save lost job status</button>
          </form>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h3>Equipment tracker</h3><p>Daily count of equipment left on site. HEPA vacuums and extractors are same-day tools and do not carry forward.</p></div></div>
          ${equipmentSummary(job)}
          <form class="equipment-form" id="equipmentForm">
            <label>Date<input name="date" type="date" required value="${new Date().toISOString().slice(0,10)}"></label>
            <label>Technician<input name="technician" placeholder="Who counted equipment?"></label>
            <label>Pickup reminder<input name="pickupReminderDate" type="date" value="${latestPickupReminder(job)}"></label>
            <label>Dehumidifiers<input name="dehumidifiers" type="number" min="0" value="${Number(latestEquipment.dehumidifiers)||0}"></label>
            <label>Air movers<input name="airMovers" type="number" min="0" value="${Number(latestEquipment.airMovers)||0}"></label>
            <label>Axials<input name="axials" type="number" min="0" value="${Number(latestEquipment.axials)||0}"></label>
            <label>Negative air<input name="negativeAir" type="number" min="0" value="${Number(latestEquipment.negativeAir)||0}"></label>
            <label>HEPA vacuums<input name="hepaVacuums" type="number" min="0" value="${Number(latestEquipment.hepaVacuums)||0}"></label>
            <label>Extractors<input name="extractors" type="number" min="0" value="${Number(latestEquipment.extractors)||0}"></label>
            <label class="full">Notes<input name="notes" placeholder="Added/removed equipment, missing unit, picked up, etc."></label>
            <button class="btn primary full">Save daily equipment count</button>
          </form>
          <button class="btn danger-outline full-btn equipment-stop-btn" id="stopEquipmentBtn">Stop equipment charging - all equipment removed</button>
          <div class="equipment-log-list">${renderEquipmentLogs(job)}</div>
        </article>
        <article class="panel equipment-report-panel" id="equipmentReportPanel">
          <div class="panel-header">
            <div><h3>Equipment count report</h3><p>Printable day-by-day equipment count from job start to latest equipment entry</p></div>
            <div class="report-actions"><button class="btn secondary small" id="emailEquipmentReportBtn">Email report</button><button class="btn secondary small" id="printEquipmentReportBtn">Print report</button></div>
          </div>
          ${renderEquipmentReport(job)}
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
  showView("jobDetail",{scrollToTop:!keepPosition});
  if (keepPosition) requestAnimationFrame(()=>window.scrollTo({top:currentPosition,behavior:"auto"}));
}

function bindDetailActions(job) {
  const refreshDetailHere = () => renderDetail(job.id,{keepPosition:true});
  const progress = document.querySelector("#detailProgress");
  progress.addEventListener("input",()=>document.querySelector("#progressValue").textContent=`${progress.value}%`);
  document.querySelector("#saveWorkflowBtn").onclick = async () => {
    job.stage = document.querySelector("#detailStage").value;
    job.progress = Number(progress.value);
    if (job.stage === "Mitigation Complete") ensureTmPacketReminder(job);
    touchJob(job);
    await saveJobs(); refreshDetailHere(); showToast("Workflow saved","Stage and progress were updated.");
  };
  document.querySelector("#saveSafetyBtn").onclick = async () => {
    job.materialStatus = document.querySelector("#materialStatus").value;
    job.abatementStatus = document.querySelector("#abatementStatus").value;
    if (job.materialStatus==="Hot" && job.abatementStatus!=="Completed") job.stage="Abatement";
    touchJob(job);
    await saveJobs(); refreshDetailHere(); showToast("Safety status saved","Testing and abatement were updated.");
  };
  document.querySelector('[data-action="edit-job"]').onclick=()=>openJobModal(job);
  document.querySelector('[data-action="delete-job"]').onclick=()=>openDeleteConfirm(job.id);
  document.querySelector("#addTaskBtn").onclick=()=>openTaskModal(job.id);
  document.querySelector("#printEquipmentReportBtn").onclick=()=>printEquipmentReport();
  document.querySelector("#emailEquipmentReportBtn").onclick=()=>emailEquipmentReport(job);
  document.querySelectorAll("[data-task]").forEach(row => {
    row.querySelector('input[type="checkbox"]').onchange = event => {
      const task = job.tasks.find(item=>item.id===row.dataset.task);
      task.done=event.target.checked; touchJob(job); saveJobs(); refreshDetailHere();
    };
    row.querySelector(".task-delete").onclick = () => {
      job.tasks=job.tasks.filter(item=>item.id!==row.dataset.task); touchJob(job); saveJobs(); refreshDetailHere(); showToast("Task removed","The checklist was updated.");
    };
  });
  document.querySelector("#noteForm").onsubmit = async event => {
    event.preventDefault();
    const text=document.querySelector("#noteText").value.trim();
    if (!text) return;
    const equipmentFromNote = parseEquipmentFromNote(text,job);
    job.notes.push({id:crypto.randomUUID(),text,createdAt:currentTimestamp()});
    if (equipmentFromNote && window.confirm(`I found equipment in this note:\n\n${equipmentReviewText(equipmentFromNote)}\n\nSave this as today's equipment count?`)) {
      const today = new Date().toISOString().slice(0,10);
      job.equipmentLogs = (job.equipmentLogs || []).filter(log => log.date !== today);
      job.equipmentLogs.unshift({
        id:crypto.randomUUID(),
        date:today,
        technician:"From job note",
        dehumidifiers:equipmentFromNote.dehumidifiers,
        airMovers:equipmentFromNote.airMovers,
        axials:equipmentFromNote.axials,
        negativeAir:equipmentFromNote.negativeAir,
        hepaVacuums:equipmentFromNote.hepaVacuums,
        extractors:equipmentFromNote.extractors,
        notes:`Saved from note: ${text}`,
        pickupReminderDate:"",
        carriedForward:false,
        createdAt:currentTimestamp()
      });
    }
    touchJob(job); await saveJobs(); refreshDetailHere(); showToast("Note added","The update was saved to this job.");
  };
  document.querySelector("#lostJobForm").onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    if (data.lostStatus === "Lost Job") {
      job.stage = "Lost Job";
      job.progress = 0;
      job.lostDate = data.lostDate || new Date().toISOString().slice(0,10);
      job.lostReason = data.lostReason || "";
      job.notes.push({id:crypto.randomUUID(),text:`Job marked lost/no work. ${job.lostReason}`.trim(),createdAt:currentTimestamp()});
    } else if (job.stage === "Lost Job") {
      job.stage = "Assessment";
      job.lostDate = "";
      job.lostReason = "";
    }
    touchJob(job); saveJobs(); refreshDetailHere(); showToast("Job status saved","The lost job status was updated.");
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
    touchJob(job); saveJobs(); refreshDetailHere(); showToast("Unit added","The unit tracker was updated.");
  };
  document.querySelectorAll("[data-unit-status]").forEach(select => {
    select.onchange = event => {
      const unit = job.units.find(item => item.id === select.dataset.unitStatus);
      if (!unit) return;
      unit.status = event.target.value;
      unit.updatedAt = currentTimestamp();
      touchJob(job); saveJobs(); refreshDetailHere(); showToast("Unit status saved",`${unit.name} is now marked ${unit.status}.`);
    };
  });
  document.querySelectorAll("[data-unit-delete]").forEach(button => {
    button.onclick = () => {
      job.units = (job.units || []).filter(unit => unit.id !== button.dataset.unitDelete);
      touchJob(job); saveJobs(); refreshDetailHere(); showToast("Unit removed","The unit tracker was updated.");
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
      hepaVacuums:Number(data.hepaVacuums) || 0,
      extractors:Number(data.extractors) || 0,
      notes:data.notes || "",
      pickupReminderDate:data.pickupReminderDate || "",
      carriedForward:false,
      createdAt:currentTimestamp()
    });
    touchJob(job); saveJobs(); refreshDetailHere(); showToast("Equipment count saved","The daily equipment count was saved.");
  };
  document.querySelector("#stopEquipmentBtn").onclick = () => {
    const today = new Date().toISOString().slice(0,10);
    job.equipmentLogs = (job.equipmentLogs || []).filter(log => log.date !== today);
    job.equipmentLogs.unshift({
      id:crypto.randomUUID(),
      date:today,
      technician:"Equipment removed",
      dehumidifiers:0,
      airMovers:0,
      axials:0,
      negativeAir:0,
      hepaVacuums:0,
      extractors:0,
      notes:"All equipment removed. Stop charging equipment after this date.",
      pickupReminderDate:"",
      carriedForward:false,
      createdAt:currentTimestamp()
    });
    touchJob(job); saveJobs(); refreshDetailHere(); showToast("Equipment charging stopped","All equipment was marked removed for today.");
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
  if (carryForwardEquipmentTotal(latest) === 0) return `<div class="equipment-summary removed">Carry-forward equipment removed on ${formatDate(latest.date)}. HEPA vacuums and extractors stay logged only on the day used.</div>`;
  return `<div class="equipment-summary">
    <div><span>Last count</span><strong>${formatDate(latest.date)}</strong></div>
    <div><span>Dehus</span><strong>${Number(latest.dehumidifiers)||0}</strong></div>
    <div><span>Air movers</span><strong>${Number(latest.airMovers)||0}</strong></div>
    <div><span>Axials</span><strong>${Number(latest.axials)||0}</strong></div>
    <div><span>Negative air</span><strong>${Number(latest.negativeAir)||0}</strong></div>
    <div><span>HEPA vacs</span><strong>${Number(latest.hepaVacuums)||0}</strong></div>
    <div><span>Extractors</span><strong>${Number(latest.extractors)||0}</strong></div>
  </div>`;
}

function renderEquipmentLogs(job) {
  const logs = sortedEquipmentLogs(job);
  return logs.length ? logs.map(log => `<div class="equipment-log-item ${log.carriedForward?"carried":""}">
    <div><strong>${formatDate(log.date)}</strong><span>${log.carriedForward?"Auto carry-forward":escapeHtml(log.technician || "Technician not listed")}</span></div>
    <div class="equipment-counts"><span>DH ${Number(log.dehumidifiers)||0}</span><span>AM ${Number(log.airMovers)||0}</span><span>AX ${Number(log.axials)||0}</span><span>NA ${Number(log.negativeAir)||0}</span><span>HV ${Number(log.hepaVacuums)||0}</span><span>EX ${Number(log.extractors)||0}</span></div>
    ${log.pickupReminderDate?`<p class="pickup-reminder-line">Pickup reminder: ${formatDate(log.pickupReminderDate)}</p>`:""}
    ${log.carriedForward?`<p>This count was carried forward automatically from the last saved field count.</p>`:(log.notes?`<p>${escapeHtml(log.notes)}</p>`:"")}
  </div>`).join("") : `<div class="empty-state">No equipment history yet.</div>`;
}

function equipmentReportRows(job) {
  return sortedEquipmentLogs(job).sort((a,b) => compareDates(a.date,b.date) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function equipmentReportTotals(rows) {
  return rows.reduce((totals,log) => {
    equipmentKeys.forEach(key => totals[key] += Number(log[key]) || 0);
    return totals;
  }, Object.fromEntries(equipmentKeys.map(key => [key,0])));
}

function renderEquipmentReport(job) {
  const rows = equipmentReportRows(job);
  if (!rows.length) return `<div class="empty-state">No equipment counts have been saved yet. Once counts are added, this report will be ready to print.</div>`;
  const totals = equipmentReportTotals(rows);
  const firstDate = rows[0].date || dateOnly(job.createdAt);
  const lastDate = rows[rows.length - 1].date || firstDate;
  return `<div class="equipment-report">
    <div class="report-heading">
      <div><span>Job number</span><strong>${escapeHtml(job.jobNumber)}</strong></div>
      <div><span>Address</span><strong>${escapeHtml(job.address)}</strong></div>
      <div><span>Report dates</span><strong>${formatDate(firstDate)} - ${formatDate(lastDate)}</strong></div>
    </div>
    <div class="report-table-wrap">
      <table class="equipment-report-table">
        <thead><tr><th>Date</th><th>DH</th><th>AM</th><th>AX</th><th>NA</th><th>HEPA</th><th>EXT</th><th>Source</th></tr></thead>
        <tbody>
          ${rows.map(log => `<tr>
            <td>${formatDate(log.date)}</td>
            <td>${Number(log.dehumidifiers)||0}</td>
            <td>${Number(log.airMovers)||0}</td>
            <td>${Number(log.axials)||0}</td>
            <td>${Number(log.negativeAir)||0}</td>
            <td>${Number(log.hepaVacuums)||0}</td>
            <td>${Number(log.extractors)||0}</td>
            <td>${log.carriedForward ? "Carry-forward" : escapeHtml(log.technician || "Field count")}</td>
          </tr>`).join("")}
        </tbody>
        <tfoot><tr><th>Totals</th><th>${totals.dehumidifiers}</th><th>${totals.airMovers}</th><th>${totals.axials}</th><th>${totals.negativeAir}</th><th>${totals.hepaVacuums}</th><th>${totals.extractors}</th><th>Equipment-days</th></tr></tfoot>
      </table>
    </div>
    <p class="report-note">DH = dehumidifiers, AM = air movers, AX = axials, NA = negative air, HEPA = HEPA vacuums, EXT = extractors. HEPA vacuums and extractors are same-day tools and do not carry forward.</p>
  </div>`;
}

function equipmentReportEmailBody(job) {
  const rows = equipmentReportRows(job);
  if (!rows.length) return "";
  const totals = equipmentReportTotals(rows);
  const firstDate = rows[0].date || dateOnly(job.createdAt);
  const lastDate = rows[rows.length - 1].date || firstDate;
  const lines = [
    "Equipment Count Report",
    "",
    `Job number: ${job.jobNumber}`,
    `Customer: ${job.customer}`,
    `Address: ${job.address}`,
    `Report dates: ${formatDate(firstDate)} - ${formatDate(lastDate)}`,
    "",
    "Date | DH | AM | AX | NA | HEPA | EXT | Source",
    ...rows.map(log => `${formatDate(log.date)} | ${Number(log.dehumidifiers)||0} | ${Number(log.airMovers)||0} | ${Number(log.axials)||0} | ${Number(log.negativeAir)||0} | ${Number(log.hepaVacuums)||0} | ${Number(log.extractors)||0} | ${log.carriedForward ? "Carry-forward" : (log.technician || "Field count")}`),
    "",
    `Totals | ${totals.dehumidifiers} | ${totals.airMovers} | ${totals.axials} | ${totals.negativeAir} | ${totals.hepaVacuums} | ${totals.extractors} | Equipment-days`,
    "",
    "Legend: DH = dehumidifiers, AM = air movers, AX = axials, NA = negative air, HEPA = HEPA vacuums, EXT = extractors.",
    "Note: HEPA vacuums and extractors are same-day tools and do not carry forward."
  ];
  return lines.join("\n");
}

function emailEquipmentReport(job) {
  const body = equipmentReportEmailBody(job);
  if (!body) return showToast("No equipment report","Add equipment counts before emailing a report.");
  const subject = `Equipment Count Report - ${job.jobNumber}`;
  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function printEquipmentReport() {
  document.body.classList.add("printing-equipment-report");
  window.print();
  setTimeout(()=>document.body.classList.remove("printing-equipment-report"),500);
}

function bindJobRows() {
  document.querySelectorAll("[data-job]").forEach(row=>row.onclick=()=>renderDetail(row.dataset.job));
}

function remindersListOpenCount() {
  return reminders.filter(reminder => !reminder.done).length;
}

function renderCalendarReminders() {
  const form = document.querySelector("#reminderForm");
  if (!form) return;
  const jobSelect = form.elements.jobId;
  const currentValue = jobSelect.value;
  jobSelect.innerHTML = `<option value="">No job link</option>${sortedJobs(jobs).map(job => `<option value="${escapeAttribute(job.id)}">${escapeHtml(job.jobNumber)} · ${escapeHtml(job.address)}</option>`).join("")}`;
  jobSelect.value = currentValue;
  if (!form.elements.date.value) form.elements.date.value = new Date().toISOString().slice(0,10);
  document.querySelector("#calendarReminderCount").textContent = `${remindersListOpenCount()} open`;
  const visibleReminders = sortedReminders().filter(reminder => !reminder.done || compareDates(reminder.date,new Date().toISOString().slice(0,10)) >= 0).slice(0,8);
  document.querySelector("#calendarReminderList").innerHTML = visibleReminders.length ? visibleReminders.map(reminder => {
    const job = jobs.find(item => item.id === reminder.jobId);
    const status = reminderStatus(reminder);
    return `<div class="calendar-reminder-item ${slug(status)}" data-reminder="${reminder.id}">
      <input type="checkbox" ${reminder.done?"checked":""} aria-label="Complete ${escapeHtml(reminder.title)}">
      <button type="button" class="calendar-reminder-main ${job?"has-job":""}" ${job?`data-job="${escapeAttribute(job.id)}"`:""}>
        <strong>${escapeHtml(reminder.title)}</strong>
        <span>${formatDate(reminder.date)}${job?` · ${escapeHtml(job.jobNumber)} · ${escapeHtml(job.address)}`:""}</span>
      </button>
      <span class="reminder-status">${status}</span>
      <button class="todo-delete" aria-label="Delete reminder">×</button>
    </div>`;
  }).join("") : `<div class="empty-state">No calendar reminders yet. Add return visits, pickups, calls, or no-access follow-ups here.</div>`;
  form.onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.title.trim()) return;
    reminders.push({id:crypto.randomUUID(),title:data.title.trim(),date:data.date,jobId:data.jobId || "",done:false,createdAt:currentTimestamp(),updatedAt:currentTimestamp()});
    form.reset();
    saveJobs(); showToast("Reminder added","Your calendar reminder was saved.");
  };
  document.querySelectorAll("[data-reminder]").forEach(row => {
    const reminder = reminders.find(item => item.id === row.dataset.reminder);
    row.querySelector('input[type="checkbox"]').onchange = event => {
      reminder.done = event.target.checked;
      reminder.updatedAt = currentTimestamp();
      saveJobs();
    };
    row.querySelector(".todo-delete").onclick = () => {
      reminders = reminders.filter(item => item.id !== row.dataset.reminder);
      saveJobs(); showToast("Reminder removed","Your calendar reminder list was updated.");
    };
  });
  document.querySelectorAll(".calendar-reminder-main[data-job]").forEach(button => {
    button.onclick = () => renderDetail(button.dataset.job);
  });
}

function renderServiceCalls() {
  const form = document.querySelector("#serviceCallForm");
  if (!form) return;
  if (!form.elements.date.value) form.elements.date.value = new Date().toISOString().slice(0,10);
  const activeDate = form.elements.date.value;
  const calls = serviceCallsForDate(activeDate);
  const remaining = calls.filter(call => serviceCallStatus(call) !== "Done").length;
  document.querySelector("#serviceCallCount").textContent = `${remaining}/${calls.length} left`;
  document.querySelector("#serviceCallList").innerHTML = calls.length ? calls.map(call => `
    <div class="service-call-item route-stop ${slug(serviceCallStatus(call))}" data-service-call="${call.id}">
      <div class="service-call-order">${escapeHtml(call.order || "•")}</div>
      <div class="service-call-main">
        <strong>${escapeHtml(call.title)}</strong>
        <span>${escapeHtml(call.type)}${call.notes?` · ${escapeHtml(call.notes)}`:""}</span>
      </div>
      <div class="route-status-wrap">
        <span class="route-status ${slug(serviceCallStatus(call))}">${escapeHtml(serviceCallStatus(call))}</span>
        <div class="route-status-buttons">
          <button type="button" class="btn secondary small" data-route-status="On the way">On way</button>
          <button type="button" class="btn secondary small" data-route-status="On site">On site</button>
          <button type="button" class="btn secondary small" data-route-status="Done">Done</button>
        </div>
      </div>
      <div class="route-move-buttons">
        <button type="button" class="btn secondary small" data-route-move="-1" aria-label="Move route stop up">↑</button>
        <button type="button" class="btn secondary small" data-route-move="1" aria-label="Move route stop down">↓</button>
      </div>
      <button class="todo-delete" aria-label="Delete service call">×</button>
    </div>
  `).join("") : `<div class="empty-state">No route stops logged for this date. Add your stops in the order you plan to run them.</div>`;
  form.onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.title.trim()) return;
    serviceCalls.push({
      id:crypto.randomUUID(),
      date:data.date,
      order:Number(data.order) || "",
      title:data.title.trim(),
      type:data.type || "Equipment checkup",
      notes:data.notes || "",
      status:"Not started",
      completed:false,
      createdAt:currentTimestamp(),
      updatedAt:currentTimestamp()
    });
    form.reset();
    form.elements.date.value = data.date;
    saveJobs(); showToast("Checkup added","Your daily route stop was saved.");
  };
  form.elements.date.onchange = renderServiceCalls;
  document.querySelectorAll("[data-service-call]").forEach(row => {
    const call = serviceCalls.find(item => item.id === row.dataset.serviceCall);
    row.querySelectorAll("[data-route-status]").forEach(button => {
      button.onclick = () => {
        call.status = button.dataset.routeStatus;
        call.completed = call.status === "Done";
        call.updatedAt = currentTimestamp();
        saveJobs(); showToast("Route stop updated",`${call.title} is marked ${call.status}.`);
      };
    });
    row.querySelectorAll("[data-route-move]").forEach(button => {
      button.onclick = () => {
        moveServiceCall(call, Number(button.dataset.routeMove));
      };
    });
    row.querySelector(".todo-delete").onclick = () => {
      serviceCalls = serviceCalls.filter(item => item.id !== row.dataset.serviceCall);
      saveJobs(); showToast("Route stop removed","Your daily route list was updated.");
    };
  });
}

function moveServiceCall(call, direction) {
  const calls = serviceCallsForDate(call.date);
  const index = calls.findIndex(item => item.id === call.id);
  const swap = calls[index + direction];
  if (!swap) return;
  const fallbackOrder = index + 1;
  const swapFallbackOrder = index + direction + 1;
  const nextOrder = Number(swap.order) || swapFallbackOrder;
  swap.order = Number(call.order) || fallbackOrder;
  call.order = nextOrder;
  call.updatedAt = currentTimestamp();
  swap.updatedAt = currentTimestamp();
  saveJobs(); showToast("Route order updated","Your stop order was adjusted.");
}

function renderTmPacketReminders() {
  if (!document.querySelector("#tmPacketList")) return;
  const items = tmPacketReminders();
  document.querySelector("#tmPacketCount").textContent = `${items.length} open`;
  document.querySelector("#tmPacketList").innerHTML = items.length ? items.map(reminder => {
    const job = jobs.find(item => item.id === reminder.jobId);
    return `<div class="tm-packet-item" data-reminder="${reminder.id}">
      <input type="checkbox" aria-label="Complete ${escapeHtml(reminder.title)}">
      <button type="button" class="tm-packet-main ${job?"has-job":""}" ${job?`data-job="${escapeAttribute(job.id)}"`:""}>
        <strong>${escapeHtml(reminder.title.replace("Complete T&M packet - ",""))}</strong>
        <span>Due ${formatDate(reminder.date)}${job?` · ${escapeHtml(job.stage)}`:""}</span>
      </button>
      <span class="reminder-status ${slug(pickupReminderStatus(reminder.date))}">${pickupReminderStatus(reminder.date)}</span>
    </div>`;
  }).join("") : `<div class="empty-state">No T&M packets waiting right now. Completed mitigation jobs will show here automatically.</div>`;
  document.querySelectorAll("#tmPacketList [data-reminder]").forEach(row => {
    const reminder = reminders.find(item => item.id === row.dataset.reminder);
    row.querySelector('input[type="checkbox"]').onchange = event => {
      reminder.done = event.target.checked;
      reminder.updatedAt = currentTimestamp();
      saveJobs(); showToast("T&M packet cleared","The packet follow-up was marked complete.");
    };
  });
  document.querySelectorAll(".tm-packet-main[data-job]").forEach(button => {
    button.onclick = () => renderDetail(button.dataset.job);
  });
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

function renderEquipmentReminders(reminders = equipmentReminderJobs()) {
  if (!document.querySelector("#equipmentReminderList")) return;
  const openCount = reminders.length;
  document.querySelector("#equipmentReminderCount").textContent = `${openCount} open`;
  document.querySelector("#equipmentReminderList").innerHTML = openCount ? reminders.map(({job,latest,pickupDate}) => {
    const status = pickupReminderStatus(pickupDate);
    return `<button class="equipment-reminder-item ${slug(status)}" data-job="${job.id}">
      <div><strong>${escapeHtml(job.jobNumber)} · ${escapeHtml(job.address)}</strong><span>${carryForwardEquipmentTotal(latest)} carry-forward item${carryForwardEquipmentTotal(latest)===1?"":"s"} on site</span></div>
      <div><span class="reminder-status">${status}</span><strong>${formatDate(pickupDate)}</strong></div>
    </button>`;
  }).join("") : `<div class="empty-state">No equipment pickup reminders right now.</div>`;
}

function renderEquipmentOnSite(items = equipmentOnSiteJobs()) {
  if (!document.querySelector("#equipmentOnSiteList")) return;
  document.querySelector("#equipmentOnSiteCount").textContent = `${items.length} job${items.length===1?"":"s"}`;
  document.querySelector("#equipmentOnSiteList").innerHTML = items.length ? items.map(({job,latest}) => `
    <button class="equipment-site-item" data-job="${job.id}">
      <div>
        <strong>${escapeHtml(job.jobNumber)} · ${escapeHtml(job.address)}</strong>
        <span>${carryForwardEquipmentTotal(latest)} item${carryForwardEquipmentTotal(latest)===1?"":"s"} currently on site</span>
      </div>
      <div class="equipment-counts equipment-site-counts">
        <span>DH ${Number(latest.dehumidifiers)||0}</span>
        <span>AM ${Number(latest.airMovers)||0}</span>
        <span>AX ${Number(latest.axials)||0}</span>
        <span>NA ${Number(latest.negativeAir)||0}</span>
      </div>
    </button>
  `).join("") : `<div class="empty-state">No jobs currently show drying equipment on site.</div>`;
  document.querySelectorAll("#equipmentOnSiteList [data-job]").forEach(button => {
    button.onclick = () => renderDetail(button.dataset.job);
  });
}

function showView(name, options = {}) {
  const scrollToTop = options.scrollToTop !== false;
  document.querySelectorAll(".view").forEach(view=>view.classList.remove("active"));
  const known=["overview","pipeline","jobs","jobDetail"];
  const target=known.includes(name)?document.querySelector(`#${name}View`):document.querySelector("#placeholderView");
  target.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(item=>item.classList.toggle("active",item.dataset.view===name));
  if (!known.includes(name)) document.querySelector("#placeholderTitle").textContent=name[0].toUpperCase()+name.slice(1);
  if (name==="pipeline") renderPipeline();
  if (name==="jobs") renderJobs();
  if (scrollToTop) window.scrollTo({top:0,behavior:"smooth"});
}

const jobModal=$("#jobModal");
const jobForm=$("#newJobForm");
function updateModalLock() {
  document.body.classList.toggle("modal-open", Boolean(jobModal?.classList.contains("open") || taskModal?.classList.contains("open")));
}
function openJobModal(job=null) {
  if (!jobModal || !jobForm) return;
  jobForm.reset();
  jobForm.elements.originalId.value=job?.id || "";
  document.querySelector("#jobModalEyebrow").textContent=job?"EDIT PROJECT":"NEW PROJECT";
  document.querySelector("#jobModalTitle").textContent=job?"Edit job":"Create a job";
  document.querySelector("#jobSubmitBtn").textContent=job?"Save changes":"Create job";
  if (job) {
    ["customer","type","address","jobNumber","unitSuite","contactName","contactPhone","projectDirector","stage","priority","insurer","documentFolder"].forEach(key=>jobForm.elements[key].value=job[key] ?? "");
  } else {
    jobForm.elements.stage.value="Assessment";
    jobForm.elements.priority.value="Normal";
  }
  jobModal.classList.add("open");
  updateModalLock();
  jobForm.elements.customer.focus();
}
function closeJobModal(){jobModal.classList.remove("open");updateModalLock();}

const taskModal=$("#taskModal");
function openTaskModal(jobId){
  const form = $("#newTaskForm");
  if (!taskModal || !form) return;
  form.reset();
  form.elements.jobId.value=jobId;
  taskModal.classList.add("open");
  updateModalLock();
}
function closeTaskModal(){if (taskModal) taskModal.classList.remove("open");updateModalLock();}

if (jobForm) jobForm.onsubmit=event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(jobForm));
  const editing=jobs.find(job=>job.id===data.originalId);
  const numbers=jobs.map(job=>Number((job.id.match(/\d+/)||[0])[0])).filter(Number.isFinite);
  const generated=`RF-${Math.max(1048,...numbers)+1}`;
  const jobNumber=data.jobNumber.trim()||generated;
  const duplicate=jobs.some(job=>job.id!==editing?.id && job.jobNumber.toLowerCase()===jobNumber.toLowerCase());
  if (duplicate) return showToast("Job number in use","Choose a unique job number.");
  if (editing) {
    Object.assign(editing,{customer:data.customer,address:data.address,unitSuite:data.unitSuite||"",contactName:data.contactName||"",contactPhone:data.contactPhone||"",type:data.type,projectDirector:data.projectDirector||"",stage:data.stage,priority:data.priority,insurer:data.insurer||"Pending",documentFolder:data.documentFolder||"",jobNumber});
    touchJob(editing);
    closeJobModal();saveJobs();renderDetail(editing.id,{keepPosition:true});showToast("Job updated","Your changes were saved.");
  } else {
    const createdAt=currentTimestamp();
    const starterUnit = data.unitSuite ? [{id:crypto.randomUUID(),name:data.unitSuite,status:"Needs access",notes:"",createdAt,updatedAt:createdAt}] : [];
    const job={id:jobNumber,jobNumber,customer:data.customer,address:data.address,unitSuite:data.unitSuite||"",contactName:data.contactName||"",contactPhone:data.contactPhone||"",units:starterUnit,type:data.type,projectDirector:data.projectDirector||"",stage:data.stage,priority:data.priority,insurer:data.insurer||"Pending",documentFolder:data.documentFolder||"",progress:5,materialStatus:"Pending",abatementStatus:"Not required",lostReason:"",lostDate:"",equipmentLogs:[],tasks:defaultTasks(),notes:[],createdAt,updatedAt:createdAt};
    jobs.push(job);closeJobModal();saveJobs();renderDetail(job.id);showToast("Job created","The project is ready to manage.");
  }
};

const newTaskForm = $("#newTaskForm");
if (newTaskForm) newTaskForm.onsubmit=event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(event.target));
  const job=jobs.find(item=>item.id===data.jobId);
  if (!job) return;
  job.tasks.push({id:crypto.randomUUID(),title:data.title,assignee:"",due:"",done:false});
  touchJob(job);
  closeTaskModal();saveJobs();renderDetail(job.id,{keepPosition:true});showToast("Task added","The checklist was updated.");
};

function openDeleteConfirm(id){pendingDeleteId=id;$("#confirmBar")?.classList.add("show");}
function closeDeleteConfirm(){pendingDeleteId=null;$("#confirmBar")?.classList.remove("show");}
bindClick("#confirmDeleteBtn", ()=>{
  jobs=jobs.filter(job=>job.id!==pendingDeleteId);closeDeleteConfirm();saveJobs();showView("jobs");showToast("Job deleted","The project was removed.");
});
bindClick("#cancelDeleteBtn", closeDeleteConfirm);

$("[data-view]");
$$("[data-view]").forEach(button=>button.onclick=()=>showView(button.dataset.view));
$$("[data-view-target]").forEach(button=>button.onclick=()=>showView(button.dataset.viewTarget));
bindClick("#newJobBtn", ()=>openJobModal());
$$(".new-job-trigger").forEach(button=>button.onclick=()=>openJobModal());
bindClick("#jobModal .modal-close", closeJobModal);
bindClick(".modal-cancel", closeJobModal);
bindClick(".task-modal-close", closeTaskModal);
bindClick(".task-modal-cancel", closeTaskModal);
if (jobModal) jobModal.onclick=event=>{if(event.target===jobModal)closeJobModal();};
if (taskModal) taskModal.onclick=event=>{if(event.target===taskModal)closeTaskModal();};

const stageFilter = $("#stageFilter");
if (stageFilter) stageFilter.innerHTML+=stages.map(stage=>`<option>${stage}</option>`).join("");
["jobSearch","stageFilter","typeFilter"].forEach(id=>{
  const element = $(`#${id}`);
  if (element) element.addEventListener(id==="jobSearch"?"input":"change",renderJobs);
});
const globalSearch = $("#globalSearch");
if (globalSearch) globalSearch.onkeydown=event=>{
  if(event.key==="Enter"){showView("jobs");const jobSearch = $("#jobSearch"); if (jobSearch) jobSearch.value=event.target.value;renderJobs();}
};
bindClick("#exportBtn", ()=>{
  const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),jobs},null,2)],{type:"application/json"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`restoreflow-backup-${new Date().toISOString().slice(0,10)}.json`;link.click();URL.revokeObjectURL(link.href);
  showToast("Backup exported","Your job data was downloaded.");
});
function cloudConfigured() {
  const config=window.RESTOREFLOW_CONFIG||{};
  return Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
}

function showAuth() { $("#authScreen")?.classList.add("visible"); }
function hideAuth() { $("#authScreen")?.classList.remove("visible"); }
function setAuthError(message="") { const authError = $("#authError"); if (authError) authError.textContent=message; }

async function initializeCloud() {
  if (!cloudConfigured()) {
    showAuth();
    $("#cloudSetupNotice")?.classList.add("visible");
    const authForm = $("#authForm");
    if (authForm) authForm.style.display="none";
    return;
  }
  cloudClient=window.supabase.createClient(window.RESTOREFLOW_CONFIG.supabaseUrl,window.RESTOREFLOW_CONFIG.supabaseAnonKey);
  const {data:{session}}=await cloudClient.auth.getSession();
  if (session?.user) await enterCloudApp(session.user);
  else showAuth();
  cloudClient.auth.onAuthStateChange(async(event,session)=>{
    if (event==="PASSWORD_RECOVERY") await completePasswordReset();
    if (event==="SIGNED_OUT"){cloudUser=null;cloudReady=false;showAuth();}
  });
}

async function completePasswordReset() {
  const newPassword = window.prompt("Enter your new RestoreFlow password. Use at least 8 characters.");
  if (!newPassword) return setAuthError("Password reset opened, but no new password was entered.");
  if (newPassword.length < 8) return setAuthError("Password must be at least 8 characters.");
  const {error}=await cloudClient.auth.updateUser({password:newPassword});
  if (error) return setAuthError(error.message);
  hideAuth();
  showToast("Password updated","Your new password was saved.");
}

async function enterCloudApp(user) {
  cloudUser=user;
  const profileName = $("#profileName");
  if (profileName) profileName.textContent=user.email.split("@")[0];
  setSyncLabel("Syncing");
  try {
    await loadCloudJobs();
    hideAuth();
  } catch(error) {
    showAuth(); setAuthError(error.message);
  }
}

bindClick("#authSwitch", ()=>{
  authMode=authMode==="signin"?"signup":"signin";
  const signup=authMode==="signup";
  const authTitle = $("#authTitle");
  const authCopy = $("#authCopy");
  const authSubmit = $("#authSubmit");
  const authSwitch = $("#authSwitch");
  const authReset = $("#authReset");
  if (authTitle) authTitle.textContent=signup?"Create owner account":"Sign in";
  if (authCopy) authCopy.textContent=signup?"Create the secure account you will use on every device.":"Use the same account on your computer, iPad, and phone.";
  if (authSubmit) authSubmit.textContent=signup?"Create account":"Sign in";
  if (authSwitch) authSwitch.textContent=signup?"Already have an account? Sign in":"Create the owner account";
  if (authReset) authReset.style.display=signup?"none":"block";
  setAuthError();
});
bindClick("#authReset", async()=>{
  setAuthError();
  const email=$("#authEmail")?.value.trim() || "";
  if (!email) return setAuthError("Enter your email first, then tap reset password.");
  const authReset = $("#authReset");
  if (authReset) authReset.disabled=true;
  const {error}=await cloudClient.auth.resetPasswordForEmail(email,{redirectTo:authRedirectTo});
  if (authReset) authReset.disabled=false;
  if (error) return setAuthError(error.message);
  setAuthError("Reset email sent. Check your inbox, then follow the link to create a new password.");
});
const authForm = $("#authForm");
if (authForm) authForm.onsubmit=async event=>{
  event.preventDefault(); setAuthError();
  const email=$("#authEmail")?.value.trim() || "";
  const password=$("#authPassword")?.value || "";
  const authSubmit = $("#authSubmit");
  if (authSubmit) authSubmit.disabled=true;
  const result=authMode==="signup"
    ? await cloudClient.auth.signUp({email,password,options:{emailRedirectTo:authRedirectTo}})
    : await cloudClient.auth.signInWithPassword({email,password});
  if (authSubmit) authSubmit.disabled=false;
  if (result.error) return setAuthError(result.error.message);
  if (result.data.session) await enterCloudApp(result.data.user);
  else setAuthError("Check your email to confirm the account, then sign in.");
};
bindClick("#signOutBtn", ()=>cloudClient?.auth.signOut());
document.addEventListener("keydown",event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();$("#globalSearch")?.focus();}
  if(event.key==="Escape"){closeJobModal();closeTaskModal();closeDeleteConfirm();}
});

function escapeHtml(value){const div=document.createElement("div");div.textContent=String(value??"");return div.innerHTML;}
function escapeAttribute(value){return escapeHtml(value).replace(/"/g,"&quot;");}

renderOverview();
updateJobCount();
initializeCloud();
