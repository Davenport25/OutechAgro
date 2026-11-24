'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { buildWeeklyReport, renderWeeklyPdf, weekMonday, formatHours, prettyDate, isExcludedFromDeliverables } = require('./lib/weekly-deliverables');
const { operationalCounts, clearOperationalRecords } = require('./maintenance/reset-operations');

const ROOT = __dirname;
const IS_VERCEL = Boolean(process.env.VERCEL);
const RUNTIME_ROOT = IS_VERCEL ? path.join('/tmp', 'olutech_pm_system') : ROOT;
const DATA_DIR = process.env.OLUTECH_DATA_DIR || path.join(RUNTIME_ROOT, 'storage');
const UPLOAD_DIR = process.env.OLUTECH_UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const DB_FILE = process.env.OLUTECH_DB_FILE || path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(ROOT, 'data', 'seed.json');
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const SESSION_DURATION_DAYS = Math.max(1, Number(process.env.OLUTECH_SESSION_DAYS || 30));
const SESSION_DURATION_MS = SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_DURATION_SECONDS = Math.floor(SESSION_DURATION_MS / 1000);
const TIME_ZONE = process.env.OLUTECH_TIME_ZONE || 'Africa/Lagos';
const DEFAULT_WORKDAY_START = process.env.OLUTECH_WORKDAY_START || '09:00';
const DEFAULT_WORKDAY_END = process.env.OLUTECH_WORKDAY_END || '18:00';
const DEFAULT_EXPECTED_WORKDAY_HOURS = Number(process.env.OLUTECH_EXPECTED_WORKDAY_HOURS || 9);
const MAX_TASK_FILE_BYTES = 4 * 1024 * 1024; // A single embedded file expands inside the Upstash JSON database.

const sessions = new Map();

// Durable persistence support.
// Local JSON is used on laptops. On Vercel, connect Vercel KV / Upstash Redis and set
// KV_REST_API_URL + KV_REST_API_TOKEN so data survives serverless resets and redeploys.
// The app also accepts UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN because
// some Vercel/Upstash dashboards expose credentials under those names.
const PERSISTENCE_KEY = process.env.OLUTECH_PERSISTENCE_KEY || 'olutech_pm_system_db';
let cloudHealthCache = { checkedAt: 0, ok: false, message: 'Not checked', provider: 'none' };

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return {
    url: String(url || '').replace(/\/$/, ''),
    token: String(token || ''),
    hasUrl: Boolean(url),
    hasToken: Boolean(token),
    configured: Boolean(url && token)
  };
}

function storageMode() {
  const env = kvEnv();
  if (env.configured) return 'cloud';
  if (IS_VERCEL) return 'temporary-vercel';
  return 'local';
}

function persistenceLabel() {
  const mode = storageMode();
  if (mode === 'cloud') return 'Durable cloud storage enabled';
  if (mode === 'temporary-vercel') return 'Temporary Vercel storage - data will reset';
  return 'Local JSON storage';
}

function persistenceWarningHtml() {
  if (storageMode() !== 'temporary-vercel') return '';
  return `<div class="notice danger"><b>Storage warning:</b> this deployment is running without KV_REST_API_URL/KV_REST_API_TOKEN. Data, Excel imports, uploads, and open clock-in records may reset on Vercel. Add the environment variables and redeploy.</div>`;
}

async function upstashRequest(command, body = null) {
  const env = kvEnv();
  if (!env.configured) throw new Error('Missing KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN.');
  if (typeof fetch !== 'function') throw new Error('Fetch API is unavailable in this Node runtime. Use Node.js 18 or newer.');
  const url = `${env.url}/${command}`;
  const options = { headers: { Authorization: `Bearer ${env.token}` } };
  if (body !== null) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = body;
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = { result: text }; }
  if (!response.ok) {
    const msg = payload && (payload.error || payload.message) ? (payload.error || payload.message) : text;
    throw new Error(`KV REST ${response.status}: ${msg || response.statusText}`);
  }
  if (payload && payload.error) throw new Error(payload.error);
  return payload ? payload.result : null;
}

async function readCloudDb() {
  if (!kvEnv().configured) return null;
  const result = await upstashRequest(`get/${encodeURIComponent(PERSISTENCE_KEY)}`);
  if (result === null || typeof result === 'undefined') return null;
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch (_) { return result; }
  }
  return result;
}

async function writeCloudDb(db) {
  if (!kvEnv().configured) return false;
  const body = JSON.stringify(db);
  const result = await upstashRequest(`set/${encodeURIComponent(PERSISTENCE_KEY)}`, body);
  return result === 'OK' || result === true || result === 'ok' || result !== null;
}

async function checkCloudStorage(force = false) {
  const now = Date.now();
  if (!force && cloudHealthCache.checkedAt && now - cloudHealthCache.checkedAt < 30000) return cloudHealthCache;
  const env = kvEnv();
  if (!env.configured) {
    cloudHealthCache = { checkedAt: now, ok: false, provider: storageMode(), message: IS_VERCEL ? 'Cloud storage variables are missing on Vercel.' : 'Cloud storage variables are not configured; local JSON is being used.' };
    return cloudHealthCache;
  }
  try {
    const key = `${PERSISTENCE_KEY}:health`;
    const value = { ok: true, checkedAt: new Date().toISOString() };
    await upstashRequest(`set/${encodeURIComponent(key)}`, JSON.stringify(value));
    const readBack = await upstashRequest(`get/${encodeURIComponent(key)}`);
    const ok = Boolean(readBack);
    cloudHealthCache = { checkedAt: now, ok, provider: 'Upstash/Vercel KV REST', message: ok ? 'Cloud storage read/write test passed.' : 'Cloud storage responded but read-back test failed.' };
  } catch (err) {
    cloudHealthCache = { checkedAt: now, ok: false, provider: 'Upstash/Vercel KV REST', message: err.message };
  }
  return cloudHealthCache;
}

const SPREADSHEET_SETUP_STAFF = [
  { name: 'ONAOPE', role: 'Operations Manager', isExternal: false },
  { name: 'DIPO', role: 'Sourcing Lead & Agro Commodity Expert', isExternal: false },
  { name: 'BOLA', role: 'Research & IT Support', isExternal: false },
  { name: 'CHIKA', role: 'Project Manager', isExternal: false },
  { name: 'AKIN', role: 'Executive Approver (CEO)', isExternal: false },
  { name: 'Buyer', role: 'External Dependency', isExternal: true },
  { name: 'Supplier', role: 'External Dependency', isExternal: true },
  { name: 'Transporter', role: 'External Dependency', isExternal: true },
  { name: 'Bank', role: 'External Dependency', isExternal: true },
  { name: 'Regulator / Agency', role: 'External Dependency', isExternal: true }
];

const SPREADSHEET_PROJECT_CATEGORIES = [
  "Export Project",
  "Sourcing Project",
  "NXP / Documentation",
  "Research Assignment",
  "Compliance Activity",
  "IT Project",
  "Operational Improvement",
  "Admin / Management Assignment",
  "Contract / Buyer Management",
  "Logistics / Port",
  "Export Pipeline",
  "Other"
];

const SPREADSHEET_DELAY_CATEGORIES = [
  "Internal Staff Delay",
  "Executive Approval Delay",
  "Supplier Delay",
  "Buyer Delay",
  "Transport / Truck Delay",
  "Documentation / NXP Delay",
  "Regulatory / Agency Delay",
  "Funding / Cash Delay",
  "Quality Issue",
  "Port / Freight Delay",
  "External Market Issue",
  "Procurement / Materials Delay",
  "No Update Provided"
];

const SPREADSHEET_APPROVAL_TYPES = [
  "Supplier Payment",
  "Truck / Logistics Payment",
  "NXP / Bank Instruction",
  "Contract Signing",
  "Buyer Update / Shipment Commitment",
  "Emergency Field Spend",
  "Contract Approval",
  "Funding Approval",
  "Document Signing",
  "Other Executive Decision"
];

const SPREADSHEET_RISK_TYPES = [
  "Risk",
  "Issue",
  "Assumption",
  "Constraint"
];

const SPREADSHEET_RISK_CATEGORIES = [
  "Supply",
  "Quality",
  "Cost / Cash",
  "Logistics",
  "Documentation",
  "Regulatory",
  "Buyer / Stakeholder",
  "Executive Approval",
  "Port / Freight",
  "Approval / Decision",
  "Cash Exposure",
  "No Update / Evidence Gap"
];

const SPREADSHEET_IMPACT_AREAS = [
  "Timeline",
  "Buyer Trust",
  "Cash Exposure",
  "Quality",
  "Compliance",
  "Cost",
  "Funding",
  "Documentation",
  "Regulatory",
  "Port / Freight",
  "Supplier",
  "Transport"
];

const SPREADSHEET_PROJECT_PHASES = [
  "Initiation",
  "Planning",
  "Execution",
  "Monitoring & Control",
  "Closing",
  "Ready Shelf / Pre-Contract",
  "Sourcing",
  "Quality Check",
  "Procurement / Aggregation",
  "Logistics / Movement",
  "Port / Shipment",
  "Buyer Docs / Payment"
];

const SPREADSHEET_PROJECT_HEALTH_VALUES = [
  "Green",
  "Amber",
  "Red"
];

const SPREADSHEET_PROJECT_HEALTH_STYLES = {
  "Green": {
    "background": "#DCFCE7",
    "color": "#166534",
    "border": "#86EFAC"
  },
  "Amber": {
    "background": "#FEF3C7",
    "color": "#F59E0B",
    "border": "#FDE68A"
  },
  "Red": {
    "background": "#FEE2E2",
    "color": "#DC2626",
    "border": "#FCA5A5"
  }
};

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'file';
}

const OFFICIAL_EMAIL_DOMAIN = 'olutechagro.com';
const STAFF_NAME_ALIASES = {
  bolade: 'BOLA',
  bola: 'BOLA',
  chikanma: 'CHIKA',
  chika: 'CHIKA'
};
const REMOVED_INTERNAL_STAFF = new Set(['waheed', 'amana', 'amanna']);
const OFFICIAL_EMAIL_ALIASES = {
  bolade: 'bola',
  bola: 'bola',
  chikanma: 'chika',
  chika: 'chika',
  admin: 'admin'
};

function canonicalStaffName(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (REMOVED_INTERNAL_STAFF.has(key)) return '';
  return STAFF_NAME_ALIASES[key] || raw;
}

function staffIdentityEquals(a, b) {
  return samePerson(canonicalStaffName(a), canonicalStaffName(b));
}

function staffDeleteKey(value) {
  const canonical = canonicalStaffName(value) || String(value || '').trim();
  return String(canonical || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function setupDeletedStaffKeys(db) {
  const keys = new Set([...REMOVED_INTERNAL_STAFF]);
  const stored = db && db.setup && Array.isArray(db.setup.deletedStaffKeys) ? db.setup.deletedStaffKeys : [];
  for (const value of stored) {
    const key = staffDeleteKey(value);
    if (key) keys.add(key);
  }
  return keys;
}

function markSetupStaffDeleted(db, name) {
  if (!db.setup) db.setup = {};
  if (!Array.isArray(db.setup.deletedStaffKeys)) db.setup.deletedStaffKeys = [];
  const key = staffDeleteKey(name);
  if (!key) return false;
  if (!db.setup.deletedStaffKeys.map(String).includes(key)) db.setup.deletedStaffKeys.push(key);
  if (Array.isArray(db.setup.staff)) {
    db.setup.staff = db.setup.staff.filter(person => person && staffDeleteKey(person.name) !== key);
  }
  return true;
}

function unmarkSetupStaffDeleted(db, name) {
  if (!db.setup || !Array.isArray(db.setup.deletedStaffKeys)) return false;
  const key = staffDeleteKey(name);
  if (!key) return false;
  const before = db.setup.deletedStaffKeys.length;
  db.setup.deletedStaffKeys = db.setup.deletedStaffKeys.filter(value => staffDeleteKey(value) !== key);
  return before !== db.setup.deletedStaffKeys.length;
}

function normalizeLoginEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  return `${slug(raw).replace(/-/g, '')}@${OFFICIAL_EMAIL_DOMAIN}`;
}

function officialEmailForName(name, fallback = '') {
  const raw = String(name || fallback || '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'admin' || lower.includes('system administrator') || lower.includes('system admin')) return `admin@${OFFICIAL_EMAIL_DOMAIN}`;
  const key = slug(raw).replace(/-/g, '') || slug(fallback).replace(/-/g, '');
  const localPart = OFFICIAL_EMAIL_ALIASES[key] || key || 'user';
  return `${localPart}@${OFFICIAL_EMAIL_DOMAIN}`;
}

function legacyUsernameForName(name) {
  return slug(name).replace(/-/g, '').toLowerCase();
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'uploaded-file'));
  return base.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'uploaded-file';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
}

function inferClearance(name, role) {
  const text = `${name || ''} ${role || ''}`.toLowerCase();
  if (text.includes('ceo') || text.includes('executive approver')) return 4;
  if (text.includes('operations manager') || text.includes('project manager')) return 3;
  if (text.includes('export specialist') || text.includes('sourcing') || text.includes('research') || text.includes('it support')) return 2;
  return 1;
}

function clearanceName(level) {
  return {
    1: 'Level 1 - General Staff',
    2: 'Level 2 - Operations Team',
    3: 'Level 3 - Management',
    4: 'Level 4 - Executive / Senior Admin',
    5: 'Level 5 - System Admin / Project Creator'
  }[Number(level)] || 'Level 1 - General Staff';
}

function makeUser({ username, email, displayName, role, clearance, password, mustChangePassword = true }) {
  const now = new Date().toISOString();
  const loginEmail = normalizeLoginEmail(email || (String(username || '').includes('@') ? username : officialEmailForName(displayName, username)));
  return {
    id: crypto.randomUUID(),
    username: loginEmail,
    email: loginEmail,
    displayName,
    role,
    clearance: Number(clearance || 1),
    passwordHash: hashPassword(password),
    mustChangePassword,
    accountEnabled: true,
    active: false,
    createdAt: now,
    lastLoginAt: null,
    lastLogoutAt: null
  };
}

function buildDefaultDbFromSeed() {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const users = [];
  users.push(makeUser({
    username: 'admin@olutechagro.com',
    email: 'admin@olutechagro.com',
    displayName: 'System Administrator',
    role: 'System Admin',
    clearance: 5,
    password: 'admin123',
    mustChangePassword: true
  }));
  const seedStaff = normalizedSetupStaff(seed.staff || SPREADSHEET_SETUP_STAFF);
  for (const person of seedStaff) {
    if (person.isExternal) continue;
    const email = officialEmailForName(person.name);
    users.push(makeUser({
      username: email,
      email,
      displayName: person.name,
      role: person.role,
      clearance: inferClearance(person.name, person.role),
      password: 'olutech123',
      mustChangePassword: true
    }));
  }
  return {
    meta: {
      appName: 'Olutech Agro Project Management System',
      sourceWorkbook: seed.sourceWorkbook,
      createdAt: new Date().toISOString(),
      note: 'Generated from the uploaded operations productivity tracker.',
      persistence: persistenceLabel()
    },
    setup: {
      staff: seedStaff,
      projectCategories: seed.projectCategories || SPREADSHEET_PROJECT_CATEGORIES,
      delayCategories: seed.delayCategories || SPREADSHEET_DELAY_CATEGORIES,
      approvalTypes: seed.approvalTypes || SPREADSHEET_APPROVAL_TYPES,
      riskTypes: seed.riskTypes || SPREADSHEET_RISK_TYPES,
      riskCategories: seed.riskCategories || SPREADSHEET_RISK_CATEGORIES,
      impactAreas: seed.impactAreas || SPREADSHEET_IMPACT_AREAS,
      projectPhases: seed.projectPhases || SPREADSHEET_PROJECT_PHASES,
      projectHealthValues: seed.projectHealthValues || SPREADSHEET_PROJECT_HEALTH_VALUES,
      projectHealthStyles: { ...SPREADSHEET_PROJECT_HEALTH_STYLES },
      workSettings: seed.workSettings || {
        timeZone: TIME_ZONE,
        workdayStart: DEFAULT_WORKDAY_START,
        workdayEnd: DEFAULT_WORKDAY_END,
        expectedHours: DEFAULT_EXPECTED_WORKDAY_HOURS
      }
    },
    users,
    projects: seed.projects || [],
    tasks: seed.tasks || [],
    actions: seed.actions || [],
    delays: seed.delays || [],
    approvals: seed.approvals || [],
    risks: seed.risks || [],
    nxpChecklist: seed.nxpChecklist || [],
    lessons: seed.lessons || [],
    files: seed.files || [],
    attendance: seed.attendance || [],
    taskTimeEntries: [],
    notifications: [],
    authSessions: seed.authSessions || [],
    importHistory: seed.importHistory || [],
    chatMessages: seed.chatMessages || [],
    auditLog: []
  };
}

function backupCorruptDbFile() {
  if (!fs.existsSync(DB_FILE)) return;
  const backup = `${DB_FILE}.corrupt-${Date.now()}.bak`;
  try { fs.copyFileSync(DB_FILE, backup); } catch (_) {}
}

function writeDbLocal(db) {
  ensureDirectories();
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

function readLocalDb() {
  ensureDirectories();
  if (!fs.existsSync(DB_FILE)) return null;
  const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    backupCorruptDbFile();
    try { fs.unlinkSync(DB_FILE); } catch (_) {}
    return null;
  }
}


function initialiseDb() {
  ensureDirectories();
  const existing = readLocalDb();
  if (existing) return;
  writeDbLocal(buildDefaultDbFromSeed());
}

async function loadDb() {
  ensureDirectories();
  let db = null;
  try {
    db = await readCloudDb();
    if (db) writeDbLocal(db);
  } catch (err) {
    console.warn('Cloud database read failed. Using local JSON fallback:', err.message);
  }
  if (!db) db = readLocalDb();
  if (!db) {
    db = buildDefaultDbFromSeed();
    await saveDb(db);
  }
  let changed = false;
  changed = syncWorkbookSetup(db) || changed;
  changed = syncUsersFromSpreadsheetStaff(db) || changed;
  changed = normalizeUsers(db) || changed;
  changed = normalizeAuthSessions(db) || changed;
  if (!Array.isArray(db.importHistory)) { db.importHistory = []; changed = true; }
  changed = normalizeChatMessages(db) || changed;
  changed = normalizeAttendance(db) || changed;
  if (!Array.isArray(db.taskTimeEntries)) { db.taskTimeEntries = []; changed = true; }
  if (!Array.isArray(db.notifications)) { db.notifications = []; changed = true; }
  changed = normalizeProjectWorkflow(db) || changed;
  changed = syncOperationalAutomation(db, null) || changed;
  if (!db.meta) { db.meta = {}; changed = true; }
  const label = persistenceLabel();
  if (db.meta.persistence !== label) { db.meta.persistence = label; changed = true; }
  if (changed) await saveDb(db);
  return db;
}


function setupStaff(db) {
  const staff = db.setup && Array.isArray(db.setup.staff) ? db.setup.staff : SPREADSHEET_SETUP_STAFF;
  const deleted = setupDeletedStaffKeys(db);
  return staff.filter(person => person && person.name && !deleted.has(staffDeleteKey(person.name)));
}

function setupValues(db, key, fallback) {
  const values = db.setup && Array.isArray(db.setup[key]) ? db.setup[key] : fallback;
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizedSetupStaff(staff = []) {
  const internalByName = new Map();
  const externalByName = new Map();

  const addPerson = (person, forceExternal = false) => {
    if (!person) return;
    const rawName = String(person.name || '').trim();
    const name = canonicalStaffName(rawName);
    if (!name) return;
    const role = String(person.role || '').trim() || 'Team Member';
    const isExternal = Boolean(forceExternal || person.isExternal);
    const key = name.toLowerCase();
    const record = { ...person, name, role, isExternal };
    if (isExternal) externalByName.set(key, record);
    else internalByName.set(key, record);
  };

  // Start with the official spreadsheet staff, then preserve any custom employees
  // added from the Users screen so they do not disappear after reload/redeploy.
  for (const person of SPREADSHEET_SETUP_STAFF) addPerson(person, Boolean(person.isExternal));
  for (const person of staff || []) addPerson(person, Boolean(person.isExternal));

  return [...internalByName.values(), ...externalByName.values()];
}

function upsertSetupStaff(db, person = {}) {
  if (!db.setup) db.setup = {};
  if (!Array.isArray(db.setup.staff)) db.setup.staff = [];
  const name = canonicalStaffName(person.name);
  if (!name) return null;
  unmarkSetupStaffDeleted(db, name);
  const role = cleanText(person.role) || 'Team Member';
  const isExternal = Boolean(person.isExternal);
  const existing = db.setup.staff.find(item => item && staffIdentityEquals(item.name, name));
  if (existing) {
    existing.name = name;
    existing.role = role || existing.role || 'Team Member';
    existing.isExternal = isExternal;
    return existing;
  }
  const record = { name, role, isExternal };
  db.setup.staff.push(record);
  db.setup.staff = normalizedSetupStaff(db.setup.staff);
  return record;
}

function projectCategories(db) { return setupValues(db, 'projectCategories', SPREADSHEET_PROJECT_CATEGORIES); }
function delayCategories(db) { return setupValues(db, 'delayCategories', SPREADSHEET_DELAY_CATEGORIES); }
function approvalTypes(db) { return setupValues(db, 'approvalTypes', SPREADSHEET_APPROVAL_TYPES); }
function riskTypes(db) { return setupValues(db, 'riskTypes', SPREADSHEET_RISK_TYPES); }
function riskCategories(db) { return setupValues(db, 'riskCategories', SPREADSHEET_RISK_CATEGORIES); }
function impactAreas(db) { return setupValues(db, 'impactAreas', SPREADSHEET_IMPACT_AREAS); }
function projectPhases(db) { return setupValues(db, 'projectPhases', SPREADSHEET_PROJECT_PHASES); }
function projectHealthValues(db) { return setupValues(db, 'projectHealthValues', SPREADSHEET_PROJECT_HEALTH_VALUES); }

function syncWorkbookSetup(db) {
  let changed = false;
  if (!db.setup) {
    db.setup = {};
    changed = true;
  }

  const ensureArray = (key, fallback) => {
    const existing = Array.isArray(db.setup[key]) ? db.setup[key] : [];
    const merged = [...new Set([...existing, ...(fallback || [])].map(value => {
      if (value && typeof value === 'object') return JSON.stringify(value);
      return String(value || '').trim();
    }).filter(Boolean))].map(value => {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : value;
      } catch (_) {
        return value;
      }
    });
    if (!Array.isArray(db.setup[key]) || JSON.stringify(db.setup[key]) !== JSON.stringify(merged)) {
      db.setup[key] = merged;
      changed = true;
    }
  };

  ensureArray('staff', SPREADSHEET_SETUP_STAFF.map(person => ({ ...person })));
  if (!Array.isArray(db.setup.deletedStaffKeys)) { db.setup.deletedStaffKeys = []; changed = true; }
  const staffClean = normalizedSetupStaff(db.setup.staff);
  if (JSON.stringify(db.setup.staff) !== JSON.stringify(staffClean)) { db.setup.staff = staffClean; changed = true; }
  ensureArray('projectCategories', SPREADSHEET_PROJECT_CATEGORIES);
  ensureArray('delayCategories', SPREADSHEET_DELAY_CATEGORIES);
  ensureArray('approvalTypes', SPREADSHEET_APPROVAL_TYPES);
  ensureArray('riskTypes', SPREADSHEET_RISK_TYPES);
  ensureArray('riskCategories', SPREADSHEET_RISK_CATEGORIES);
  ensureArray('impactAreas', SPREADSHEET_IMPACT_AREAS);
  ensureArray('projectPhases', SPREADSHEET_PROJECT_PHASES);
  ensureArray('projectHealthValues', SPREADSHEET_PROJECT_HEALTH_VALUES);

  if (!db.setup.projectHealthStyles) { db.setup.projectHealthStyles = {}; changed = true; }
  for (const [key, value] of Object.entries(SPREADSHEET_PROJECT_HEALTH_STYLES)) {
    if (!db.setup.projectHealthStyles[key]) { db.setup.projectHealthStyles[key] = value; changed = true; }
  }
  if (!db.setup.workSettings) {
    db.setup.workSettings = {
      timeZone: TIME_ZONE,
      workdayStart: DEFAULT_WORKDAY_START,
      workdayEnd: DEFAULT_WORKDAY_END,
      expectedHours: DEFAULT_EXPECTED_WORKDAY_HOURS
    };
    changed = true;
  }
  // Migrate the standard 09:00-17:00 schedule without modifying historic clock-out entries.
  const schedule = db.setup.workSettings;
  if (schedule.workdayStart === '09:00' && schedule.workdayEnd === '17:00') {
    schedule.workdayEnd = '18:00';
    if (Number(schedule.expectedHours) === 8) schedule.expectedHours = 9;
    changed = true;
  }
  if (!db.meta) { db.meta = {}; changed = true; }
  if (!db.meta.sourceWorkbook) { db.meta.sourceWorkbook = 'OLUTECH AGRO OPERATIONS PRODUCTIVITY TRACKER.xlsx'; changed = true; }
  return changed;
}


function syncUsersFromSpreadsheetStaff(db) {
  const internalStaff = setupStaff(db).filter(person => !person.isExternal);
  const adminEmail = `admin@${OFFICIAL_EMAIL_DOMAIN}`;
  const allowedEmails = new Set([adminEmail, ...internalStaff.map(person => officialEmailForName(person.name))]);
  let changed = false;

  if (!Array.isArray(db.users)) { db.users = []; changed = true; }

  for (const user of db.users) {
    const currentUsername = String(user.username || '').trim().toLowerCase();
    const currentEmail = String(user.email || '').trim().toLowerCase();
    const displayName = String(user.displayName || '').trim();
    const canonicalDisplayName = canonicalStaffName(displayName);
    if (canonicalDisplayName && canonicalDisplayName !== displayName && !displayName.toLowerCase().includes('system administrator')) { user.displayName = canonicalDisplayName; changed = true; }
    const isAdmin = currentUsername === 'admin' || currentUsername === adminEmail || currentEmail === adminEmail || displayName.toLowerCase().includes('system administrator');
    if (isAdmin) {
      if (user.username !== adminEmail) { user.username = adminEmail; changed = true; }
      if (user.email !== adminEmail) { user.email = adminEmail; changed = true; }
      if (Number(user.clearance || 0) < 5) { user.clearance = 5; changed = true; }
      user.role = user.role || 'System Admin';
      continue;
    }
    const matchedStaff = internalStaff.find(person => {
      const email = officialEmailForName(person.name);
      const legacy = legacyUsernameForName(person.name);
      return staffIdentityEquals(person.name, user.displayName || displayName) || currentUsername === email || currentEmail === email || currentUsername === legacy || currentEmail === legacy;
    });
    if (matchedStaff && !user.adminManaged) {
      const email = officialEmailForName(matchedStaff.name);
      if (user.username !== email) { user.username = email; changed = true; }
      if (user.email !== email) { user.email = email; changed = true; }
      if (user.displayName !== matchedStaff.name) { user.displayName = matchedStaff.name; changed = true; }
      if (!user.role) { user.role = matchedStaff.role; changed = true; }
    } else if ((currentEmail || currentUsername).endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`) && canonicalDisplayName) {
      // Preserve custom employees that were created in the web app instead of the spreadsheet.
      upsertSetupStaff(db, { name: canonicalDisplayName, role: user.role || 'Team Member', isExternal: false });
      changed = true;
    }
  }

  db.users = db.users.filter(user => {
    const email = normalizeLoginEmail(user.email || user.username);
    const nameKey = String(user.displayName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (REMOVED_INTERNAL_STAFF.has(nameKey)) { changed = true; return false; }
    if (allowedEmails.has(email) || email.endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`)) return true;
    changed = true;
    return false;
  });

  const admin = db.users.find(user => normalizeLoginEmail(user.email || user.username) === adminEmail);
  if (!admin) {
    db.users.unshift(makeUser({
      username: adminEmail,
      email: adminEmail,
      displayName: 'System Administrator',
      role: 'System Admin',
      clearance: 5,
      password: 'admin123',
      mustChangePassword: true
    }));
    changed = true;
  }

  for (const person of internalStaff) {
    const email = officialEmailForName(person.name);
    let existing = db.users.find(user => normalizeLoginEmail(user.email || user.username) === email || samePerson(user.displayName, person.name));
    if (!existing) {
      db.users.push(makeUser({
        username: email,
        email,
        displayName: person.name,
        role: person.role,
        clearance: inferClearance(person.name, person.role),
        password: 'olutech123',
        mustChangePassword: true
      }));
      changed = true;
      continue;
    }
    // Explicit Level 5 edits always win over workbook defaults and old seed staff.
    if (!existing.adminManaged) {
      if (existing.username !== email) { existing.username = email; changed = true; }
      if (existing.email !== email) { existing.email = email; changed = true; }
      if (existing.displayName !== person.name) { existing.displayName = person.name; changed = true; }
      if (existing.role !== person.role) { existing.role = person.role; changed = true; }
    }
    if (typeof existing.clearance === 'undefined') { existing.clearance = inferClearance(person.name, person.role); changed = true; }
    // Never re-enable an explicitly disabled account.
  }

  return changed;
}

async function saveDb(db) {
  if (!db.meta) db.meta = {};
  const stamp = new Date().toISOString();
  db.meta.updatedAt = stamp;
  db.meta.persistence = persistenceLabel();
  db.meta.storageMode = storageMode();
  db.meta.persistenceKey = PERSISTENCE_KEY;

  let cloudOk = false;
  if (kvEnv().configured) {
    try {
      db.meta.lastCloudSaveAttemptAt = stamp;
      db.meta.lastCloudSaveAt = stamp;
      db.meta.lastCloudSaveError = '';
      cloudOk = await writeCloudDb(db);
      if (!cloudOk) db.meta.lastCloudSaveError = 'Cloud save returned no confirmation.';
    } catch (err) {
      db.meta.lastCloudSaveError = err.message;
      console.warn('Cloud database save failed. Local JSON was still saved:', err.message);
    }
  } else if (IS_VERCEL) {
    db.meta.lastCloudSaveError = 'Cloud persistence variables are missing on Vercel. Data may reset.';
  }

  writeDbLocal(db);
}

function addAudit(db, user, action, details) {
  db.auditLog.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    user: user ? user.username : 'system',
    action,
    details
  });
  db.auditLog = db.auditLog.slice(0, 500);
}

function normalizeUsers(db) {
  let changed = false;
  for (const user of db.users || []) {
    const adminEmail = `admin@${OFFICIAL_EMAIL_DOMAIN}`;
    const canonicalDisplay = canonicalStaffName(user.displayName);
    if (canonicalDisplay && canonicalDisplay !== user.displayName && !String(user.displayName || '').toLowerCase().includes('system administrator')) { user.displayName = canonicalDisplay; changed = true; }
    const currentUsername = String(user.username || '').toLowerCase();
    const isAdmin = currentUsername === 'admin' || currentUsername === adminEmail || String(user.email || '').toLowerCase() === adminEmail || String(user.displayName || '').toLowerCase().includes('system administrator');
    if (isAdmin) {
      if (user.username !== adminEmail) { user.username = adminEmail; changed = true; }
      if (user.email !== adminEmail) { user.email = adminEmail; changed = true; }
    } else {
      const email = normalizeLoginEmail(user.email || (String(user.username || '').includes('@') ? user.username : officialEmailForName(user.displayName, user.username)));
      if (email && user.username !== email) { user.username = email; changed = true; }
      if (email && user.email !== email) { user.email = email; changed = true; }
    }
    if (isAdmin && Number(user.clearance || 0) < 5) {
      user.clearance = 5;
      user.role = user.role || 'System Admin / Project Creator';
      changed = true;
    }
    if (Number(user.clearance || 1) > 5) { user.clearance = 5; changed = true; }
    if (typeof user.accountEnabled === 'undefined') {
      // Account Access is separate from session activity. Old databases may only
      // have `active`; do not use that field to decide whether someone can log in.
      user.accountEnabled = true;
      changed = true;
    }
    if (typeof user.active === 'undefined' || user.accountEnabled === false) {
      user.active = false;
      changed = true;
    }
  }
  return changed;
}

function normalizeAuthSessions(db) {
  let changed = false;
  if (!db.authSessions || !Array.isArray(db.authSessions)) {
    db.authSessions = [];
    changed = true;
  }
  const now = Date.now();
  const seen = new Set();
  const cleaned = [];
  for (const raw of db.authSessions || []) {
    if (!raw || !raw.token || !raw.userId) { changed = true; continue; }
    if (seen.has(raw.token)) { changed = true; continue; }
    seen.add(raw.token);
    const createdAt = Number(raw.createdAt || now);
    const expiresAt = Number(raw.expiresAt || (createdAt + SESSION_DURATION_MS));
    if (expiresAt <= now) { changed = true; continue; }
    cleaned.push({
      token: raw.token,
      userId: raw.userId,
      createdAt,
      expiresAt,
      lastSeenAt: Number(raw.lastSeenAt || createdAt)
    });
  }
  if (cleaned.length > 250) {
    cleaned.sort((a, b) => Number(b.lastSeenAt || b.createdAt || 0) - Number(a.lastSeenAt || a.createdAt || 0));
    cleaned.length = 250;
    changed = true;
  }
  if (JSON.stringify(db.authSessions || []) !== JSON.stringify(cleaned)) {
    db.authSessions = cleaned;
    changed = true;
  }
  return changed;
}

function sessionExpired(session, now = Date.now()) {
  if (!session || !session.userId) return true;
  const expiresAt = Number(session.expiresAt || (Number(session.createdAt || 0) + SESSION_DURATION_MS));
  return !expiresAt || expiresAt <= now;
}

function cleanupExpiredSessions(db = null) {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (sessionExpired(session, now)) sessions.delete(token);
  }
  let changed = false;
  if (db) {
    if (!Array.isArray(db.authSessions)) { db.authSessions = []; changed = true; }
    const before = db.authSessions.length;
    db.authSessions = db.authSessions.filter(session => !sessionExpired(session, now));
    if (db.authSessions.length !== before) changed = true;
  }
  return changed;
}

function storedSession(db, token) {
  if (!db || !token) return null;
  return (db.authSessions || []).find(session => session.token === token) || null;
}

function addAuthSession(db, token, userId) {
  const now = Date.now();
  if (!Array.isArray(db.authSessions)) db.authSessions = [];
  const session = { token, userId, createdAt: now, expiresAt: now + SESSION_DURATION_MS, lastSeenAt: now };
  sessions.set(token, session);
  db.authSessions = (db.authSessions || []).filter(item => item && item.token !== token);
  db.authSessions.unshift(session);
  normalizeAuthSessions(db);
  return session;
}

function removeAuthSession(db, token) {
  if (!token) return false;
  sessions.delete(token);
  if (!db || !Array.isArray(db.authSessions)) return true;
  const before = db.authSessions.length;
  db.authSessions = db.authSessions.filter(session => session && session.token !== token);
  return before !== db.authSessions.length;
}

function removeUserAuthSessions(db, userId) {
  let changed = false;
  for (const [token, session] of sessions.entries()) {
    if (session && session.userId === userId) { sessions.delete(token); changed = true; }
  }
  if (db && Array.isArray(db.authSessions)) {
    const before = db.authSessions.length;
    db.authSessions = db.authSessions.filter(session => session && session.userId !== userId);
    if (before !== db.authSessions.length) changed = true;
  }
  return changed;
}

function activeSessionUserIds(db = null) {
  cleanupExpiredSessions(db);
  const ids = new Set();
  for (const session of sessions.values()) {
    if (session && session.userId && !sessionExpired(session)) ids.add(session.userId);
  }
  if (db && Array.isArray(db.authSessions)) {
    for (const session of db.authSessions) {
      if (session && session.userId && !sessionExpired(session)) ids.add(session.userId);
    }
  }
  return ids;
}

function syncSessionActivity(db) {
  normalizeUsers(db);
  normalizeAuthSessions(db);
  const activeIds = activeSessionUserIds(db);
  let changed = false;
  for (const user of db.users || []) {
    const isActive = activeIds.has(user.id);
    if (user.active !== isActive) {
      user.active = isActive;
      changed = true;
    }
  }
  return changed;
}

function workSettings(db) {
  const settings = (db.setup && db.setup.workSettings) || {};
  return {
    timeZone: settings.timeZone || TIME_ZONE,
    workdayStart: settings.workdayStart || DEFAULT_WORKDAY_START,
    workdayEnd: settings.workdayEnd || DEFAULT_WORKDAY_END,
    expectedHours: Number(settings.expectedHours || DEFAULT_EXPECTED_WORKDAY_HOURS)
  };
}

function zonedParts(date = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return parts;
}

function localDate(date = new Date(), db = null) {
  const tz = db ? workSettings(db).timeZone : TIME_ZONE;
  const p = zonedParts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function localTime(date = new Date(), db = null) {
  const tz = db ? workSettings(db).timeZone : TIME_ZONE;
  const p = zonedParts(date, tz);
  return `${p.hour}:${p.minute}`;
}

function formatLocalDateTime(value, db = null) {
  if (!value) return '';
  const tz = db ? workSettings(db).timeZone : TIME_ZONE;
  const p = zonedParts(new Date(value), tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function formatLocalTime(value, db = null) {
  if (!value) return '';
  return localTime(new Date(value), db);
}

function normalizeAttendance(db) {
  let changed = false;
  if (!Array.isArray(db.attendance)) {
    db.attendance = [];
    changed = true;
  }
  if (!db.setup) {
    db.setup = {};
    changed = true;
  }
  if (!db.setup.workSettings) {
    db.setup.workSettings = {
      timeZone: TIME_ZONE,
      workdayStart: DEFAULT_WORKDAY_START,
      workdayEnd: DEFAULT_WORKDAY_END,
      expectedHours: DEFAULT_EXPECTED_WORKDAY_HOURS
    };
    changed = true;
  }
  for (const record of db.attendance) {
    if (!record.id) { record.id = `ATT-${crypto.randomBytes(6).toString('hex')}`; changed = true; }
    if (!record.status) { record.status = record.clockOutAt ? 'Completed' : 'Clocked In'; changed = true; }
    if (!record.workDate && record.clockInAt) { record.workDate = localDate(new Date(record.clockInAt), db); changed = true; }
    if (record.clockInAt && !record.clockInTime) { record.clockInTime = formatLocalTime(record.clockInAt, db); changed = true; }
    if (record.clockOutAt && !record.clockOutTime) { record.clockOutTime = formatLocalTime(record.clockOutAt, db); changed = true; }
    if (record.clockInAt && record.clockOutAt) {
      const totalMs = Math.max(0, new Date(record.clockOutAt) - new Date(record.clockInAt));
      if (record.totalMs !== totalMs) { record.totalMs = totalMs; changed = true; }
    }
  }
  return changed;
}


function isTimeClockExcludedName(name) {
  const text = String(name || '').trim().toLowerCase();
  return text === 'akin';
}

function isTimeClockUser(user) {
  if (!user) return false;
  return !isTimeClockExcludedName(user.displayName || user.username);
}

function openAttendanceRecord(db, userId) {
  return (db.attendance || []).find(record => record.userId === userId && !record.clockOutAt) || null;
}

function attendanceVisibleRecords(db, user) {
  const records = [...(db.attendance || [])]
    .filter(record => !isTimeClockExcludedName(record.displayName || record.username))
    .sort((a, b) => String(b.clockInAt || '').localeCompare(String(a.clockInAt || '')));
  if (Number(user.clearance || 1) >= 5) return records;
  return records.filter(record => record.userId === user.id);
}

function attendanceRecordsForUserDate(db, userId, dateText) {
  return (db.attendance || []).filter(record => record.userId === userId && record.workDate === dateText);
}

function recordDurationMs(record) {
  if (!record || !record.clockInAt) return 0;
  if (record.clockOutAt) return Math.max(0, new Date(record.clockOutAt) - new Date(record.clockInAt));
  return Math.max(0, Date.now() - new Date(record.clockInAt));
}

function attendanceTotalMs(records) {
  return (records || []).reduce((sum, record) => sum + recordDurationMs(record), 0);
}

function userDailyAttendanceMs(db, userId, dateText) {
  return attendanceTotalMs(attendanceRecordsForUserDate(db, userId, dateText));
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(Number(ms || 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours && !minutes) return '0m';
  if (!hours) return `${minutes}m`;
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function timeToMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function expectedWorkdayMs(db) {
  const settings = workSettings(db);
  if (settings.expectedHours) return Math.max(0, settings.expectedHours) * 60 * 60 * 1000;
  const span = timeToMinutes(settings.workdayEnd) - timeToMinutes(settings.workdayStart);
  return Math.max(0, span) * 60 * 1000;
}


function localWorkdayEndDate(db, workDate) {
  const settings = workSettings(db);
  const dateText = String(workDate || localDate(new Date(), db)).slice(0, 10);
  const end = settings.workdayEnd || DEFAULT_WORKDAY_END;
  // Lagos office schedule: Africa/Lagos is UTC+01:00 with no DST.
  return new Date(`${dateText}T${end}:00+01:00`);
}

function attendanceAutomaticDueAt(db, record) {
  if (!record || !record.clockInAt) return null;
  const clockIn = new Date(record.clockInAt);
  if (!Number.isFinite(clockIn.getTime())) return null;
  // Decide by the original clock-in time, not today's clock or a later request.
  const officialEnd = localWorkdayEndDate(db, localDate(clockIn, db));
  if (!Number.isFinite(officialEnd.getTime())) return null;
  return clockIn >= officialEnd ? new Date(clockIn.getTime() + 30 * 60000) : officialEnd;
}

function autoClockOutAttendance(db, now = new Date()) {
  normalizeAttendance(db);
  let changed = false;
  for (const record of db.attendance || []) {
    if (!record || !record.clockInAt || record.clockOutAt) continue;
    const due = attendanceAutomaticDueAt(db, record);
    if (!due || now < due) continue;
    const clockIn = new Date(record.clockInAt);
    const late = clockIn >= localWorkdayEndDate(db, localDate(clockIn, db));
    record.clockOutAt = due.toISOString();
    record.clockOutTime = localTime(due, db);
    record.totalMs = Math.max(0, due - clockIn);
    record.status = 'Auto Clocked Out';
    record.autoClockOut = true;
    record.autoClockOutDueAt = due.toISOString();
    record.autoClockOutReason = late
      ? 'Automatically clocked out 30 minutes after a clock-in at or after 6:00 PM.'
      : 'Automatically clocked out at the 6:00 PM workday close.';
    record.workSummary = record.workSummary || record.autoClockOutReason;
    changed = true;
  }
  if (changed) addAudit(db, null, 'auto_clock_out', 'Completed attendance sessions at their scheduled automatic checkout times.');
  return changed;
}

function attendanceDayFlag(db, userId, dateText) {
  const records = attendanceRecordsForUserDate(db, userId, dateText);
  if (!records.length) return 'No Record';
  if (records.some(record => !record.clockOutAt)) return 'Clocked In';
  const total = attendanceTotalMs(records);
  const expected = expectedWorkdayMs(db);
  if (expected && total >= expected) return 'Full Day';
  return 'Partial Day';
}

function attendanceFlagClass(flag) {
  const text = String(flag || '').toLowerCase();
  if (text.includes('clocked in') || text.includes('full')) return 'good';
  if (text.includes('partial')) return 'warn';
  if (text.includes('no')) return 'bad';
  return 'neutral';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function fmtDate(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function fmtPercent(value) {
  const n = Number(value || 0);
  return `${Math.round(n * 100)}%`;
}

function isClosed(status) {
  const s = String(status || '').toLowerCase();
  return s === 'completed' || s === 'closed' || s === 'cancelled' || s === 'approved' || s === 'resolved';
}

function isOverdue(item) {
  if (!item.dueDate || isClosed(item.status)) return false;
  const due = new Date(`${item.dueDate}T23:59:59`);
  return due < new Date();
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('complete') || s === 'closed' || s === 'approved') return 'good';
  if (s.includes('progress') || s.includes('monitor')) return 'info';
  if (s.includes('pending') || s.includes('not started')) return 'warn';
  if (s.includes('blocked') || s.includes('delay') || s.includes('rejected') || s.includes('open')) return 'bad';
  if (s.includes('cancel')) return 'muted';
  return 'neutral';
}

function priorityClass(priority) {
  const p = String(priority || '').toLowerCase();
  if (p.includes('critical')) return 'bad';
  if (p.includes('high')) return 'warn';
  if (p.includes('medium')) return 'info';
  return 'neutral';
}

function parseCookies(req) {
  const cookie = req.headers.cookie || '';
  const out = {};
  cookie.split(';').forEach(part => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return;
    out[key] = decodeURIComponent(rest.join('='));
  });
  return out;
}

function currentUser(req, db) {
  cleanupExpiredSessions(db);
  const token = parseCookies(req).session;
  if (!token) return null;
  let session = sessions.get(token) || storedSession(db, token);
  if (!session || sessionExpired(session)) {
    removeAuthSession(db, token);
    return null;
  }
  const user = db.users.find(u => u.id === session.userId && u.accountEnabled !== false) || null;
  if (!user) {
    removeAuthSession(db, token);
    return null;
  }
  session.lastSeenAt = Date.now();
  sessions.set(token, session);
  const dbSession = storedSession(db, token);
  if (dbSession) dbSession.lastSeenAt = session.lastSeenAt;
  return user;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function notFound(res, user) {
  send(res, 404, page('Not found', `<div class="panel"><h1>Page not found</h1><p>The page you requested does not exist.</p></div>`, user));
}

// A reset always has a verified backup, and never relies on Vercel /tmp storage.
// The backup uses a distinct Upstash key, not the live database key.
async function verifiedPreResetBackup(db) {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${PERSISTENCE_KEY}:pre-reset:${now}:${crypto.randomBytes(4).toString('hex')}`;
  if (kvEnv().configured) {
    const source = await readCloudDb();
    if (!source || typeof source !== 'object' || !Array.isArray(source.projects) || !Array.isArray(source.tasks)) {
      throw new Error('Cloud records could not be read reliably. Nothing was deleted.');
    }
    const serialized = JSON.stringify(source);
    const result = await upstashRequest(`set/${encodeURIComponent(backupName)}`, serialized);
    if (result !== 'OK' && result !== 'ok' && result !== true) throw new Error('Cloud backup was not acknowledged. Nothing was deleted.');
    const readBack = await upstashRequest(`get/${encodeURIComponent(backupName)}`);
    const restored = typeof readBack === 'string' ? readBack : JSON.stringify(readBack);
    if (crypto.createHash('sha256').update(restored).digest('hex') !== crypto.createHash('sha256').update(serialized).digest('hex')) {
      throw new Error('Cloud backup verification failed. Nothing was deleted.');
    }
    return { source, backupName, storage: 'cloud' };
  }
  if (IS_VERCEL) throw new Error('Live reset is blocked without durable cloud storage. Nothing was deleted.');
  ensureDirectories();
  const backupFolder = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupFolder, { recursive: true });
  const source = JSON.parse(JSON.stringify(db));
  const file = path.join(backupFolder, `before-reset-${now}-${crypto.randomBytes(4).toString('hex')}.json`);
  const serialized = JSON.stringify(source, null, 2);
  fs.writeFileSync(file, serialized, { flag: 'wx', mode: 0o600 });
  if (fs.readFileSync(file, 'utf8') !== serialized) throw new Error('Local backup verification failed. Nothing was deleted.');
  return { source, backupName: file, storage: 'local' };
}

function requireLogin(req, res, db) {
  const user = currentUser(req, db);
  if (!user) {
    redirect(res, '/login');
    return null;
  }
  return user;
}

function requireClearance(req, res, db, level) {
  const user = requireLogin(req, res, db);
  if (!user) return null;
  if (Number(user.clearance) < Number(level)) {
    send(res, 403, page('Access restricted', `<div class="panel"><h1>Access restricted</h1><p>This area requires ${escapeHtml(clearanceName(level))}. Your account is ${escapeHtml(clearanceName(user.clearance))}.</p><p><a class="button" href="/dashboard">Back to dashboard</a></p></div>`, user));
    return null;
  }
  return user;
}

function getBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseUrlEncodedMany(req) {
  const body = await getBody(req);
  return new URLSearchParams(body.toString('utf8'));
}

async function parseUrlEncoded(req) {
  const body = await getBody(req);
  const params = new URLSearchParams(body.toString('utf8'));
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary');
  const boundary = match[1] || match[2];
  const body = await getBody(req, MAX_UPLOAD_BYTES + 1024 * 1024);
  const raw = body.toString('binary');
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = [];
  for (let part of parts) {
    if (part.startsWith('\r\n')) part = part.slice(2);
    if (part.endsWith('\r\n')) part = part.slice(0, -2);
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const headerText = part.slice(0, idx);
    const contentBinary = part.slice(idx + 4);
    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText);
    if (!disposition) continue;
    const nameMatch = /name="([^"]+)"/i.exec(disposition[1]);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition[1]);
    if (filenameMatch && filenameMatch[1]) {
      files.push({ fieldName, filename: filenameMatch[1], buffer: Buffer.from(contentBinary, 'binary') });
    } else {
      fields[fieldName] = Buffer.from(contentBinary, 'binary').toString('utf8');
    }
  }
  return { fields, files };
}

function uiIcon(name) {
  const paths = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    projects: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M7 3v4M17 3v4"/>',
    tasks: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="m8 11 2 2 4-5M8 17h8"/>',
    reports: '<path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M8 16v-4m4 4V8m4 8v-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    delay: '<path d="m12 3 9 16H3L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
    approvals: '<path d="M9 12.5 11 15l4-5"/><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 3V2h6v1"/>',
    analytics: '<path d="M4 20V13m5 7V8m5 12v-5m5 5V4"/>',
    lessons: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5Zm0 12A2.5 2.5 0 0 1 6.5 15H20M8 8h8m-8 4h6"/>',
    import: '<path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 17v3h16v-3"/>',
    storage: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v1"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    exit: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
    sparkle: '<path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7L12 3Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
  };
  return `<svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.overview}</svg>`;
}

function page(title, body, user) {
  const nav = user ? navHtml(user) : '';
  const showPasswordLink = user && (Number(user.clearance || 1) >= 5 || user.mustChangePassword === true);
  const passwordLink = showPasswordLink ? `<a class="userbar-link" href="/change-password">${uiIcon('lock')}<span>${Number(user.clearance || 1) >= 5 ? 'Password Admin' : 'Change password'}</span></a>` : '';
  const themeChoice = user && user.theme === 'dark' ? 'dark' : 'light';
  const themeControl = user ? `<form class="theme-form" method="post" action="/preferences/theme"><input type="hidden" name="returnTo" value="/dashboard"><label class="theme-label" for="themeChoice">Appearance</label><select id="themeChoice" name="theme" aria-label="Theme preference" onchange="this.form.elements.returnTo.value=window.location.pathname+window.location.search;this.form.submit()"><option value="light" ${themeChoice === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${themeChoice === 'dark' ? 'selected' : ''}>Dark</option></select></form>` : '';
  const notificationControl = user ? `<div class="notification-center" id="notificationCenter">
    <button type="button" class="notification-trigger" id="notificationTrigger" aria-label="Notifications" aria-expanded="false" aria-controls="notificationPanel">${uiIcon('bell')}<span class="notification-badge" id="notificationBadge" hidden>0</span></button>
    <section class="notification-panel" id="notificationPanel" aria-label="Task notifications" hidden>
      <div class="notification-panel-header"><b>Notifications</b><button type="button" id="notificationReadAll" class="notification-mark-all">Mark all read</button></div>
      <div class="notification-items" id="notificationItems"><p class="notification-empty">No notifications yet.</p></div>
      <p class="notification-panel-foot">You'll be notified of task assignments, openings, and closures. Popups appear while your PMS is open.</p>
    </section></div>` : '';
  const avatar = user ? String(user.displayName || 'OA').split(/\s+/).map(x=>x[0]||'').join('').substring(0,2).toUpperCase() : 'OA';
  const userbar = user ? `<div class="userbar">${passwordLink}${themeControl}${notificationControl}<div class="user-identity"><span class="user-avatar">${escapeHtml(avatar)}</span><span class="user-identity-text"><b>${escapeHtml(user.displayName)}</b><small>${escapeHtml(user.email || user.username || '')}</small></span></div><form class="logout-form" method="post" action="/logout"><button type="submit" class="logout-button">${uiIcon('exit')}<span>Logout</span></button></form></div>` : '';
  return `<!doctype html>
<html lang="en" data-theme="${user && user.theme === 'dark' ? 'dark' : 'light'}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#165748" />
  <title>${escapeHtml(title)} | Olutech Agro PMS</title>
  <link rel="stylesheet" href="/public/styles.css" />
  <link rel="stylesheet" href="/public/interface.css" />
</head>
<body class="${user ? 'app-page' : 'auth-page'}">
  <header class="topbar">
    <div class="topbar-brand-group">
      ${user ? `<button type="button" class="nav-toggle" aria-label="Open navigation" aria-controls="mainSidebar" aria-expanded="false" onclick="toggleOlutechNav()">${uiIcon('menu')}</button>` : ''}
      <a class="brand" href="/dashboard"><span class="brand-mark">OA</span><span class="brand-copy"><strong>OLUTECH <em>AGRO</em></strong><small>Operations Workspace</small></span></a>
      ${user ? '<span class="workspace-divider" aria-hidden="true"></span><span class="workspace-wordmark">Project Management</span>' : ''}
    </div>
    ${userbar}
  </header>
  <div class="shell">
    ${nav}
    ${user ? '<button class="nav-scrim" type="button" aria-label="Close navigation" onclick="toggleOlutechNav(false)"></button>' : ''}
    <main class="content" id="mainContent">${user ? `<div class="page-context"><span>Olutech Workspace</span><span class="crumb-divider">/</span><strong>${escapeHtml(title)}</strong></div>${persistenceWarningHtml()}` : ''}${body}</main>
  </div>
  ${user ? '<script src="/public/notifications.js" defer></script>' : ''}
  ${user ? `<script>
    function toggleOlutechNav(force) {
      const shouldOpen = typeof force === 'boolean' ? force : !document.body.classList.contains('nav-open');
      document.body.classList.toggle('nav-open', shouldOpen);
      const toggle = document.querySelector('.nav-toggle');
      if (toggle) { toggle.setAttribute('aria-expanded', String(shouldOpen)); toggle.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation'); }
    }
    (function () {
      const current = window.location.pathname;
      const navLinks = Array.from(document.querySelectorAll('.sidebar a[href]'));
      navLinks.forEach(function (link) {
        const target = new URL(link.href).pathname;
        if (current === target || (target !== '/dashboard' && current.startsWith(target + '/')) || (current === '/tasks/view' && target === '/tasks')) {
          link.classList.add('active'); link.setAttribute('aria-current', 'page');
        }
      });
      document.addEventListener('keydown', function(e) { if(e.key === 'Escape') toggleOlutechNav(false); });
    })();
  </script>` : ''}
</body>
</html>`;
}

function navHtml(user) {
  const sections = [
    ['WORKSPACE', [
      ['Dashboard', '/dashboard', 1, '', 'overview'],
      ['Projects', '/projects', 1, '', 'projects'],
      ['Tasks', '/tasks', 1, '', 'tasks'],
      ['Weekly Reports', '/reports/weekly', 1, '', 'reports']
    ]],
    ['OPERATIONS', [
      ['Time Clock', '/attendance', 1, 'timeclock', 'clock'],
      ['Delays', '/delays', 2, '', 'delay'],
      ['Approvals', '/approvals', 3, '', 'approvals'],
      ['KPI', '/kpi', 2, '', 'analytics'],
      ['Lessons', '/lessons', 2, '', 'lessons']
    ]],
    ['ADMINISTRATION', [
      ['Users', '/admin/users', 5, '', 'people'],
      ['Excel Import', '/excel-import', 5, '', 'import'],
      ['Storage Status', '/storage-status', 5, '', 'storage'],
      ['Password Admin', '/change-password', 1, 'password', 'lock']
    ]]
  ];
  const shown = sections.map(([heading, links]) => {
    const allowed = links.filter(([label, href, level, feature]) => {
      if (Number(user.clearance || 1) < level) return false;
      if (feature === 'timeclock' && !isTimeClockUser(user)) return false;
      if (feature === 'password' && Number(user.clearance || 1) < 5 && user.mustChangePassword !== true) return false;
      return true;
    });
    if (!allowed.length) return '';
    return `<div class="sidebar-section"><span class="sidebar-heading">${heading}</span>${allowed.map(([label,href,level,feature,icon])=>`<a href="${href}">${uiIcon(icon)}<span>${label}</span></a>`).join('')}</div>`;
  }).join('');
  return `<aside class="sidebar" id="mainSidebar" aria-label="Primary navigation"><div class="sidebar-inner"><div class="sidebar-intro"><span class="intro-glyph">${uiIcon('sparkle')}</span><div><b>Your workspace</b><small>Plan. Execute. Deliver.</small></div></div><nav aria-label="Main menu">${shown}</nav></div><div class="sidebar-footer"><span class="sidebar-footer-dot"></span><div><b>Olutech Agro Limited</b><small>${escapeHtml(clearanceName(user.clearance))}</small></div></div></aside>`;
}

function metric(label, value, hint = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</div>`;
}

function pill(text, kind = 'neutral') {
  return `<span class="pill ${kind}">${escapeHtml(text || '')}</span>`;
}

function progressBar(value) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)));
  return `<div class="bar"><span style="width:${pct}%"></span></div><small>${pct}%</small>`;
}

function visibleTasks(db, user) {
  const name = String(user.displayName || user.username || '').trim().toLowerCase();
  if (Number(user.clearance || 1) >= 5) return db.tasks || [];
  return (db.tasks || []).filter(t => {
    return t.assignedUserId === user.id || t.assignedByUserId === user.id ||
      String(t.assignedTo || '').trim().toLowerCase() === name ||
      String(t.assignedBy || '').trim().toLowerCase() === name;
  });
}

function workflowTasks(db, projectId) {
  return (db.tasks || [])
    .filter(t => t.projectId === projectId && (t.workflowManaged || Number(t.workflowOrder || 0) > 0))
    .sort((a, b) => Number(a.workflowOrder || 0) - Number(b.workflowOrder || 0) || String(a.id || '').localeCompare(String(b.id || '')));
}

function projectAllTasks(db, projectId) {
  return (db.tasks || []).filter(t => t.projectId === projectId);
}

function taskDone(task) {
  return ['completed', 'closed', 'approved', 'skipped'].includes(String(task.status || '').toLowerCase());
}

function taskActive(task) {
  return ['ready', 'in progress', 'blocked', 'delayed'].includes(String(task.status || '').toLowerCase());
}

function taskWaiting(task) {
  return ['waiting', 'not started', 'pending'].includes(String(task.status || '').toLowerCase());
}

function taskRole(db, assignee) {
  return roleForStaff(db, assignee) || 'Project Contributor';
}

function nextWorkflowOrder(db, projectId) {
  const max = projectAllTasks(db, projectId).reduce((highest, task) => Math.max(highest, Number(task.workflowOrder || 0)), 0);
  return max + 1;
}

function currentWorkflowTask(db, projectId) {
  const steps = workflowTasks(db, projectId);
  return steps.find(t => ['ready', 'in progress', 'blocked', 'delayed'].includes(String(t.status || '').toLowerCase())) || steps.find(t => !taskDone(t)) || null;
}

function isCurrentWorkflowTask(db, task) {
  if (!task || !task.workflowManaged) return true;
  const current = currentWorkflowTask(db, task.projectId);
  return current && current.id === task.id;
}

function normalizeProjectWorkflow(db) {
  let changed = false;
  if (!Array.isArray(db.projectHandoffs)) { db.projectHandoffs = []; changed = true; }
  for (const task of db.tasks || []) {
    if (typeof task.progress === 'undefined' || task.progress === null || task.progress === '') { task.progress = taskDone(task) ? 1 : 0; changed = true; }
    if (task.workflowManaged && !task.assignedRole) { task.assignedRole = taskRole(db, task.assignedTo); changed = true; }
    if (task.workflowManaged && !task.workflowStatus) { task.workflowStatus = task.status || 'Waiting'; changed = true; }
  }
  for (const project of db.projects || []) {
    if (typeof project.workflowEnabled === 'undefined') {
      project.workflowEnabled = workflowTasks(db, project.id).length > 0;
      changed = true;
    }
    if (!project.createdBy) { project.createdBy = 'System'; changed = true; }
    changed = syncProjectAutomation(db, project.id, null, false) || changed;
  }
  return changed;
}

function projectStats(db, projectId) {
  const all = projectAllTasks(db, projectId);
  const workflow = workflowTasks(db, projectId);
  const basis = workflow.length ? workflow : all;
  const completed = basis.filter(taskDone).length;
  const open = basis.filter(t => !taskDone(t)).length;
  const overdue = basis.filter(isOverdue).length;
  const blocked = basis.filter(t => ['blocked', 'delayed'].includes(String(t.status || '').toLowerCase())).length;
  const progress = basis.length ? completed / basis.length : 0;
  const current = workflow.length ? currentWorkflowTask(db, projectId) : null;
  return { tasks: basis.length, completed, open, overdue, blocked, progress, current, workflowCount: workflow.length };
}

function projectHealthFromData(db, project) {
  const projectId = project.id;
  const stats = projectStats(db, projectId);
  const tasks = projectStats(db, projectId).workflowCount ? workflowTasks(db, projectId) : projectAllTasks(db, projectId);
  const hasOverdueTask = tasks.some(isOverdue);
  const hasBlockedOrDelayedTask = tasks.some(t => ['blocked', 'delayed'].includes(String(t.status || '').toLowerCase()));
  const hasOpenDelay = (db.delays || []).some(d => d.projectId === projectId && !isClosed(d.status));
  const hasOpenApproval = (db.approvals || []).some(a => a.projectId === projectId && !isClosed(a.status));
  if (hasOverdueTask || hasBlockedOrDelayedTask || hasOpenDelay || hasOpenApproval) return 'Red';
  if (stats.workflowCount && stats.current && String(stats.current.status || '').toLowerCase() === 'ready') return 'Amber';
  return 'Green';
}

function currentProjectHealth(db, project) {
  return projectHealthFromData(db, project);
}

function projectHealthClass(value) {
  const health = String(value || '').toLowerCase();
  if (health === 'green') return 'health-green';
  if (health === 'amber') return 'health-amber';
  if (health === 'red') return 'health-red';
  return 'health-neutral';
}

function projectHealthBadge(value) {
  return `<span class="health-pill ${projectHealthClass(value)}">${escapeHtml(value || '')}</span>`;
}


function taskTypeOptions() {
  return [
    'General Task',
    'Workflow Step',
    'NXP / Documentation Checklist',
    'Export Documentation',
    'Approval Follow-up',
    'Risk Mitigation',
    'Delay Resolution',
    'File / Evidence Upload',
    'Logistics / Port Task',
    'Sourcing / Procurement Task',
    'Quality Control Task'
  ];
}

function taskTypeOptionsHtml(selected = 'General Task') {
  return statusOptionsHtml(taskTypeOptions(), selected || 'General Task');
}

function taskAssignableByUser(task, user) {
  if (!task || !user) return false;

  // Level 5 clearance can update every task across the system.
  if (Number(user.clearance || 1) >= 5) return true;

  // Other users can only update tasks assigned to them or assigned by them.
  return task.assignedUserId === user.id || task.assignedByUserId === user.id || samePerson(task.assignedTo, user.displayName) || samePerson(task.assignedBy, user.displayName);
}

// In-app task notifications are stored in the same database as tasks.
// Names can change; recipient and actor IDs are the authoritative identities.
function taskEventRecipient(db, task, kind) {
  const id = kind === 'assigned' ? task.assignedUserId : task.assignedByUserId;
  const name = kind === 'assigned' ? task.assignedTo : task.assignedBy;
  return (db.users || []).find(u => u.id === id) ||
    (db.users || []).find(u => samePerson(u.displayName, name) && u.accountEnabled !== false) || null;
}

function addTaskNotification(db, task, kind, actor) {
  const recipient = taskEventRecipient(db, task, kind);
  if (!recipient || recipient.accountEnabled === false) return false;
  if (kind === 'assigned' && actor && actor.id === recipient.id) return false;
  if (kind !== 'assigned' && actor && actor.id === recipient.id) return false;
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const action = kind === 'opened' ? 'opened' : kind === 'closed' ? 'closed' : kind === 'reassigned' ? 'assigned' : 'assigned';
  const title = kind === 'opened' ? 'Your assigned task was opened' :
    kind === 'closed' ? 'Your assigned task was closed' : 'New task assigned to you';
  const actorName = actor ? String(actor.displayName || actor.username || 'An employee') : 'An employee';
  db.notifications.unshift({
    id: crypto.randomUUID(), userId: recipient.id, taskId: String(task.id),
    type: 'task_' + kind, title,
    message: actorName + ' ' + action + ' “' + String(task.title || task.id).slice(0, 120) + '”.' + (kind === 'closed' ? ' Status: ' + String(task.status || 'Closed') + '.' : ''),
    link: '/tasks/view?id=' + encodeURIComponent(String(task.id)),
    createdAt: new Date().toISOString(), readAt: null
  });
  // Trim only read messages. Unread notifications must not be dropped.
  const unread = db.notifications.filter(n => !n.readAt);
  const read = db.notifications.filter(n => n.readAt).slice(0, 400);
  db.notifications = [...unread, ...read].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return true;
}

function notificationFeed(db, user) {
  const own = (db.notifications || []).filter(n => n.userId === user.id);
  return { unread: own.filter(n => !n.readAt).length, notifications: own.slice(0, 80).map(n => ({
    id: n.id, type: n.type, title: n.title, message: n.message,
    createdAt: n.createdAt, readAt: n.readAt || null, link: n.link
  })) };
}

function taskStatusClosedLike(status) {
  const s = String(status || '').toLowerCase();
  return s === 'completed' || s === 'closed' || s === 'cancelled' || s === 'approved' || s === 'resolved';
}

function delayCategoryForTask(task) {
  const text = `${task.title || ''} ${task.taskType || ''} ${task.category || ''} ${task.nextAction || ''}`.toLowerCase();
  if (text.includes('nxp') || text.includes('documentation') || text.includes('document')) return 'Documentation / NXP Delay';
  if (text.includes('truck') || text.includes('transport') || text.includes('logistics') || text.includes('port')) return 'Transport / Truck Delay';
  if (text.includes('approval') || text.includes('decision')) return 'Executive Approval Delay';
  if (text.includes('quality')) return 'Quality Issue';
  if (text.includes('supplier') || text.includes('procurement') || text.includes('sourcing')) return 'Supplier Delay';
  return 'Internal Staff Delay';
}

function impactAreaForTask(task) {
  const text = `${task.title || ''} ${task.taskType || ''} ${task.impactIfDelayed || ''}`.toLowerCase();
  if (text.includes('quality')) return 'Quality';
  if (text.includes('cash') || text.includes('payment') || text.includes('fund')) return 'Cash Exposure';
  if (text.includes('document') || text.includes('nxp')) return 'Documentation';
  if (text.includes('buyer')) return 'Buyer Trust';
  if (text.includes('port') || text.includes('freight')) return 'Port / Freight';
  return 'Timeline';
}

function taskDelayTrigger(task) {
  if (!task || taskStatusClosedLike(task.status)) return false;
  const status = String(task.status || '').toLowerCase();
  return status === 'blocked' || status === 'delayed' || isOverdue(task);
}

function automatedDelayDescription(task) {
  const reason = isOverdue(task) ? `Task is overdue since ${fmtDate(task.dueDate)}.` : `Task is marked ${task.status}.`;
  return `${reason} ${task.title || 'Task'} requires follow-up before the project can continue.`;
}

function ensureAutomatedDelayForTask(db, task, actor = null) {
  if (!task || !task.projectId || !taskDelayTrigger(task)) return false;
  const project = (db.projects || []).find(p => p.id === task.projectId);
  const nowDate = todayDate();
  let delay = (db.delays || []).find(d => d.autoGenerated && d.relatedTaskId === task.id && !isClosed(d.status));
  let changed = false;
  if (!delay) {
    delay = {
      id: nextSequenceId(db.delays || [], 'D'),
      dateRaised: nowDate,
      projectId: task.projectId,
      projectName: project ? project.name : (task.projectName || ''),
      relatedTaskId: task.id,
      autoGenerated: true,
      automationSource: 'task_status_engine',
      category: delayCategoryForTask(task),
      description: automatedDelayDescription(task),
      responsibleParty: task.assignedTo || '',
      escalationOwner: task.assignedBy || project?.sponsor || 'AKIN',
      severity: isOverdue(task) || String(task.priority || '').toLowerCase() === 'critical' ? 'Critical' : 'High',
      status: 'Open',
      requiredAction: task.nextAction || 'Owner must resolve blocker, update task, or request escalation.',
      dueDate: task.dueDate || nowDate,
      impactArea: impactAreaForTask(task),
      impactDescription: task.impactIfDelayed || project?.impactIfDelayed || 'May affect project timeline and handoff readiness.',
      escalationLevel: 'Auto - Management Attention',
      resolution: '',
      resolvedDate: null
    };
    db.delays = db.delays || [];
    db.delays.unshift(delay);
    changed = true;
  } else {
    const updates = {
      projectName: project ? project.name : (task.projectName || delay.projectName || ''),
      category: delayCategoryForTask(task),
      description: automatedDelayDescription(task),
      responsibleParty: task.assignedTo || delay.responsibleParty || '',
      severity: isOverdue(task) || String(task.priority || '').toLowerCase() === 'critical' ? 'Critical' : 'High',
      requiredAction: task.nextAction || delay.requiredAction || 'Owner must resolve blocker, update task, or request escalation.',
      dueDate: task.dueDate || delay.dueDate,
      impactArea: impactAreaForTask(task),
      impactDescription: task.impactIfDelayed || project?.impactIfDelayed || delay.impactDescription || '',
      status: isClosed(delay.status) ? 'Open' : delay.status
    };
    for (const [key, value] of Object.entries(updates)) {
      if (delay[key] !== value) { delay[key] = value; changed = true; }
    }
  }
  changed = ensureRiskFromDelay(db, delay, actor) || changed;
  return changed;
}

function closeAutomatedDelayForTask(db, task, actor = null) {
  if (!task || !task.id) return false;
  db.delays = db.delays || [];
  db.risks = db.risks || [];
  const linkedDelayIds = new Set(db.delays
    .filter(delay => delay.autoGenerated && delay.relatedTaskId === task.id)
    .map(delay => delay.id));
  if (!linkedDelayIds.size) return false;
  const beforeDelays = db.delays.length;
  const beforeRisks = db.risks.length;
  db.delays = db.delays.filter(delay => !linkedDelayIds.has(delay.id));
  db.risks = db.risks.filter(risk => !linkedDelayIds.has(risk.relatedDelayId));
  return beforeDelays !== db.delays.length || beforeRisks !== db.risks.length;
}

function purgeResolvedDelayRiskRecords(db) {
  db.delays = db.delays || [];
  db.risks = db.risks || [];
  const resolvedDelayIds = new Set(db.delays
    .filter(delay => isClosed(delay.status))
    .map(delay => delay.id));
  const beforeDelays = db.delays.length;
  const beforeRisks = db.risks.length;
  db.delays = db.delays.filter(delay => !isClosed(delay.status));
  db.risks = db.risks.filter(risk => !isClosed(risk.status) && !resolvedDelayIds.has(risk.relatedDelayId));
  return beforeDelays !== db.delays.length || beforeRisks !== db.risks.length;
}

function ensureRiskFromDelay(db, delay, actor = null) {
  if (!delay || !delay.projectId || isClosed(delay.status)) return false;
  const project = (db.projects || []).find(p => p.id === delay.projectId);
  let risk = (db.risks || []).find(r => r.autoGenerated && r.relatedDelayId === delay.id && !isClosed(r.status));
  const likelihood = String(delay.severity || '').toLowerCase().includes('critical') ? 4 : 3;
  const impact = String(delay.severity || '').toLowerCase().includes('critical') ? 5 : 4;
  const score = likelihood * impact;
  let changed = false;
  if (!risk) {
    risk = {
      id: nextSequenceId(db.risks || [], 'R'),
      dateIdentified: todayDate(),
      projectId: delay.projectId,
      projectName: project ? project.name : (delay.projectName || ''),
      relatedDelayId: delay.id,
      relatedTaskId: delay.relatedTaskId || null,
      autoGenerated: true,
      automationSource: 'delay_risk_engine',
      issue: `Risk created from delay ${delay.id}: ${delay.description || 'Operational delay'}`,
      type: 'Issue',
      category: delay.category && String(delay.category).includes('Documentation') ? 'Documentation' : (delay.category && String(delay.category).includes('Transport') ? 'Logistics' : 'Operational'),
      owner: delay.escalationOwner || delay.responsibleParty || '',
      likelihood,
      impact,
      score,
      heatMap: riskBand(score),
      earlyWarning: delay.description || '',
      mitigation: delay.requiredAction || 'Resolve linked delay and update task status.',
      contingency: 'Escalate to project sponsor if the delay remains open past due date.',
      dueDate: delay.dueDate || todayDate(),
      status: 'Open',
      escalationRequired: 'Yes',
      evidenceLink: '',
      resolution: ''
    };
    db.risks = db.risks || [];
    db.risks.unshift(risk);
    changed = true;
  } else {
    const updates = {
      projectName: project ? project.name : (delay.projectName || risk.projectName || ''),
      issue: `Risk created from delay ${delay.id}: ${delay.description || 'Operational delay'}`,
      owner: delay.escalationOwner || delay.responsibleParty || risk.owner || '',
      likelihood,
      impact,
      score,
      heatMap: riskBand(score),
      earlyWarning: delay.description || risk.earlyWarning || '',
      mitigation: delay.requiredAction || risk.mitigation || '',
      dueDate: delay.dueDate || risk.dueDate,
      status: isClosed(risk.status) ? 'Open' : risk.status
    };
    for (const [key, value] of Object.entries(updates)) {
      if (risk[key] !== value) { risk[key] = value; changed = true; }
    }
  }
  return changed;
}

function syncDelayRiskAutomation(db, actor = null) {
  let changed = false;
  db.delays = db.delays || [];
  for (const task of db.tasks || []) {
    if (taskDelayTrigger(task)) changed = ensureAutomatedDelayForTask(db, task, actor) || changed;
    else if (taskStatusClosedLike(task.status)) changed = closeAutomatedDelayForTask(db, task, actor) || changed;
  }
  return changed;
}

function migrateNxpChecklistToTasks(db) {
  if (!Array.isArray(db.nxpChecklist) || !db.nxpChecklist.length) return false;
  let changed = false;
  for (const item of db.nxpChecklist) {
    if (!item || item.migratedToTaskId) continue;
    const exists = (db.tasks || []).find(t => t.nxpChecklistId === item.id);
    if (exists) { item.migratedToTaskId = exists.id; changed = true; continue; }
    const id = nextSequenceId(db.tasks || [], 'T');
    const project = (db.projects || []).find(p => p.id === item.projectId);
    db.tasks = db.tasks || [];
    db.tasks.push({
      id,
      dateLogged: item.dateLogged || todayDate(),
      projectId: item.projectId || '',
      projectName: item.projectName || (project ? project.name : ''),
      category: project ? project.category : 'NXP / Documentation',
      taskType: 'NXP / Documentation Checklist',
      title: item.item || 'NXP / Documentation checklist item',
      assignedTo: item.owner || 'WAHEED',
      assignedRole: taskRole(db, item.owner || 'WAHEED'),
      role: taskRole(db, item.owner || 'WAHEED'),
      assignedBy: 'System',
      priority: item.escalationRequired === 'Yes' ? 'High' : 'Medium',
      status: item.status || 'Not Started',
      workflowManaged: false,
      workflowOrder: 0,
      phase: item.requiredByStage || 'Buyer Docs / Payment',
      startDate: null,
      dueDate: item.dueDate || null,
      progress: taskDone({ status: item.status }) ? 1 : 0,
      blocker: item.blocker || '',
      evidenceLink: item.evidenceLink || '',
      nextAction: item.blocker || item.notes || 'Complete NXP/documentation requirement.',
      managerComment: item.notes || '',
      lastUpdateDate: todayDate(),
      impactIfDelayed: item.blocker || 'Delay may affect export documentation and shipment readiness.',
      nxpChecklistId: item.id,
      sourceModule: 'NXP Checklist'
    });
    item.migratedToTaskId = id;
    changed = true;
  }
  return changed;
}

function autoProjectBlocker(db, project, current) {
  const projectId = project.id;
  const openDelay = (db.delays || []).find(d => d.projectId === projectId && !isClosed(d.status));
  if (openDelay) return `${openDelay.description || openDelay.category || 'Open delay'} (${openDelay.id})`;
  const blockedTask = (db.tasks || []).find(t => t.projectId === projectId && ['blocked', 'delayed'].includes(String(t.status || '').toLowerCase()));
  if (blockedTask) return `${blockedTask.title || 'Blocked task'} is ${blockedTask.status} (${blockedTask.id})`;
  const overdueTask = (db.tasks || []).find(t => t.projectId === projectId && isOverdue(t));
  if (overdueTask) return `${overdueTask.title || 'Task'} is overdue (${overdueTask.id})`;
  return current ? 'No blocker recorded; current workflow step is active.' : 'No active blocker.';
}

function autoProjectDecisionRequired(db, project, current) {
  const projectId = project.id;
  const approval = (db.approvals || []).find(a => a.projectId === projectId && !isClosed(a.status));
  if (approval) return `${approval.item || approval.type || 'Approval'} pending with ${approval.approver || 'approver'} (${approval.id})`;
  const escalatedDelay = (db.delays || []).find(d => d.projectId === projectId && !isClosed(d.status) && (String(d.escalationLevel || '').toLowerCase().includes('management') || String(d.escalationLevel || '').toLowerCase().includes('executive')));
  if (escalatedDelay) return `Management decision required on delay ${escalatedDelay.id}: ${escalatedDelay.requiredAction || escalatedDelay.description || ''}`;
  return current ? `No executive decision required now. Next owner: ${current.assignedTo || 'assigned user'} to complete ${current.title || 'current step'}.` : 'No decision required; workflow completed or no active step.';
}

function syncOperationalAutomation(db, actor = null) {
  let changed = false;
  changed = migrateNxpChecklistToTasks(db) || changed;
  changed = syncDelayRiskAutomation(db, actor) || changed;
  for (const project of db.projects || []) {
    changed = syncProjectAutomation(db, project.id, actor, false) || changed;
  }
  return changed;
}

function syncProjectAutomation(db, projectId, actor = null, writeHandoff = true) {
  const project = (db.projects || []).find(p => p.id === projectId);
  if (!project) return false;
  let changed = false;
  const steps = workflowTasks(db, projectId);
  if (!steps.length) {
    const s = projectStats(db, projectId);
    const health = projectHealthFromData(db, project);
    if (project.projectHealth !== health) { project.projectHealth = health; changed = true; }
    if (Number(project.progress || 0) !== s.progress) { project.progress = s.progress; changed = true; }
    const blocker = autoProjectBlocker(db, project, null);
    const decision = autoProjectDecisionRequired(db, project, null);
    if (project.currentBlocker !== blocker) { project.currentBlocker = blocker; changed = true; }
    if (project.decisionRequired !== decision) { project.decisionRequired = decision; changed = true; }
    return changed;
  }

  let firstOpen = steps.find(t => !taskDone(t));
  const active = steps.find(taskActive);
  if (!active && firstOpen) {
    if (taskWaiting(firstOpen)) {
      firstOpen.status = 'Ready';
      firstOpen.workflowStatus = 'Ready';
      firstOpen.readyAt = firstOpen.readyAt || new Date().toISOString();
      firstOpen.nextAction = firstOpen.nextAction || 'Pick up this workflow step and start work.';
      changed = true;
      if (writeHandoff && actor) {
        db.projectHandoffs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), projectId, taskId: firstOpen.id, to: firstOpen.assignedTo, role: firstOpen.assignedRole || taskRole(db, firstOpen.assignedTo), by: actor.displayName || actor.username, note: 'Workflow step is ready for pickup.' });
        db.projectHandoffs = db.projectHandoffs.slice(0, 500);
      }
    }
  }

  const stats = projectStats(db, projectId);
  const current = stats.current;
  const completedAll = steps.length > 0 && steps.every(taskDone);
  const newProgress = steps.length ? stats.completed / steps.length : 0;
  if (Number(project.progress || 0) !== newProgress) { project.progress = newProgress; changed = true; }
  if (current) {
    if (project.currentTaskId !== current.id) { project.currentTaskId = current.id; changed = true; }
    if (project.currentOwner !== current.assignedTo) { project.currentOwner = current.assignedTo; changed = true; }
    const role = current.assignedRole || taskRole(db, current.assignedTo);
    if (project.currentRole !== role) { project.currentRole = role; changed = true; }
    if (project.owner !== current.assignedTo) { project.owner = current.assignedTo; changed = true; }
    if (current.phase && project.phase !== current.phase) { project.phase = current.phase; changed = true; }
    if (project.nextMilestone !== current.title) { project.nextMilestone = current.title; changed = true; }
  } else if (completedAll) {
    if (project.currentTaskId) { project.currentTaskId = null; changed = true; }
    if (project.currentOwner) { project.currentOwner = null; changed = true; }
    if (project.currentRole) { project.currentRole = null; changed = true; }
    if (project.nextMilestone !== 'Project workflow completed') { project.nextMilestone = 'Project workflow completed'; changed = true; }
  }

  const blocker = autoProjectBlocker(db, project, current);
  const decision = autoProjectDecisionRequired(db, project, current);
  if (project.currentBlocker !== blocker) { project.currentBlocker = blocker; changed = true; }
  if (project.decisionRequired !== decision) { project.decisionRequired = decision; changed = true; }

  const newStatus = completedAll ? 'Completed' : (steps.some(t => ['blocked', 'delayed'].includes(String(t.status || '').toLowerCase())) ? 'On Hold' : 'Active');
  if (project.status !== newStatus) { project.status = newStatus; changed = true; }
  const health = projectHealthFromData(db, project);
  if (project.projectHealth !== health) { project.projectHealth = health; changed = true; }
  project.lastWorkflowSyncAt = new Date().toISOString();
  return changed;
}

function workflowTimelineHtml(db, project, user) {
  const steps = workflowTasks(db, project.id);
  if (!steps.length) return '<small>No workflow steps yet.</small>';
  return `<ol class="workflow-steps">${steps.map(step => {
    const cls = taskDone(step) ? 'done' : (isCurrentWorkflowTask(db, step) ? 'current' : 'waiting');
    return `<li class="${cls}"><span>${escapeHtml(step.workflowOrder || '')}</span><div><b>${escapeHtml(step.title || '')}</b><small>${escapeHtml(step.assignedTo || '')} · ${escapeHtml(step.assignedRole || taskRole(db, step.assignedTo))}</small>${pill(step.status, statusClass(step.status))}</div></li>`;
  }).join('')}</ol>`;
}

function workflowStatusOptions(task, user) {
  const status = String(task.status || '').trim();
  const base = task.workflowManaged ? ['Ready', 'In Progress', 'Completed', 'Blocked', 'Delayed'] : ['Not Started', 'In Progress', 'Completed', 'Blocked', 'Delayed', 'Cancelled'];
  const list = [...new Set([status, ...base].filter(Boolean))];
  return list.map(v => formOption(v, v, status)).join('');
}

function dashboardValue(value, type = '') {
  if (value === null || typeof value === 'undefined' || value === '') return '0';
  const n = Number(value);
  if (type === 'percent') return Number.isFinite(n) ? fmtPercent(n > 1 ? n / 100 : n) : escapeHtml(value);
  if (type === 'score') return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : escapeHtml(value);
  if (Number.isFinite(n)) {
    if (Math.abs(n) > 0 && Math.abs(n) < 1 && type !== 'number') return fmtPercent(n);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  }
  return escapeHtml(value);
}

function dashboardKpi(db, label) {
  const kpis = (db.weeklyOperationsDashboard && db.weeklyOperationsDashboard.kpis) || [];
  const wanted = String(label || '').toLowerCase();
  return kpis.find(k => String(k.label || '').toLowerCase() === wanted) || { label, value: 0, target: '' };
}

function dashboardFlagClass(flag) {
  const text = String(flag || '').toLowerCase();
  if (text.includes('on track') || text.includes('strong') || text.includes('full')) return 'good';
  if (text.includes('attention') || text.includes('follow') || text.includes('partial') || text.includes('developing')) return 'warn';
  if (text.includes('overdue') || text.includes('blocked') || text.includes('delayed') || text.includes('red')) return 'bad';
  if (text.includes('no open') || text.includes('no data') || text.includes('no record')) return 'muted';
  return 'neutral';
}

function dashboardKpiCard(label, value, target, tone = '') {
  return `<div class="exec-kpi ${tone}"><span>${escapeHtml(label)}</span><strong>${dashboardValue(value, tone === 'percent' ? 'percent' : '')}</strong>${target ? `<small>${escapeHtml(target)}</small>` : ''}</div>`;
}

function executiveDashboard(db, user) {
  syncOperationalAutomation(db, null);
  const users = (db.users || []).filter(u => !isExcludedFromDeliverables(u));
  const taskCount = (db.tasks || []).length;
  const completedCount = (db.tasks || []).filter(t => taskStatusClosedLike(t.status)).length;
  const openCount = (db.tasks || []).filter(t => !taskStatusClosedLike(t.status)).length;
  const overdueCount = (db.tasks || []).filter(isOverdue).length;
  const blockedCount = (db.tasks || []).filter(t => ['blocked','delayed'].includes(String(t.status || '').toLowerCase())).length;
  const openApprovals = (db.approvals || []).filter(a => !isClosed(a.status)).length;
  const openDelays = (db.delays || []).filter(d => !isClosed(d.status)).length;
  const completionRate = taskCount ? completedCount / taskCount : 0;
  const kpiCards = [
    `<a class="exec-kpi link-card" href="/tasks?view=open"><span>Open Tasks</span><strong>${openCount}</strong><small>Active task register</small></a>`,
    `<a class="exec-kpi link-card" href="/tasks?view=closed"><span>Closed Tasks</span><strong>${completedCount}</strong><small>${fmtPercent(completionRate)} completion</small></a>`,
    `<a class="exec-kpi link-card ${overdueCount ? 'danger' : ''}" href="/tasks?view=open"><span>Overdue Tasks</span><strong>${overdueCount}</strong><small>Requires follow-up</small></a>`,
    `<a class="exec-kpi link-card ${blockedCount ? 'danger' : ''}" href="/tasks?view=open"><span>Blocked / Delayed</span><strong>${blockedCount}</strong><small>Auto delay engine active</small></a>`,
    `<a class="exec-kpi link-card" href="/approvals"><span>Open Approvals</span><strong>${openApprovals}</strong><small>Decision queue</small></a>`,
    `<a class="exec-kpi link-card ${openDelays ? 'danger' : ''}" href="/delays"><span>Open Delays</span><strong>${openDelays}</strong><small>Project delay register</small></a>`,
    `<a class="exec-kpi link-card" href="/projects"><span>Projects</span><strong>${(db.projects || []).length}</strong><small>Executive watchlist</small></a>`
  ].join('');

  const weeklyRows = users.map(member => {
    const owned = (db.tasks || []).filter(t => samePerson(t.assignedTo, member.displayName));
    const completed = owned.filter(t => taskStatusClosedLike(t.status)).length;
    const open = owned.filter(t => !taskStatusClosedLike(t.status)).length;
    const overdue = owned.filter(isOverdue).length;
    const blocked = owned.filter(t => ['blocked','delayed'].includes(String(t.status || '').toLowerCase())).length;
    const approvals = (db.approvals || []).filter(a => !isClosed(a.status) && samePerson(a.approver, member.displayName)).length;
    const delays = (db.delays || []).filter(d => !isClosed(d.status) && (samePerson(d.responsibleParty, member.displayName) || samePerson(d.escalationOwner, member.displayName))).length;
    const evidence = owned.length ? owned.filter(t => t.evidenceLink).length / owned.length : 0;
    const note = overdue || blocked || delays ? 'Needs Attention' : (owned.length ? 'On Track' : 'No Open Work');
    return `<tr><td><b>${escapeHtml(member.displayName)}</b><br><small>${escapeHtml(member.role || '')}</small></td><td>${owned.length}</td><td>${completed}</td><td>${fmtPercent(owned.length ? completed / owned.length : 0)}</td><td>${overdue}</td><td>${blocked}</td><td>${fmtPercent(evidence)}</td><td>${approvals}</td><td>${delays}</td><td>${pill(note, dashboardFlagClass(note))}</td></tr>`;
  }).join('') || '<tr><td colspan="10">No staff records found.</td></tr>';

  const accountabilityRows = users.map(member => {
    const owned = (db.tasks || []).filter(t => samePerson(t.assignedTo, member.displayName));
    const assignedBy = (db.tasks || []).filter(t => samePerson(t.assignedBy, member.displayName));
    const open = owned.filter(t => !taskStatusClosedLike(t.status)).length;
    const completed = owned.filter(t => taskStatusClosedLike(t.status)).length;
    const overdue = owned.filter(isOverdue).length;
    const blocked = owned.filter(t => ['blocked','delayed'].includes(String(t.status || '').toLowerCase())).length;
    const flag = overdue || blocked ? 'Action Required' : (open ? 'Monitoring' : 'Clear');
    return `<tr><td><b>${escapeHtml(member.displayName)}</b><br><small>${escapeHtml(member.role || '')}</small></td><td>${open}</td><td>${completed}</td><td>${assignedBy.length}</td><td>${overdue}</td><td>${blocked}</td><td>${pill(flag, dashboardFlagClass(flag))}</td></tr>`;
  }).join('') || '<tr><td colspan="7">No accountability records found.</td></tr>';

  const projectRows = (db.projects || []).map(p => {
    syncProjectAutomation(db, p.id, null, false);
    const s = projectStats(db, p.id);
    const health = currentProjectHealth(db, p);
    const current = s.current;
    return `<tr><td><b>${escapeHtml(p.id)}</b></td><td><b>${escapeHtml(p.name || '')}</b><br><small>${escapeHtml(p.nextMilestone || '')}</small></td><td>${escapeHtml(current ? current.assignedTo : (p.owner || ''))}<br><small>${escapeHtml(current ? (current.assignedRole || '') : (p.currentRole || ''))}</small></td><td>${projectHealthBadge(health)}</td><td>${progressBar(s.progress)}</td><td>${dashboardValue(s.open, 'number')}</td><td>${dashboardValue(s.overdue, 'number')}</td><td>${escapeHtml(p.currentBlocker || '')}</td><td>${escapeHtml(p.decisionRequired || '')}</td></tr>`;
  }).join('') || '<tr><td colspan="9">No project records found.</td></tr>';

  return page('Level 5 Executive Dashboard', `
    <section class="executive-hero">
      <div>
        <span class="eyebrow">Level 5 live dashboard</span>
        <h1>Weekly Operations Dashboard</h1>
        <p>This executive dashboard updates automatically from projects, tasks, delays, approvals, and workflow handoffs. It is restricted to Level 5 users.</p>
      </div>
      <div class="executive-week-card"><span>Automation Status</span><strong>Live</strong><small>Task completion, closure, reassignment, delay changes recalculate on each page load.</small></div>
    </section>
    <section class="exec-kpi-grid">${kpiCards}</section>
    <section class="grid two executive-grid">
      <div class="panel executive-panel"><div class="section-title-row"><div><h2>Weekly Staff Operations</h2><p>Live staff productivity, evidence, blockers and delays.</p></div><span class="section-badge">Level 5 only</span></div><div class="table-wrap"><table class="dashboard-table compact"><thead><tr><th>Employee</th><th>Tasks</th><th>Done</th><th>Completion</th><th>Overdue</th><th>Blocked</th><th>Evidence</th><th>Approvals</th><th>Delays</th><th>Note</th></tr></thead><tbody>${weeklyRows}</tbody></table></div></div>
      <div class="panel executive-panel"><div class="section-title-row"><div><h2>Accountability Register</h2><p>Owner-level responsibility register generated from live task ownership.</p></div><span class="section-badge">Confidential</span></div><div class="table-wrap"><table class="dashboard-table compact"><thead><tr><th>Owner</th><th>Open Tasks</th><th>Completed</th><th>Assigned By User</th><th>Overdue</th><th>Blocked</th><th>Flag</th></tr></thead><tbody>${accountabilityRows}</tbody></table></div></div>
    </section>
    <section class="panel executive-panel"><div class="section-title-row"><div><h2>Executive Project Watchlist</h2><p>Auto blocker, decision required, handoff owner, progress and project health.</p></div><a class="button secondary" href="/projects">Open Projects</a></div><div class="table-wrap"><table class="dashboard-table"><thead><tr><th>Project</th><th>Milestone</th><th>Current Owner</th><th>Health</th><th>Progress</th><th>Open</th><th>Overdue</th><th>Current Blocker</th><th>Decision Required</th></tr></thead><tbody>${projectRows}</tbody></table></div></section>
  `, user);
}

function standardDashboard(db, user) {
  syncOperationalAutomation(db, null);
  const ownedTasks = (db.tasks || []).filter(t => samePerson(t.assignedTo, user.displayName));
  const createdTasks = (db.tasks || []).filter(t => samePerson(t.assignedBy, user.displayName));
  const openTasks = ownedTasks.filter(t => !isClosed(t.status));
  const readySteps = ownedTasks.filter(t => t.workflowManaged && isCurrentWorkflowTask(db, t) && !taskDone(t));
  const overdue = ownedTasks.filter(isOverdue).length;
  const completed = ownedTasks.filter(t => taskStatusClosedLike(t.status)).length;
  const myClosedTasks = completed;
  const filesVisible = (db.files || []).filter(f => canSeeTaskFile(db, user, f)).length;
  const today = localDate(new Date(), db);
  const openClock = isTimeClockUser(user) ? openAttendanceRecord(db, user.id) : null;
  const todayWorkMs = isTimeClockUser(user) ? userDailyAttendanceMs(db, user.id, today) : 0;
  const myProjectIds = [...new Set(ownedTasks.concat(createdTasks).map(t => t.projectId).filter(Boolean))];
  const myProjects = (db.projects || []).filter(p => myProjectIds.includes(p.id));

  const focusCards = readySteps.concat(openTasks.filter(t => !readySteps.some(r => r.id === t.id))).slice(0, 5).map(t => {
    const project = (db.projects || []).find(p => p.id === t.projectId);
    return `<article class="task-focus-card"><div><span>${escapeHtml(t.id)}</span>${t.workflowManaged ? pill('Workflow Step', 'info') : pill(t.taskType || 'Task', 'neutral')}</div><h3>${escapeHtml(t.title || '')}</h3><p>${escapeHtml(project ? project.name : (t.projectName || t.projectId || ''))}</p><div class="task-focus-meta"><span>${pill(t.status, statusClass(t.status))}</span><span>Due ${escapeHtml(fmtDate(t.dueDate) || 'Not set')}</span></div><a class="button secondary" href="/tasks?view=open">Open Task</a></article>`;
  }).join('') || `<div class="empty-state"><h3>No urgent task assigned</h3><p>Your open work will appear here once a task or workflow step is handed to you.</p></div>`;

  const projectCards = myProjects.slice(0, 4).map(p => {
    const s = projectStats(db, p.id);
    const health = currentProjectHealth(db, p);
    return `<article class="project-card polished"><div class="project-head"><h3>${escapeHtml(p.name || '')}</h3>${projectHealthBadge(health)}</div><p><b>Next milestone:</b> ${escapeHtml(p.nextMilestone || '')}</p>${progressBar(s.progress)}</article>`;
  }).join('') || `<div class="empty-state"><h3>No project assignment yet</h3><p>When you are added to a project workflow or assigned a task, project cards will show here.</p></div>`;

  const clockMetric = isTimeClockUser(user) ? metric('Today Work Hours', formatDuration(todayWorkMs), openClock ? `Clocked in ${formatLocalTime(openClock.clockInAt, db)}` : 'Not clocked in') : metric('Time Clock', 'Excluded', 'No time clock required for this user');
  const teamOps = Number(user.clearance || 1) >= 3 ? `<section class="panel"><div class="section-title-row"><div><h2>Management Snapshot</h2><p>Clickable shortcuts into operational control sections. Full weekly accountability dashboard is Level 5 only.</p></div></div><section class="metrics slim clickable-metrics"><a class="metric link-card" href="/delays"><span>Open Delays</span><strong>${(db.delays || []).filter(d => !isClosed(d.status)).length}</strong><small>Delay tracker</small></a><a class="metric link-card" href="/approvals"><span>Pending Approvals</span><strong>${(db.approvals || []).filter(a => !isClosed(a.status)).length}</strong><small>Approval queue</small></a><a class="metric link-card" href="/projects"><span>Projects</span><strong>${(db.projects || []).length}</strong><small>Project register</small></a><a class="metric link-card" href="/tasks?view=open"><span>My Task View</span><strong>${ownedTasks.length}</strong><small>Assigned work only</small></a></section></section>` : '';

  return page('Dashboard', `
    <section class="executive-hero standard-hero">
      <div>
        <span class="eyebrow">My workspace</span>
        <h1>Welcome, ${escapeHtml(user.displayName)}</h1>
        <p>This dashboard focuses on your assigned tasks, handoffs, work hours and available files.</p>
      </div>
      <div class="executive-week-card"><span>Clearance</span><strong>${escapeHtml(clearanceName(user.clearance))}</strong><small>${escapeHtml(user.role || '')}</small></div>
    </section>
    <section class="metrics">
      <a class="metric link-card" href="/tasks?view=open"><span>My Open Tasks</span><strong>${openTasks.length}</strong><small>Assigned to me</small></a>
      <a class="metric link-card" href="/tasks?view=open"><span>Ready Workflow Steps</span><strong>${readySteps.length}</strong><small>Ready for pickup</small></a>
      <a class="metric link-card" href="/tasks?view=open"><span>My Overdue Tasks</span><strong>${overdue}</strong><small>${completed} completed</small></a>
      <a class="metric link-card" href="/tasks?view=closed"><span>My Closed Tasks</span><strong>${myClosedTasks}</strong><small>Completed/closed tasks</small></a>
      ${clockMetric}
      ${metric('My Projects', myProjectIds.length, 'Assigned portfolio')}
      <a class="metric link-card" href="/tasks"><span>Task Files</span><strong>${filesVisible}</strong><small>Open tasks to view files</small></a>
    </section>
    <section class="grid two">
      <div class="panel"><div class="section-title-row"><div><h2>My Active Work</h2><p>Workflow steps and open tasks assigned to you.</p></div><a class="button secondary" href="/tasks">View Tasks</a></div><div class="task-focus-grid">${focusCards}</div></div>
      <div class="panel"><div class="section-title-row"><div><h2>My Project Handoffs</h2><p>Projects where your assigned tasks are part of the workflow.</p></div><a class="button secondary" href="/projects">View Projects</a></div><div class="cards">${projectCards}</div></div>
    </section>
    ${teamOps}
  `, user);
}

function dashboard(db, user) {
  if (Number(user.clearance || 0) >= 5) return executiveDashboard(db, user);
  return standardDashboard(db, user);
}

function workflowStepRowHtml(db, idx, step = {}) {
  const canRemove = idx > 1 ? '<button type="button" class="button ghost workflow-remove" onclick="removeWorkflowStep(this)">Remove</button>' : '<span class="workflow-required">First step</span>';
  return `<div class="workflow-builder-row" data-step-row="${idx}"><label>Step ${idx} Task<input name="stepTitle${idx}" value="${escapeAttr(step.title || '')}" placeholder="Describe the handoff deliverable"></label><label>Assigned User${employeeInputHtml(db, `stepAssignee${idx}`, step.assignee || '')}</label><label>Due Date<input type="date" name="stepDue${idx}" value="${escapeAttr(step.dueDate || '')}"></label><div class="workflow-row-action">${canRemove}</div></div>`;
}

function workflowCreationFields(db) {
  const defaults = [
    { title: 'Sourcing confirmation', assignee: 'DIPO' },
    { title: 'Quality check and evidence upload', assignee: 'DIPO' },
    { title: 'Documentation / NXP preparation', assignee: 'BOLA' },
    { title: 'Management review and approval', assignee: 'AKIN' },
    { title: 'Logistics / port handover', assignee: 'DIPO' },
    { title: 'Final close-out and lessons learned', assignee: 'ONAOPE' }
  ];
  return `<div class="workflow-builder wide" id="workflowBuilder"><h3>Project Workflow / Handoff Steps</h3><p>Use this for projects that move sequentially from one person to another. Step 1 becomes ready first; when it is completed, the next step becomes ready.</p><input type="hidden" id="workflowStepCount" name="workflowStepCount" value="${defaults.length}"><div id="workflowStepRows">${defaults.map((step, idx) => workflowStepRowHtml(db, idx + 1, step)).join('')}</div><div class="workflow-builder-actions"><button type="button" class="button secondary" onclick="addWorkflowStep()">+ Add another workflow step</button><small>Level 5 manages workflow steps. Choose No Workflow for normal projects.</small></div><script>
(function () {
  function refreshWorkflowMode() {
    var mode = document.getElementById('projectMode');
    var builder = document.getElementById('workflowBuilder');
    if (!mode || !builder) return;
    var workflow = mode.value !== 'standard';
    builder.style.display = workflow ? '' : 'none';
    builder.querySelectorAll('input, select, textarea').forEach(function (field) {
      if (field.id === 'workflowStepCount') return;
      field.disabled = !workflow;
    });
  }
  window.addWorkflowStep = function () {
    var counter = document.getElementById('workflowStepCount');
    var wrapper = document.getElementById('workflowStepRows');
    if (!counter || !wrapper) return;
    var next = Number(counter.value || 0) + 1;
    counter.value = String(next);
    var row = document.createElement('div');
    row.className = 'workflow-builder-row';
    row.setAttribute('data-step-row', String(next));
    row.innerHTML = '<label>Step ' + next + ' Task<input name="stepTitle' + next + '" placeholder="Describe the handoff deliverable"></label>'
      + '<label>Assigned User<input name="stepAssignee' + next + '" list="employeeList" placeholder="Type or choose an employee"></label>'
      + '<label>Due Date<input type="date" name="stepDue' + next + '"></label>'
      + '<div class="workflow-row-action"><button type="button" class="button ghost workflow-remove" onclick="removeWorkflowStep(this)">Remove</button></div>';
    wrapper.appendChild(row);
    refreshWorkflowMode();
  };
  window.removeWorkflowStep = function (button) {
    var row = button && button.closest ? button.closest('.workflow-builder-row') : null;
    if (row) row.remove();
  };
  window.toggleProjectWorkflow = refreshWorkflowMode;
  document.addEventListener('DOMContentLoaded', refreshWorkflowMode);
  setTimeout(refreshWorkflowMode, 0);
})();
</script></div>`;
}


function workflowStepIndexesFromForm(form) {
  return Object.keys(form || {})
    .map(key => {
      const match = /^stepTitle(\d+)$/.exec(key);
      return match ? Number(match[1]) : null;
    })
    .filter(n => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}


function normalizeChatMessages(db) {
  let changed = false;
  if (!Array.isArray(db.chatMessages)) {
    db.chatMessages = [];
    changed = true;
  }
  db.chatMessages = db.chatMessages.filter(message => {
    const keep = message && message.targetType && message.targetId && message.message;
    if (!keep) changed = true;
    return keep;
  });
  for (const message of db.chatMessages) {
    if (!message.id) { message.id = crypto.randomUUID(); changed = true; }
    if (!message.createdAt) { message.createdAt = new Date().toISOString(); changed = true; }
    if (!message.author) { message.author = message.authorName || message.username || 'Unknown user'; changed = true; }
    if (!message.authorUsername) { message.authorUsername = message.username || ''; changed = true; }
    if (!message.authorRole) { message.authorRole = ''; changed = true; }
    message.targetType = String(message.targetType || '').toLowerCase() === 'task' ? 'task' : 'project';
    message.targetId = String(message.targetId || '').trim();
    message.message = String(message.message || '').trim();
  }
  db.chatMessages.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  return changed;
}

function chatMessagesFor(db, targetType, targetId) {
  return (db.chatMessages || [])
    .filter(message => String(message.targetType || '') === String(targetType || '') && String(message.targetId || '') === String(targetId || ''))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function canViewTaskChat(db, task, user) {
  if (!task || !user) return false;
  if (Number(user.clearance || 1) >= 5) return true;
  return visibleTasks(db, user).some(item => item.id === task.id);
}

function canViewProjectChat(db, project, user) {
  if (!project || !user) return false;
  if (Number(user.clearance || 1) >= 5) return true;
  const userName = String(user.displayName || user.username || '').trim().toLowerCase();
  return (db.tasks || []).some(task => task.projectId === project.id && (
    String(task.assignedTo || '').trim().toLowerCase() === userName ||
    String(task.assignedBy || '').trim().toLowerCase() === userName
  )) || samePerson(project.sponsor, user.displayName) || samePerson(project.createdBy, user.displayName);
}

function safeReturnTo(value, fallback) {
  const target = cleanText(value);
  if (target && target.startsWith('/') && !target.startsWith('//')) return target;
  return fallback;
}

function chatBoxHtml(db, user, targetType, targetId, label = 'Discussion', customReturnTo = '', expanded = false) {
  const messages = chatMessagesFor(db, targetType, targetId);
  const anchor = `chat-${targetType}-${String(targetId || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const returnTo = customReturnTo || (targetType === 'task' ? `/tasks#${anchor}` : `/projects#${anchor}`);
  const thread = messages.length ? messages.map(message => {
    const initials = String(message.author || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
    return `<div class="teams-message">
      <div class="teams-avatar">${escapeHtml(initials)}</div>
      <div class="teams-message-card">
        <div class="teams-message-meta"><b>${escapeHtml(message.author || 'Unknown user')}</b><span>${escapeHtml(message.authorRole || 'Team member')}</span><time>${escapeHtml(formatLocalDateTime(message.createdAt, db))}</time></div>
        <div class="teams-message-body">${escapeHtml(message.message || '').replace(/\n/g, '<br>')}</div>
      </div>
    </div>`;
  }).join('') : '<div class="teams-empty"><b>No conversation yet</b><span>Start a project update, question, handover note, or decision thread.</span></div>';
  return `<details class="chat-box teams-chat" id="${escapeAttr(anchor)}"${expanded ? ' open' : ''}><summary><span>${escapeHtml(label)}</span><small>${messages.length} message${messages.length === 1 ? '' : 's'}</small></summary><div class="teams-thread">${thread}</div><form class="teams-composer" method="post" action="/chat/new"><input type="hidden" name="targetType" value="${escapeAttr(targetType)}"><input type="hidden" name="targetId" value="${escapeAttr(targetId)}"><input type="hidden" name="returnTo" value="${escapeAttr(returnTo)}"><textarea name="message" rows="4" maxlength="2000" placeholder="Type a message, update, question, or handover note..." required></textarea><button class="button small">Send</button></form></details>`;
}


function workflowStepAddForm(db, project, compact = false) {
  return `<details class="${compact ? 'workflow-step-add compact' : 'create-box'}"><summary>Add workflow step - Level 5 only</summary><form class="record-form" method="post" action="/workflow/add-step"><input type="hidden" name="projectId" value="${escapeAttr(project.id)}"><label>Step Title / Deliverable<textarea name="title" required placeholder="What should this person complete before handoff?"></textarea></label><label>Assign To${employeeInputHtml(db, 'assignedTo')}</label><label>Priority<select name="priority">${priorityOptionsHtml(project.priority || 'Medium')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label>Next Action<textarea name="nextAction" placeholder="Instruction for this workflow step"></textarea></label><button class="button">Add Step to Workflow</button></form></details>`;
}

function workflowStepEditHtml(db, step) {
  return `<details class="workflow-step-editor"><summary>Edit step ${escapeHtml(step.workflowOrder || '')}: ${escapeHtml(step.title || '')}</summary><form class="record-form" method="post" action="/workflow/update-step"><input type="hidden" name="id" value="${escapeAttr(step.id)}"><label>Step Order<input type="number" min="1" name="workflowOrder" value="${escapeAttr(step.workflowOrder || 1)}"></label><label>Title / Deliverable<textarea name="title" required>${escapeHtml(step.title || '')}</textarea></label><label>Assigned User${employeeInputHtml(db, 'assignedTo', step.assignedTo || '')}</label><label>Priority<select name="priority">${priorityOptionsHtml(step.priority || 'Medium')}</select></label><label>Due Date<input type="date" name="dueDate" value="${escapeAttr(fmtDate(step.dueDate))}"></label><label class="wide">Instruction / Next Action<textarea name="nextAction">${escapeHtml(step.nextAction || '')}</textarea></label><button class="button">Save Workflow Step</button></form>${deleteButton('/tasks/delete', step.id, 'Delete this workflow step?')}</details>`;
}

function workflowEditorHtml(db, project, user) {
  if (Number(user.clearance || 1) < 5) return '';
  const steps = workflowTasks(db, project.id);
  const rows = steps.length ? steps.map(step => workflowStepEditHtml(db, step)).join('') : '<p class="muted-text">No workflow steps yet. Add one below.</p>';
  return `<details class="workflow-editor-box"><summary>Workflow editor - Level 5 only</summary><p>Edit saved workflow steps, reassign owners, change phases, or add more steps after the project has been saved. Project progress and handoff state will recalculate automatically.</p>${rows}${workflowStepAddForm(db, project, true)}</details>`;
}

function renderProjects(db, user, message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = Number(user.clearance || 1) >= 5 ? `<details class="create-box"><summary>Create new project - Level 5 only</summary><form class="form-grid" method="post" action="/projects/new"><label>Project Type<select id="projectMode" name="projectMode" onchange="toggleProjectWorkflow()"><option value="workflow">Workflow Project - sequential handoff</option><option value="standard">No Workflow - normal project/task tracking</option></select></label><label>Project ID<input name="id" placeholder="Leave blank for auto ID"></label><label>Project Name<input name="name" required></label><label>Project Owner${employeeInputHtml(db, 'owner', 'ONAOPE')}</label><label>Priority<select name="priority">${priorityOptionsHtml('High')}</select></label><label>Start Date<input type="date" name="startDate" value="${todayDate()}"></label><label>Target End Date<input type="date" name="targetEndDate"></label><label class="wide">Business Objective / Notes<textarea name="notes" placeholder="What should this project achieve?"></textarea></label><label class="wide">Impact If Delayed<textarea name="impactIfDelayed"></textarea></label>${workflowCreationFields(db)}<button class="button">Create Project</button></form></details>` : '';
  const canManage = Number(user.clearance || 1) >= 5;
  const bulk = canManage ? `<div class="bulk-actions"><form id="bulkProjects" method="post" action="/projects/delete-selected" onsubmit="return confirm('Delete the selected projects? Projects with active linked records will be protected.');"><button class="button danger-button" type="submit">Delete selected projects</button></form><small>Select one or more projects below. Existing individual Delete controls are unchanged.</small></div>` : '';
  const rows = (db.projects || []).map(p => {
    syncProjectAutomation(db, p.id, null, false);
    const stats = projectStats(db, p.id);
    const health = currentProjectHealth(db, p);
    const current = stats.current;
    const projectType = p.workflowEnabled || workflowTasks(db, p.id).length ? 'Workflow' : 'No Workflow';
    const edit = canManage ? `<details><summary>Edit project details</summary><form class="record-form" method="post" action="/projects/update"><input type="hidden" name="id" value="${escapeAttr(p.id)}"><label>Project Name<input name="name" value="${escapeAttr(p.name)}" required></label><label>Owner${employeeInputHtml(db, 'owner', p.owner || '')}</label><label>Priority<select name="priority">${priorityOptionsHtml(p.priority || 'High')}</select></label><label>Start Date<input type="date" name="startDate" value="${escapeAttr(fmtDate(p.startDate))}"></label><label>Target End Date<input type="date" name="targetEndDate" value="${escapeAttr(fmtDate(p.targetEndDate))}"></label><label class="wide">Impact If Delayed<textarea name="impactIfDelayed">${escapeHtml(p.impactIfDelayed || '')}</textarea></label><label class="wide">Notes<textarea name="notes">${escapeHtml(p.notes || '')}</textarea></label><button class="button">Save Project Details</button></form>${deleteButton('/projects/delete', p.id, 'Delete this project? Linked records should be moved first.')}</details>` : '';
    const workflowEditor = workflowEditorHtml(db, p, user);
    const projectChat = canViewProjectChat(db, p, user) ? chatBoxHtml(db, user, 'project', p.id, 'Project chat') : '';
    const workflowView = workflowTasks(db, p.id).length ? workflowTimelineHtml(db, p, user) : '<small>No workflow attached. Manage work through normal assigned tasks.</small>';
    const selectCell = canManage ? `<td><input type="checkbox" name="ids" value="${escapeAttr(p.id)}" form="bulkProjects" aria-label="Select project ${escapeAttr(p.id)}"></td>` : '';
    return `<tr>${selectCell}<td>${escapeHtml(p.id)}<br><small>${escapeHtml(projectType)}</small></td><td><b>${escapeHtml(p.name)}</b>${edit}${workflowEditor}${projectChat}</td><td>${current ? `<b>${escapeHtml(current.assignedTo || '')}</b><br><small>${escapeHtml(current.assignedRole || '')}</small>` : escapeHtml(p.owner || '')}</td><td>${projectHealthBadge(health)}</td><td>${pill(p.priority, priorityClass(p.priority))}</td><td>${pill(p.status, statusClass(p.status))}</td><td>${progressBar(stats.progress)}</td><td>${escapeHtml(fmtDate(p.targetEndDate))}</td><td><b>${escapeHtml(current ? current.title : (p.nextMilestone || ''))}</b><br><small><b>Blocker:</b> ${escapeHtml(p.currentBlocker || 'Auto updated')}</small><br><small><b>Decision:</b> ${escapeHtml(p.decisionRequired || 'Auto updated')}</small><br>${workflowView}</td></tr>`;
  }).join('') || `<tr><td colspan="${canManage ? 10 : 9}">No projects yet.</td></tr>`;
  return page('Projects', `<div class="panel"><h1>Project Register</h1><p>Level 5 can create and edit workflow or normal projects. Progress, blocker, decision required and health are calculated automatically from work records.</p>${notice}${create}${bulk}<div class="table-wrap"><table><thead><tr>${canManage ? '<th>Select</th>' : ''}<th>ID / Type</th><th>Project</th><th>Current Owner / Role</th><th>Health</th><th>Priority</th><th>Status</th><th>Progress</th><th>Target End</th><th>Workflow / Auto Snapshot</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}


function taskTimerEntries(db, taskId) {
  return (db.taskTimeEntries || []).filter(entry => entry.taskId === taskId);
}

function timeEntryElapsedMs(entry, now = Date.now()) {
  const started = Date.parse(entry.startedAt || '');
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Number(entry.elapsedMs || (Date.parse(entry.stoppedAt || '') - started) || 0) || (entry.stoppedAt ? 0 : now - started));
}

function stopRunningUserTimers(db, userId, at = new Date()) {
  let changed = false;
  for (const entry of db.taskTimeEntries || []) {
    if (entry.userId !== userId || entry.stoppedAt) continue;
    entry.stoppedAt = at.toISOString();
    entry.elapsedMs = Math.max(0, at.getTime() - new Date(entry.startedAt).getTime());
    entry.status = 'stopped';
    changed = true;
  }
  return changed;
}

function stopTaskTimersForTask(db, taskId, at = new Date()) {
  let changed = false;
  for (const entry of db.taskTimeEntries || []) {
    if (entry.taskId !== taskId || entry.stoppedAt) continue;
    entry.stoppedAt = at.toISOString();
    entry.elapsedMs = Math.max(0, at.getTime() - new Date(entry.startedAt).getTime());
    entry.status = 'stopped';
    changed = true;
  }
  return changed;
}

function taskTimerHtml(db, user, task) {
  const entries = taskTimerEntries(db, task.id);
  const own = entries.filter(entry => entry.userId === user.id);
  const running = own.find(entry => !entry.stoppedAt);
  const activeElsewhere = (db.taskTimeEntries || []).find(entry => entry.userId === user.id && !entry.stoppedAt && entry.taskId !== task.id);
  const stoppedMs = entries.filter(entry => entry.stoppedAt).reduce((n, entry) => n + timeEntryElapsedMs(entry), 0);
  const ownStoppedMs = own.filter(entry => entry.stoppedAt).reduce((n, entry) => n + timeEntryElapsedMs(entry), 0);
  const runningStarts = entries.filter(entry => !entry.stoppedAt).map(entry => entry.startedAt).join(',');
  const button = taskStatusClosedLike(task.status) ? '<small>This task is closed; its time log is preserved.</small>'
    : !taskAssignableByUser(task, user) ? ''
    : running ? `<form method="post" action="/tasks/timer/stop"><input type="hidden" name="id" value="${escapeAttr(task.id)}"><button class="button timer-stop" type="submit">■ Stop Timer</button></form>`
    : activeElsewhere ? `<small>Stop your timer on ${escapeHtml(activeElsewhere.taskId)} before starting another.</small>`
    : `<form method="post" action="/tasks/timer/start"><input type="hidden" name="id" value="${escapeAttr(task.id)}"><button class="button timer-start" type="submit">▶ Start Timer</button></form>`;
  const logs = (Number(user.clearance || 1) >= 5 ? entries : own).slice(0, 30).map(entry => `<tr><td>${escapeHtml(entry.displayName || '')}</td><td>${escapeHtml(formatLocalDateTime(entry.startedAt, db))}</td><td>${escapeHtml(entry.stoppedAt ? formatLocalDateTime(entry.stoppedAt, db) : 'Running')}</td><td>${escapeHtml(formatDuration(timeEntryElapsedMs(entry)))}</td></tr>`).join('');
  return `<div class="task-timer"><b>Task Timer</b><span class="task-timer-counter" data-base-ms="${stoppedMs}" data-active-starts="${escapeAttr(runningStarts)}">${escapeHtml(formatDuration(stoppedMs))}</span><small>Team total · Your completed time: ${escapeHtml(formatDuration(ownStoppedMs))}</small>${button}${logs ? `<details><summary>View time entries (${Number(user.clearance || 1) >= 5 ? entries.length : own.length})</summary><div class="table-wrap"><table class="timer-log-table"><thead><tr><th>Employee</th><th>Started</th><th>Stopped</th><th>Time</th></tr></thead><tbody>${logs}</tbody></table></div></details>` : ''}</div>`;
}

function taskEditForm(task, user, db = null) {
  const canEdit = taskAssignableByUser(task, user);
  const isCurrent = db ? isCurrentWorkflowTask(db, task) : true;
  if (!canEdit) return '';
  if (task.workflowManaged && Number(user.clearance || 1) < 5 && samePerson(task.assignedTo, user.displayName) && !isCurrent) return '<small class="muted">Waiting for earlier workflow step to finish.</small>';
  const canWorkNow = Number(user.clearance || 1) >= 5 || !task.workflowManaged || isCurrent || samePerson(task.assignedBy, user.displayName);
  if (!canWorkNow) return '';
  const completeLabel = task.workflowManaged ? 'Complete & Hand Over' : 'Save Task Update';
  const assigneeField = (!task.workflowManaged || Number(user.clearance || 1) >= 5) ? `<label>Reassign To${employeeInputHtml(db, 'assignedTo', task.assignedTo || '')}</label>` : '';
  const taskTypeField = !task.workflowManaged ? `<label>Task Type<select name="taskType">${taskTypeOptionsHtml(task.taskType || 'General Task')}</select></label>` : '';
  return `<details><summary>${task.workflowManaged ? 'Work on step' : 'Update task'}</summary><form class="mini-form" method="post" action="/tasks/update"><input type="hidden" name="id" value="${escapeAttr(task.id)}" />${assigneeField}${taskTypeField}<label>Status<select name="status">${workflowStatusOptions(task, user)}</select></label><label>Progress %<input name="progress" type="number" min="0" max="100" value="${Math.round(Number(task.progress || 0) * 100)}" /></label><label class="wide">Work Note / Next Action<input name="nextAction" placeholder="What changed or what should happen next?" value="${escapeAttr(task.nextAction || '')}" /></label><label class="wide">Task Comment / Work Notes<textarea name="comments" rows="3" placeholder="Leave a work comment, handover note, or reason for closure">${escapeHtml(task.comments || task.managerComment || '')}</textarea></label><button>${completeLabel}</button></form>${((task.workflowManaged && user.clearance >= 5) || (!task.workflowManaged && taskAssignableByUser(task, user))) ? deleteButton('/tasks/delete', task.id, 'Delete this task?') : ''}</details>`;
}

// File records remain stored in db.files, but all file controls live inside Tasks.
function canSeeTaskFile(db, user, file) {
  if (Number(user.clearance || 1) < Number(file.requiredClearance || 1)) return false;
  const stillLinked = Boolean(file.taskId && (db.tasks || []).some(task => String(task.id) === String(file.taskId)));
  if (!stillLinked) {
    if (!file.wasTaskAttached) return true; // Historical project/general files retain their old clearance rules.
    // Deleted task attachments never become public to everyone merely because the task is gone.
    return Number(user.clearance || 1) >= 5 || file.uploadedByUserId === user.id ||
      (!file.uploadedByUserId && samePerson(file.uploadedBy, user.displayName));
  }
  return visibleTasks(db, user).some(task => String(task.id) === String(file.taskId));
}

function canManageTaskFile(user, file) {
  return Number(user.clearance || 1) >= 3 || file.uploadedByUserId === user.id ||
    (!file.uploadedByUserId && samePerson(file.uploadedBy, user.displayName));
}

function safeAttachmentUrl(raw) {
  try { const url = new URL(String(raw || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; }
  catch (_) { return '#'; }
}

function taskFileEditHtml(user, file) {
  if (!canManageTaskFile(user, file)) return '';
  const levels = [1,2,3,4,5].filter(level => level <= Number(user.clearance || 1))
    .map(level => formOption(level, clearanceName(level), file.requiredClearance || 1)).join('');
  return `<details class="file-edit-details"><summary>Edit file</summary><form class="task-file-upload" action="/files/update" method="post"><input type="hidden" name="id" value="${escapeAttr(file.id)}"><input type="hidden" name="module" value="Task Evidence"><label>Title<input name="title" required value="${escapeAttr(file.title || file.originalName || '')}"></label><label>Access level<select name="requiredClearance">${levels}</select></label><label>Notes<textarea name="notes">${escapeHtml(file.notes || '')}</textarea></label><button type="submit" class="button secondary">Save file</button></form></details>`;
}

function taskFilesHtml(db, user, task, expanded = false) {
  const files = (db.files || []).filter(file => String(file.taskId || '') === String(task.id) && canSeeTaskFile(db, user, file));
  const existing = files.map(file => {
    const link = file.type === 'external-link'
      ? `<a class="link" href="${escapeAttr(safeAttachmentUrl(file.externalUrl))}" target="_blank" rel="noopener">Open</a>`
      : `<a class="link" href="/files/download/${escapeAttr(file.id)}">Download</a>`;
    const controls = canManageTaskFile(user, file) ? `<form method="post" action="/files/delete" onsubmit="return confirm('Delete this task file?');"><input type="hidden" name="id" value="${escapeAttr(file.id)}"><button type="submit" class="button secondary small-danger">Delete</button></form>` : '';
    return `<li><span><b>${escapeHtml(file.title || file.originalName || 'File')}</b><small> · ${escapeHtml(file.uploadedBy || '')} · ${escapeHtml(fmtDate(file.uploadedAt))}</small></span>${link}${taskFileEditHtml(user, file)}${controls}</li>`;
  }).join('') || '<li class="muted">No files attached yet.</li>';
  const clearance = [1,2,3,4,5].filter(n => n <= Number(user.clearance || 1)).map(n=>`<option value="${n}">${escapeHtml(clearanceName(n))}</option>`).join('');
  const upload = `<form class="task-file-upload" method="post" action="/files/upload" enctype="multipart/form-data"><input type="hidden" name="taskId" value="${escapeAttr(task.id)}"><label>Title<input name="title" placeholder="e.g. Shipping invoice, photo evidence" required></label><label>Access level<select name="requiredClearance">${clearance}</select></label><label>Attachment (max 4 MB)<input type="file" name="file" required></label><button type="submit" class="button">Upload to task</button></form>`;
  return `<details class="task-files-panel"${expanded ? ' open' : ''}><summary>Files &amp; Evidence (${files.length})</summary><ul class="task-files-list">${existing}</ul>${upload}</details>`;
}

function unassignedFilesHtml(db, user) {
  const legacy = (db.files || []).filter(f => (!f.taskId || !(db.tasks || []).some(task => String(task.id) === String(f.taskId))) && canSeeTaskFile(db, user, f));
  if (!legacy.length) return '';
  const choices = visibleTasks(db, user).map(t => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.id)} - ${escapeHtml(t.title || '')}</option>`).join('');
  const list = legacy.map(file => {
    const link = file.type === 'external-link' ? `<a class="link" href="${escapeAttr(safeAttachmentUrl(file.externalUrl))}" rel="noopener" target="_blank">Open</a>` : `<a class="link" href="/files/download/${escapeAttr(file.id)}">Download</a>`;
    const attach = canManageTaskFile(user, file) && choices ? `<form method="post" action="/files/attach" class="inline-form"><input type="hidden" name="id" value="${escapeAttr(file.id)}"><select name="taskId" aria-label="Attach to task" required><option value="">Choose task</option>${choices}</select><button type="submit" class="button secondary">Attach to task</button></form>` : '';
    const remove = canManageTaskFile(user, file) ? `<form method="post" action="/files/delete" class="inline-form" onsubmit="return confirm('Permanently delete this unassigned file? This cannot be undone.');"><input type="hidden" name="id" value="${escapeAttr(file.id)}"><button type="submit" class="button danger-button" aria-label="Delete unassigned file ${escapeAttr(file.title || file.originalName || 'File')}">Delete file</button></form>` : '';
    return `<li><b>${escapeHtml(file.title || file.originalName || 'File')}</b>${link}${taskFileEditHtml(user, file)}${attach}${remove}</li>`;
  }).join('');
  return `<details class="task-files-panel legacy-files"><summary>Existing unassigned files (${legacy.length})</summary><p>Previously uploaded files are preserved here. You can attach or permanently delete files you are authorised to manage.</p><ul class="task-files-list">${list}</ul></details>`;
}

// Each task has its own workspace: its own comments and files, never a global files screen.
function taskWorkspaceLink(taskId, tab = 'comments') {
  return `/tasks/view?id=${encodeURIComponent(String(taskId || ''))}&tab=${tab === 'files' ? 'files' : 'comments'}`;
}

function taskDeleteControl(task, user, context = 'list') {
  const allowed = Number(user.clearance || 1) >= 5 || (!task.workflowManaged && taskAssignableByUser(task, user));
  if (!allowed) return '';
  const view = taskStatusClosedLike(task.status) ? 'closed' : 'open';
  return `<form class="task-delete-form" method="post" action="/tasks/delete" onsubmit="return confirm('Delete this task permanently? This cannot be undone. Task files will be retained securely, and time logs remain in the audit history.');"><input type="hidden" name="id" value="${escapeAttr(task.id)}"><input type="hidden" name="view" value="${view}"><label class="sr-only" for="delete-reason-${escapeAttr(task.id)}-${context}">Reason for deletion</label><select id="delete-reason-${escapeAttr(task.id)}-${context}" name="reason" aria-label="Reason for deletion"><option value="Created in error">Created in error</option><option value="No longer needed">No longer needed</option><option value="Duplicate task">Duplicate task</option></select><button type="submit" class="button danger-button">Delete Task</button></form>`;
}

function renderTaskWorkspace(db, user, task, requestedTab = 'comments') {
  const tab = requestedTab === 'files' ? 'files' : 'comments';
  const commentsCount = chatMessagesFor(db, 'task', task.id).length;
  const filesCount = (db.files || []).filter(f => String(f.taskId || '') === String(task.id) && canSeeTaskFile(db, user, f)).length;
  const link = (name, label, count) => `<a href="${escapeAttr(taskWorkspaceLink(task.id,name))}" class="${tab === name ? 'active' : ''}" aria-current="${tab === name ? 'page' : 'false'}">${label} <span>(${count})</span></a>`;
  const thread = tab === 'files'
    ? `<h2>Task Files</h2><p>These attachments belong only to this task. Authorized task participants can upload and download evidence.</p>${taskFilesHtml(db, user, task, true)}`
    : `<h2>Task Comments</h2><p>Discuss updates and handovers with other participants on this task.</p>${chatBoxHtml(db, user, 'task', task.id, 'Comments', taskWorkspaceLink(task.id, 'comments') + '#chat-task-' + String(task.id).replace(/[^a-zA-Z0-9_-]/g, '-'), true)}`;
  const back = taskStatusClosedLike(task.status) ? '/tasks?view=closed' : '/tasks?view=open';
  return page('Task · ' + (task.title || task.id), `<div class="panel task-workspace-page"><div class="task-workspace-heading"><div><a class="link" href="${back}">← Back to ${taskStatusClosedLike(task.status) ? 'Closed' : 'Open'} Tasks</a><h1>${escapeHtml(task.title || 'Task')}</h1><p>${escapeHtml(task.id)} · ${escapeHtml(task.projectName || task.projectId || '')}</p></div>${pill(task.status, statusClass(task.status))}</div>
  <div class="task-workspace-summary"><span><b>Assigned to</b>${escapeHtml(task.assignedTo || 'Unassigned')}</span><span><b>Priority</b>${escapeHtml(task.priority || 'Not set')}</span><span><b>Due date</b>${escapeHtml(fmtDate(task.dueDate) || 'Not set')}</span></div>
  <div class="task-workspace-primary">${taskTimerHtml(db, user, task)}${taskEditForm(task, user, db)}${taskDeleteControl(task, user, 'detail')}</div>
  <nav class="task-workspace-tabs" aria-label="Task workspace tabs">${link('comments', 'Comments', commentsCount)}${link('files', 'Files', filesCount)}</nav>
  <section class="task-workspace-panel">${thread}</section></div>`, user);
}

function renderTasks(db, user, requestedView = 'open', message = '') {
  for (const project of db.projects || []) syncProjectAutomation(db, project.id, null, false);
  const tasks = visibleTasks(db, user).sort((a, b) => String(a.projectId || '').localeCompare(String(b.projectId || '')) || Number(a.workflowOrder || 9999) - Number(b.workflowOrder || 9999));
  const view = String(requestedView || '').toLowerCase() === 'closed' ? 'closed' : 'open';
  const openTasks = tasks.filter(t => !taskStatusClosedLike(t.status));
  const closedTasks = tasks.filter(t => taskStatusClosedLike(t.status));
  const create = (db.projects || []).length
    ? `<details class="create-box"><summary>Create Task</summary><p>Every employee can create a normal task. Workflow steps are managed only by Level 5 from the Projects page.</p><form class="form-grid" method="post" action="/tasks/new"><label>Project<select name="projectId">${projectOptionsHtml(db)}</select></label><label>Task Type<select name="taskType">${taskTypeOptionsHtml('General Task')}</select></label><label>Assign To${employeeInputHtml(db, 'assignedTo', isExcludedFromDeliverables(user) ? '' : user.displayName)}</label><label>Priority<select name="priority">${priorityOptionsHtml('Medium')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label>Status<select name="status">${statusOptionsHtml(['Not Started','In Progress','Completed','Blocked','Delayed','Closed','Cancelled'], 'Not Started')}</select></label><label class="wide">Task / Deliverable<textarea name="title" required></textarea></label><label class="wide">Instruction / Next Action<textarea name="nextAction"></textarea></label><label class="wide">Task Comment / Work Notes<textarea name="comments" placeholder="Optional comment for this task"></textarea></label><label class="wide">Impact If Delayed<textarea name="impactIfDelayed"></textarea></label><button class="button">Create Task</button></form></details>`
    : '<div class="notice muted-notice">Ask a Level 5 administrator to create a project before adding tasks.</div>';
  const visible = view === 'closed' ? closedTasks : openTasks;
  const canDelete = task => Number(user.clearance || 1) >= 5 || (!task.workflowManaged && taskAssignableByUser(task, user));
  const bulk = `<div class="bulk-actions"><form id="bulkTasks" method="post" action="/tasks/delete-selected" onsubmit="return confirm('Delete selected tasks? This cannot be undone and historic time entries will remain.');"><input type="hidden" name="view" value="${view}"><button type="submit" class="button danger-button">Delete selected tasks</button></form><small>Select tasks below. Individual Delete controls remain inside Update Task.</small></div>`;
  const rows = visible.map(t => {
    const workflowBadge = t.workflowManaged ? `<br><small>Workflow Step ${escapeHtml(t.workflowOrder || '')} · ${escapeHtml(t.assignedRole || taskRole(db, t.assignedTo))}</small>` : `<br><small>${escapeHtml(t.taskType || 'General Task')}</small>`;
    const currentMarker = t.workflowManaged && isCurrentWorkflowTask(db, t) && !taskDone(t) ? '<span class="current-step-dot">Current</span>' : '';
    const taskChat = ''; // Task conversations now live in their own task workspace tab.
    const taskComments = t.comments || t.managerComment ? `<div class="task-comments"><b>Comments:</b> ${escapeHtml(t.comments || t.managerComment || '')}</div>` : '';
    const selected = canDelete(t) ? `<input type="checkbox" name="ids" value="${escapeAttr(t.id)}" form="bulkTasks" aria-label="Select task ${escapeAttr(t.id)}">` : '<span class="muted">—</span>';
    const taskActions = `<div class="task-row-actions"><a class="link" href="${escapeAttr(taskWorkspaceLink(t.id, 'comments'))}">Comments (${chatMessagesFor(db, 'task', t.id).length})</a><a class="link" href="${escapeAttr(taskWorkspaceLink(t.id, 'files'))}">Files (${(db.files || []).filter(f => String(f.taskId || '') === String(t.id) && canSeeTaskFile(db, user, f)).length})</a><a class="link" href="${escapeAttr(taskWorkspaceLink(t.id))}">Open Task</a></div>`;
    return `<tr class="${isOverdue(t) ? 'overdue-row' : ''} ${view === 'closed' ? 'closed-task-row' : ''}"><td>${selected}</td><td>${escapeHtml(t.id)}${workflowBadge}</td><td><b>${escapeHtml(t.title)}</b> ${currentMarker}<br><small>${escapeHtml(t.nextAction || '')}</small>${taskComments}${taskActions}${taskTimerHtml(db, user, t)}${taskEditForm(t, user, db)}${taskDeleteControl(t, user, 'list')}${taskChat}</td><td>${escapeHtml(t.projectId)}</td><td>${escapeHtml(t.assignedTo || '')}<br><small>${escapeHtml(t.assignedRole || t.role || '')}</small></td><td>${escapeHtml(t.assignedBy || '')}</td><td>${pill(t.priority, priorityClass(t.priority))}</td><td>${pill(t.status, statusClass(t.status))}</td><td>${progressBar(t.progress)}</td><td>${escapeHtml(fmtDate(t.dueDate))}</td><td>${escapeHtml(t.impactIfDelayed || '')}</td></tr>`;
  }).join('') || '<tr><td colspan="11">No tasks in this view.</td></tr>';
  const tableHead = '<thead><tr><th>Select</th><th>ID / Type</th><th>Task / Deliverable</th><th>Project</th><th>Owner / Role</th><th>Assigned By</th><th>Priority</th><th>Status</th><th>Progress</th><th>Due</th><th>Impact if Delayed</th></tr></thead>';
  const tabs = `<div class="task-filter-tabs"><a class="${view === 'open' ? 'active' : ''}" href="/tasks?view=open">Open Tasks (${openTasks.length})</a><a class="${view === 'closed' ? 'active' : ''}" href="/tasks?view=closed">Closed Tasks (${closedTasks.length})</a></div>`;
  const liveTimerScript = `<script>(function(){function format(ms){const n=Math.floor(Math.max(0,ms)/1000);return String(Math.floor(n/3600)).padStart(2,'0')+':'+String(Math.floor(n%3600/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');}function refresh(){document.querySelectorAll('[data-base-ms]').forEach(function(el){let total=Number(el.dataset.baseMs||0);(el.dataset.activeStarts||'').split(',').filter(Boolean).forEach(function(value){const ts=Date.parse(value);if(Number.isFinite(ts))total+=Math.max(0,Date.now()-ts);});el.textContent=format(total);});}refresh();setInterval(refresh,1000);})();</script>`;
  const alert = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  return page('Tasks', `<div class="panel"><h1>${view === 'closed' ? 'Closed Tasks' : 'Open Tasks'}</h1><p>Only ${view === 'closed' ? 'completed, closed and cancelled' : 'active, pending and blocked'} tasks appear here. Select Closed Tasks to view your task history. Every employee can create tasks.</p>${alert}${tabs}${create}${bulk}<div class="table-wrap"><table>${tableHead}<tbody>${rows}</tbody></table></div>${unassignedFilesHtml(db, user)}</div>${liveTimerScript}`, user);
}


function renderWeeklyReports(db, user, url) {
  const chosenWeek = url.searchParams.get('week') || '';
  const chosenEmployee = url.searchParams.get('employee') || 'all';
  const chosenProject = url.searchParams.get('project') || 'all';
  let report;
  try { report = buildWeeklyReport(db, user, { week: chosenWeek, employee: chosenEmployee, project: chosenProject }); }
  catch (err) { return page('Weekly Reports', `<div class="panel"><h1>Report filter not valid</h1><p>${escapeHtml(err.message)}</p><a href="/reports/weekly" class="button">Reset filters</a></div>`, user); }
  const admin = Number(user.clearance || 1) >= 5;
  const employees = (db.users || []).filter(u => u.accountEnabled !== false && !isExcludedFromDeliverables(u)).sort((a,b) => String(a.displayName).localeCompare(String(b.displayName)));
  const visibleProjects = admin ? (db.projects || []) : (db.projects || []).filter(p => (db.tasks || []).some(t => String(t.projectId) === String(p.id) && (t.assignedUserId === user.id || samePerson(t.assignedTo, user.displayName))));
  const employeeSelect = admin ? `<label>Employee<select name="employee"><option value="all">All employees</option>${employees.map(u => `<option value="${escapeAttr(u.id)}"${report.employee === String(u.id) ? ' selected' : ''}>${escapeHtml(u.displayName)}</option>`).join('')}</select></label>` : '';
  const projectSelect = `<label>Project<select name="project"><option value="all">All projects</option>${visibleProjects.map(p => `<option value="${escapeAttr(p.id)}"${report.project === String(p.id) ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>`;
  const pdfQuery = new URLSearchParams({week:report.monday,employee:report.employee,project:report.project});
  const download = `/reports/weekly.pdf?${pdfQuery.toString()}`;
  const summaries = report.people.map(person => `<tr><td><b>${escapeHtml(person.name)}</b><br><small>${escapeHtml(person.role || '')}</small></td><td>${person.assigned}</td><td>${person.due}</td><td>${person.completed}</td><td>${person.open}</td><td>${person.overdue}</td><td>${person.blocked}</td><td>${formatHours(person.hoursMs)} h</td><td>${person.completionRate}%</td></tr>`).join('') || '<tr><td colspan="9">No employees or deliverables found for this selection.</td></tr>';
  const safeReportLink = value => { try { const target = new URL(String(value)); return ['http:', 'https:'].includes(target.protocol) ? target.href : ''; } catch (_) { return ''; } };
  const detailSections = report.people.map(person => {
    const rows = person.tasks.map(task => `<tr><td><b>${escapeHtml(task.title)}</b><br><small>${escapeHtml(task.id)} · ${escapeHtml(task.project)}</small>${task.nextAction ? `<br><small>Next: ${escapeHtml(task.nextAction)}</small>` : ''}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(prettyDate(task.dueDate))}</td><td>${task.doneWeek ? 'Yes' : '—'}</td><td>${formatHours(task.timeMs)} h</td><td>${safeReportLink(task.evidenceLink) ? `<a href="${escapeAttr(safeReportLink(task.evidenceLink))}" target="_blank" rel="noopener noreferrer">Evidence</a>` : '—'}</td></tr>`).join('') || '<tr><td colspan="6">No deliverables recorded for the selected week.</td></tr>';
    return `<details class="weekly-person"><summary>${escapeHtml(person.name)} · ${person.assigned} deliverables · ${person.completed} completed in week · ${formatHours(person.hoursMs)} h</summary><div class="table-wrap"><table><thead><tr><th>Task / Deliverable</th><th>Current Status</th><th>Due</th><th>Done in week?</th><th>Tracked time</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  }).join('');
  return page('Weekly Reports', `<div class="panel"><div class="weekly-report-top"><div><h1>Weekly Deliverables Report</h1><p>Monitor each employee's deliverables, completion, overdue items and time tracked. Report period: <b>${escapeHtml(prettyDate(report.monday))} - ${escapeHtml(prettyDate(report.sunday))}</b>.</p></div><a class="button" href="${escapeAttr(download)}">Download PDF</a></div>
    <form class="weekly-filter-form" method="get" action="/reports/weekly"><label>Week beginning (any date in the week)<input type="date" name="week" value="${escapeAttr(report.monday)}" required></label>${employeeSelect}${projectSelect}<button type="submit">View report</button></form>
    <div class="metrics weekly-metrics">${metric('Deliverables',String(report.totals.assigned),'In selected week')}${metric('Completed in week',String(report.totals.completed),'With completion date')}${metric('Open now',String(report.totals.open),'Current status')}${metric('Overdue now',String(report.totals.overdue),'Open items past due')}${metric('Blocked now',String(report.totals.blocked),'Blocked or delayed')}${metric('Time logged',formatHours(report.totals.hoursMs)+' h','Task timers in week')}</div>
    <h2>Employee scorecard</h2><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Deliverables</th><th>Due this week</th><th>Completed in week</th><th>Open now</th><th>Overdue now</th><th>Blocked now</th><th>Logged hours</th><th>Currently completed %</th></tr></thead><tbody>${summaries}</tbody></table></div>
    <h2 style="margin-top:24px">Detailed weekly deliverables</h2>${detailSections || '<p>No employee records available for this report.</p>'}
    <div class="hint"><b>How the weekly report works:</b> ${escapeHtml(report.scopeNote)} Completion-in-week counts require a completion date. Historical reports are live snapshots, not immutable records of past weeks. Deleted tasks cannot be recovered from this report.</div>
  </div>`, user);
}

function renderActions(db, user, message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = `<details class="create-box"><summary>Add new action item</summary><form class="form-grid" method="post" action="/actions/new"><label>Source Date<input type="date" name="sourceDate" value="${todayDate()}"></label><label>Project<select name="projectId">${projectOptionsHtml(db)}</select></label><label>Owner${staffInputHtml(db, 'owner', user.displayName)}</label><label>Assigned By<input name="assignedBy" value="${escapeAttr(user.displayName)}"></label><label>Priority<select name="priority">${priorityOptionsHtml('High')}</select></label><label>Status<select name="status">${statusOptionsHtml(actionStatuses(), 'Open')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label>Next Follow-up<input type="date" name="nextFollowUpDate"></label><label class="wide">Action Item<textarea name="item" required></textarea></label><label class="wide">Manager Comment / Update<textarea name="managerComment"></textarea></label><label class="wide">Evidence Link<input name="evidenceLink" placeholder="Paste file/link reference if any"></label><button class="button">Create Action</button></form></details>`;
  const rows = db.actions.map(a => {
    const canEdit = user.clearance >= 2 || samePerson(a.owner, user.displayName);
    const edit = canEdit ? `<details><summary>Edit action</summary><form class="record-form" method="post" action="/actions/update"><input type="hidden" name="id" value="${escapeAttr(a.id)}"><label>Source Date<input type="date" name="sourceDate" value="${escapeAttr(fmtDate(a.sourceDate))}"></label><label>Project<select name="projectId">${projectOptionsHtml(db, a.projectId || '')}</select></label><label>Owner${staffInputHtml(db, 'owner', a.owner || '')}</label><label>Assigned By<input name="assignedBy" value="${escapeAttr(a.assignedBy || '')}"></label><label>Priority<select name="priority">${priorityOptionsHtml(a.priority || 'Medium')}</select></label><label>Status<select name="status">${statusOptionsHtml(actionStatuses(), a.status || 'Open')}</select></label><label>Due Date<input type="date" name="dueDate" value="${escapeAttr(fmtDate(a.dueDate))}"></label><label>Next Follow-up<input type="date" name="nextFollowUpDate" value="${escapeAttr(fmtDate(a.nextFollowUpDate))}"></label><label class="wide">Action Item<textarea name="item" required>${escapeHtml(a.item || '')}</textarea></label><label class="wide">Manager Comment / Update<textarea name="managerComment">${escapeHtml(a.managerComment || '')}</textarea></label><label class="wide">Evidence Link<input name="evidenceLink" value="${escapeAttr(a.evidenceLink || '')}"></label><button class="button">Save Action</button></form>${user.clearance >= 3 ? deleteButton('/actions/delete', a.id, 'Delete this action item?') : ''}</details>` : '';
    return `<tr><td>${escapeHtml(a.id)}</td><td><b>${escapeHtml(a.item)}</b><br><small>${escapeHtml(a.managerComment || '')}</small>${edit}</td><td>${escapeHtml(a.projectId)}</td><td>${escapeHtml(a.owner || '')}</td><td>${pill(a.priority, priorityClass(a.priority))}</td><td>${pill(a.status, statusClass(a.status))}</td><td>${escapeHtml(fmtDate(a.dueDate))}</td></tr>`;
  }).join('');
  return page('Action Log', `<div class="panel"><h1>Action Log</h1><p>Create and update meeting actions, follow-ups and evidence references.</p>${notice}${create}<div class="table-wrap"><table><thead><tr><th>ID</th><th>Action Item</th><th>Project</th><th>Owner</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}

function renderDelays(db, user, message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = `<details class="create-box"><summary>Add new delay / escalation</summary><form class="form-grid" method="post" action="/delays/new"><label>Date Raised<input type="date" name="dateRaised" value="${todayDate()}"></label><label>Project<select name="projectId">${projectOptionsHtml(db)}</select></label><label>Related Task ID<input name="relatedTaskId" placeholder="Optional"></label><label>Category<select name="category">${delayCategoryOptionsHtml(db, 'Transport / Truck Delay')}</select></label><label>Responsible Party${staffInputHtml(db, 'responsibleParty')}</label><label>Escalation Owner${staffInputHtml(db, 'escalationOwner', user.displayName)}</label><label>Severity<select name="severity">${priorityOptionsHtml('High')}</select></label><label>Status<select name="status">${statusOptionsHtml(['Open','In Progress','Escalated','Closed','Cancelled'], 'Open')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label>Impact Area<select name="impactArea">${impactAreaOptionsHtml(db, 'Timeline')}</select></label><label>Escalation Level<input name="escalationLevel" placeholder="Level 2 / Level 3"></label><label class="wide">Delay / Blocker Description<textarea name="description" required></textarea></label><label class="wide">Required Action<textarea name="requiredAction"></textarea></label><label class="wide">Impact Description<textarea name="impactDescription"></textarea></label><label class="wide">Resolution / Closeout<textarea name="resolution"></textarea></label><button class="button">Create Delay</button></form></details>`;
  const rows = db.delays.map(d => {
    const edit = `<details><summary>Edit delay</summary><form class="record-form" method="post" action="/delays/update"><input type="hidden" name="id" value="${escapeAttr(d.id)}"><label>Date Raised<input type="date" name="dateRaised" value="${escapeAttr(fmtDate(d.dateRaised))}"></label><label>Project<select name="projectId">${projectOptionsHtml(db, d.projectId || '')}</select></label><label>Related Task ID<input name="relatedTaskId" value="${escapeAttr(d.relatedTaskId || '')}"></label><label>Category<select name="category">${delayCategoryOptionsHtml(db, d.category || '')}</select></label><label>Responsible Party${staffInputHtml(db, 'responsibleParty', d.responsibleParty || '')}</label><label>Escalation Owner${staffInputHtml(db, 'escalationOwner', d.escalationOwner || '')}</label><label>Severity<select name="severity">${priorityOptionsHtml(d.severity || 'Medium')}</select></label><label>Status<select name="status">${statusOptionsHtml(['Open','In Progress','Escalated','Closed','Cancelled'], d.status || 'Open')}</select></label><label>Due Date<input type="date" name="dueDate" value="${escapeAttr(fmtDate(d.dueDate))}"></label><label>Impact Area<select name="impactArea">${impactAreaOptionsHtml(db, d.impactArea || '')}</select></label><label>Escalation Level<input name="escalationLevel" value="${escapeAttr(d.escalationLevel || '')}"></label><label class="wide">Delay / Blocker Description<textarea name="description" required>${escapeHtml(d.description || '')}</textarea></label><label class="wide">Required Action<textarea name="requiredAction">${escapeHtml(d.requiredAction || '')}</textarea></label><label class="wide">Impact Description<textarea name="impactDescription">${escapeHtml(d.impactDescription || '')}</textarea></label><label class="wide">Resolution / Closeout<textarea name="resolution">${escapeHtml(d.resolution || '')}</textarea></label><button class="button">Save Delay</button></form>${user.clearance >= 3 ? deleteButton('/delays/delete', d.id, 'Delete this delay record?') : ''}</details>`;
    return `<tr class="${String(d.status).toLowerCase() === 'open' ? 'overdue-row' : ''}"><td>${escapeHtml(d.id)}</td><td><b>${escapeHtml(d.description)}</b><br><small>${escapeHtml(d.requiredAction || '')}</small>${edit}</td><td>${escapeHtml(d.projectId)}</td><td>${escapeHtml(d.responsibleParty || '')}</td><td>${escapeHtml(d.category || '')}</td><td>${escapeHtml(d.impactArea || '')}</td><td>${pill(d.status, statusClass(d.status))}</td><td>${escapeHtml(d.escalationLevel || '')}</td><td>${escapeHtml(fmtDate(d.dueDate))}</td></tr>`;
  }).join('');
  return page('Delay Tracker', `<div class="panel"><h1>Delay & Escalation Tracker</h1><p>Restricted to Level 2 and above because it contains operational bottlenecks and accountability issues.</p>${notice}${create}<div class="table-wrap"><table><thead><tr><th>ID</th><th>Delay / Blocker</th><th>Project</th><th>Responsible</th><th>Category</th><th>Impact Area</th><th>Status</th><th>Escalation</th><th>Due</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}


function renderRisks(db, user, message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = `<details class="create-box"><summary>Add new risk / issue</summary><form class="form-grid" method="post" action="/risks/new"><label>Date Identified<input type="date" name="dateIdentified" value="${todayDate()}"></label><label>Project<select name="projectId">${projectOptionsHtml(db)}</select></label><label>Type<select name="type">${riskTypeOptionsHtml(db, 'Risk')}</select></label><label>Category<select name="category">${riskCategoryOptionsHtml(db, 'Logistics')}</select></label><label>Owner${staffInputHtml(db, 'owner', user.displayName)}</label><label>Likelihood 1-5<input type="number" name="likelihood" min="1" max="5" value="3"></label><label>Impact 1-5<input type="number" name="impact" min="1" max="5" value="3"></label><label>Status<select name="status">${statusOptionsHtml(['Open','Monitoring','Mitigating','Closed','Cancelled'], 'Open')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label>Escalation Required?<select name="escalationRequired"><option>No</option><option>Yes</option></select></label><label class="wide">Risk / Issue<textarea name="issue" required></textarea></label><label class="wide">Early Warning Signal<textarea name="earlyWarning"></textarea></label><label class="wide">Mitigation<textarea name="mitigation"></textarea></label><label class="wide">Contingency<textarea name="contingency"></textarea></label><label class="wide">Resolution<textarea name="resolution"></textarea></label><button class="button">Create Risk</button></form></details>`;
  const rows = db.risks.map(r => {
    const score = riskScore(r);
    const edit = `<details><summary>Edit risk</summary><form class="record-form" method="post" action="/risks/update"><input type="hidden" name="id" value="${escapeAttr(r.id)}"><label>Date Identified<input type="date" name="dateIdentified" value="${escapeAttr(fmtDate(r.dateIdentified))}"></label><label>Project<select name="projectId">${projectOptionsHtml(db, r.projectId || '')}</select></label><label>Type<select name="type">${riskTypeOptionsHtml(db, r.type || 'Risk')}</select></label><label>Category<select name="category">${riskCategoryOptionsHtml(db, r.category || '')}</select></label><label>Owner${staffInputHtml(db, 'owner', r.owner || '')}</label><label>Likelihood 1-5<input type="number" name="likelihood" min="1" max="5" value="${escapeAttr(r.likelihood || 3)}"></label><label>Impact 1-5<input type="number" name="impact" min="1" max="5" value="${escapeAttr(r.impact || 3)}"></label><label>Status<select name="status">${statusOptionsHtml(['Open','Monitoring','Mitigating','Closed','Cancelled'], r.status || 'Open')}</select></label><label>Due Date<input type="date" name="dueDate" value="${escapeAttr(fmtDate(r.dueDate))}"></label><label>Escalation Required?<select name="escalationRequired">${statusOptionsHtml(['No','Yes'], r.escalationRequired || 'No')}</select></label><label class="wide">Risk / Issue<textarea name="issue" required>${escapeHtml(r.issue || '')}</textarea></label><label class="wide">Early Warning Signal<textarea name="earlyWarning">${escapeHtml(r.earlyWarning || '')}</textarea></label><label class="wide">Mitigation<textarea name="mitigation">${escapeHtml(r.mitigation || '')}</textarea></label><label class="wide">Contingency<textarea name="contingency">${escapeHtml(r.contingency || '')}</textarea></label><label class="wide">Resolution<textarea name="resolution">${escapeHtml(r.resolution || '')}</textarea></label><button class="button">Save Risk</button></form>${user.clearance >= 3 ? deleteButton('/risks/delete', r.id, 'Delete this risk record?') : ''}</details>`;
    return `<tr><td>${escapeHtml(r.id)}</td><td><b>${escapeHtml(r.issue)}</b><br><small>${escapeHtml(r.mitigation || '')}</small>${edit}</td><td>${escapeHtml(r.projectId)}</td><td>${escapeHtml(r.owner || '')}</td><td>${escapeHtml(r.type || '')}</td><td>${escapeHtml(r.category || '')}</td><td>${escapeHtml(score)}</td><td>${pill(r.status, statusClass(r.status))}</td><td>${escapeHtml(fmtDate(r.dueDate))}</td></tr>`;
  }).join('');
  return page('Risk Register', `<div class="panel"><h1>Risk Register</h1><p>Restricted to Level 2 and above. Use this for export, logistics, documentation, cash, quality and regulatory risks.</p>${notice}${create}<div class="table-wrap"><table><thead><tr><th>ID</th><th>Risk / Issue</th><th>Project</th><th>Owner</th><th>Type</th><th>Category</th><th>Score</th><th>Status</th><th>Due</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}


function renderApprovals(db, user, message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = `<details class="create-box"><summary>Add approval request</summary><form class="form-grid" method="post" action="/approvals/new"><label>Date Requested<input type="date" name="dateRequested" value="${todayDate()}"></label><label>Project<select name="projectId">${projectOptionsHtml(db)}</select></label><label>Approval Type<select name="type">${approvalTypeOptionsHtml(db, 'Document Signing')}</select></label><label>Requested By${staffInputHtml(db, 'requestedBy', user.displayName)}</label><label>Approver${staffInputHtml(db, 'approver', 'AKIN')}</label><label>Amount / Document<input name="amountOrDocument" placeholder="e.g. Document / ₦ amount"></label><label>Required By<input type="date" name="requiredBy"></label><label>Status<select name="status">${statusOptionsHtml(['Pending','Approved','Rejected','Deferred','Cancelled'], 'Pending')}</select></label><label>Impact Area<select name="impactArea">${impactAreaOptionsHtml(db, 'Timeline')}</select></label><label>Escalation Level<input name="escalationLevel" value="Level 3 - Executive Decision"></label><label class="wide">Approval Item / Decision Needed<textarea name="item" required></textarea></label><label class="wide">Impact If Delayed<textarea name="impactIfDelayed"></textarea></label><label class="wide">Decision Comment<textarea name="decisionComment"></textarea></label><label class="wide">Evidence Link<input name="evidenceLink"></label><button class="button">Create Approval</button></form></details>`;
  const rows = db.approvals.map(a => {
    const edit = `<details><summary>Edit approval</summary><form class="record-form" method="post" action="/approvals/update"><input type="hidden" name="id" value="${escapeAttr(a.id)}"><label>Date Requested<input type="date" name="dateRequested" value="${escapeAttr(fmtDate(a.dateRequested))}"></label><label>Project<select name="projectId">${projectOptionsHtml(db, a.projectId || '')}</select></label><label>Approval Type<select name="type">${approvalTypeOptionsHtml(db, a.type || '')}</select></label><label>Requested By${staffInputHtml(db, 'requestedBy', a.requestedBy || '')}</label><label>Approver${staffInputHtml(db, 'approver', a.approver || '')}</label><label>Amount / Document<input name="amountOrDocument" value="${escapeAttr(a.amountOrDocument || '')}"></label><label>Required By<input type="date" name="requiredBy" value="${escapeAttr(fmtDate(a.requiredBy))}"></label><label>Status<select name="status">${statusOptionsHtml(['Pending','Approved','Rejected','Deferred','Cancelled'], a.status || 'Pending')}</select></label><label>Impact Area<select name="impactArea">${impactAreaOptionsHtml(db, a.impactArea || '')}</select></label><label>Escalation Level<input name="escalationLevel" value="${escapeAttr(a.escalationLevel || '')}"></label><label class="wide">Approval Item / Decision Needed<textarea name="item" required>${escapeHtml(a.item || '')}</textarea></label><label class="wide">Impact If Delayed<textarea name="impactIfDelayed">${escapeHtml(a.impactIfDelayed || '')}</textarea></label><label class="wide">Decision Comment<textarea name="decisionComment">${escapeHtml(a.decisionComment || '')}</textarea></label><label class="wide">Evidence Link<input name="evidenceLink" value="${escapeAttr(a.evidenceLink || '')}"></label><button class="button">Save Approval</button></form>${user.clearance >= 4 ? deleteButton('/approvals/delete', a.id, 'Delete this approval request?') : ''}</details>`;
    return `<tr><td>${escapeHtml(a.id)}</td><td><b>${escapeHtml(a.item)}</b><br><small>${escapeHtml(a.impactIfDelayed || '')}</small>${edit}</td><td>${escapeHtml(a.projectId)}</td><td>${escapeHtml(a.requestedBy || '')}</td><td>${escapeHtml(a.approver || '')}</td><td>${escapeHtml(a.type || '')}</td><td>${escapeHtml(a.impactArea || '')}</td><td>${pill(a.status, statusClass(a.status))}</td><td>${escapeHtml(fmtDate(a.requiredBy))}</td></tr>`;
  }).join('');
  return page('Approvals', `<div class="panel"><h1>Executive Approval Tracker</h1><p>Restricted to Level 3 and above. This keeps funding, signatures, sign-offs and executive decisions visible.</p>${notice}${create}<div class="table-wrap"><table><thead><tr><th>ID</th><th>Decision Needed</th><th>Project</th><th>Requested By</th><th>Approver</th><th>Type</th><th>Impact Area</th><th>Status</th><th>Required By</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}


function renderNxp(db, user, message = '') {
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = `<details class="create-box"><summary>Add NXP checklist item</summary><form class="form-grid" method="post" action="/nxp/new"><label>Project<select name="projectId">${projectOptionsHtml(db)}</select></label><label>Workstream<input name="workstream" placeholder="Buyer / Contract"></label><label>Owner${staffInputHtml(db, 'owner')}</label><label>Required By Stage<input name="requiredByStage" placeholder="Day 1 / Before loading"></label><label>Status<select name="status">${statusOptionsHtml(['Not Started','In Progress','Pending External Party','Blocked','Completed','Cancelled'], 'Not Started')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label>Escalation Required?<select name="escalationRequired">${statusOptionsHtml(['No','Yes'], 'No')}</select></label><label>Approver / External Party<input name="approverExternalParty"></label><label class="wide">Required Item<textarea name="item" required></textarea></label><label class="wide">Blocker<textarea name="blocker"></textarea></label><label class="wide">Evidence Link<input name="evidenceLink"></label><label class="wide">Notes<textarea name="notes"></textarea></label><button class="button">Create Checklist Item</button></form></details>`;
  const rows = db.nxpChecklist.map(n => {
    const edit = `<details><summary>Edit checklist item</summary><form class="record-form" method="post" action="/nxp/update"><input type="hidden" name="id" value="${escapeAttr(n.id)}"><label>Project<select name="projectId">${projectOptionsHtml(db, n.projectId || '')}</select></label><label>Workstream<input name="workstream" value="${escapeAttr(n.workstream || '')}"></label><label>Owner${staffInputHtml(db, 'owner', n.owner || '')}</label><label>Required By Stage<input name="requiredByStage" value="${escapeAttr(n.requiredByStage || '')}"></label><label>Status<select name="status">${statusOptionsHtml(['Not Started','In Progress','Pending External Party','Blocked','Completed','Cancelled'], n.status || 'Not Started')}</select></label><label>Due Date<input type="date" name="dueDate" value="${escapeAttr(fmtDate(n.dueDate))}"></label><label>Escalation Required?<select name="escalationRequired">${statusOptionsHtml(['No','Yes'], n.escalationRequired || 'No')}</select></label><label>Approver / External Party<input name="approverExternalParty" value="${escapeAttr(n.approverExternalParty || '')}"></label><label class="wide">Required Item<textarea name="item" required>${escapeHtml(n.item || '')}</textarea></label><label class="wide">Blocker<textarea name="blocker">${escapeHtml(n.blocker || '')}</textarea></label><label class="wide">Evidence Link<input name="evidenceLink" value="${escapeAttr(n.evidenceLink || '')}"></label><label class="wide">Notes<textarea name="notes">${escapeHtml(n.notes || '')}</textarea></label><button class="button">Save Checklist Item</button></form>${user.clearance >= 3 ? deleteButton('/nxp/delete', n.id, 'Delete this NXP checklist item?') : ''}</details>`;
    return `<tr><td>${escapeHtml(n.id)}</td><td><b>${escapeHtml(n.item)}</b><br><small>${escapeHtml(n.notes || '')}</small>${edit}</td><td>${escapeHtml(n.workstream || '')}</td><td>${escapeHtml(n.owner || '')}</td><td>${escapeHtml(n.requiredByStage || '')}</td><td>${pill(n.status, statusClass(n.status))}</td><td>${escapeHtml(fmtDate(n.dueDate))}</td><td>${escapeHtml(n.blocker || '')}</td></tr>`;
  }).join('');
  return page('NXP Checklist', `<div class="panel"><h1>Export-NXP Checklist</h1><p>Restricted to Level 2 and above. This covers NXP, invoice, packing list, SGS, phyto, fumigation, certificate of origin, truck evidence, B/L and original documents.</p>${notice}${create}<div class="table-wrap"><table><thead><tr><th>ID</th><th>Required Item</th><th>Workstream</th><th>Owner</th><th>Stage</th><th>Status</th><th>Due</th><th>Blocker</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}

function renderKpi(db, user) {
  const rows = db.users.filter(u => !isExcludedFromDeliverables(u)).map(u => {
    const ownedTasks = db.tasks.filter(t => String(t.assignedTo || '').toLowerCase() === String(u.displayName || '').toLowerCase());
    const completed = ownedTasks.filter(t => String(t.status).toLowerCase() === 'completed').length;
    const open = ownedTasks.filter(t => !isClosed(t.status)).length;
    const overdue = ownedTasks.filter(isOverdue).length;
    const evidence = ownedTasks.filter(t => t.evidenceLink).length;
    const rate = ownedTasks.length ? Math.round(evidence / ownedTasks.length * 100) : 0;
    const band = ownedTasks.length === 0 ? 'No Data' : (overdue > 0 ? 'Needs Attention' : (completed / ownedTasks.length >= .8 ? 'Strong' : 'Developing'));
    return `<tr><td><b>${escapeHtml(u.displayName)}</b><br><small>${escapeHtml(u.role)}</small></td><td>${ownedTasks.length}</td><td>${completed}</td><td>${open}</td><td>${overdue}</td><td>${rate}%</td><td>${pill(band, band === 'Strong' ? 'good' : band === 'Needs Attention' ? 'bad' : 'info')}</td></tr>`;
  }).join('');
  return page('KPI', `<div class="panel"><h1>KPI & Performance Monitoring</h1><p>Live KPI view derived from the task tracker.</p><div class="table-wrap"><table><thead><tr><th>Person</th><th>Assigned</th><th>Completed</th><th>Open</th><th>Overdue</th><th>Evidence Rate</th><th>Band</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}


function formOption(value, label, selectedValue = '') {
  const selected = String(value || '') === String(selectedValue || '') ? ' selected' : '';
  return `<option value="${escapeAttr(value)}"${selected}>${escapeHtml(label)}</option>`;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function samePerson(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function cleanUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanText(value) {
  return String(value || '').trim();
}

function nullableText(value) {
  const v = cleanText(value);
  return v || null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function actionStatuses() {
  return ['Open', 'In Progress', 'Completed', 'Blocked', 'Delayed', 'Closed', 'Cancelled'];
}

function priorityOptionsHtml(selected = 'Medium') {
  return ['Critical', 'High', 'Medium', 'Low'].map(v => formOption(v, v, selected)).join('');
}

function projectStatusOptionsHtml(selected = 'Active') {
  return ['Active', 'On Hold', 'Completed', 'Closed', 'Cancelled'].map(v => formOption(v, v, selected)).join('');
}

function statusOptionsHtml(values, selected = '') {
  const list = [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
  const selectedText = String(selected || '').trim();
  if (selectedText && !list.includes(selectedText)) list.push(selectedText);
  return list.map(v => formOption(v, v, selectedText)).join('');
}

function projectOptionsHtml(db, selected = '', includeGeneral = false) {
  const options = includeGeneral ? [formOption('', 'General / No project', selected)] : [];
  return options.concat(db.projects.map(p => formOption(p.id, `${p.id} - ${p.name}`, selected))).join('');
}

function projectCategoryOptionsHtml(db, selected = 'Export Project') { return statusOptionsHtml(projectCategories(db), selected); }
function delayCategoryOptionsHtml(db, selected = '') { return statusOptionsHtml(delayCategories(db), selected); }
function approvalTypeOptionsHtml(db, selected = '') { return statusOptionsHtml(approvalTypes(db), selected); }
function riskTypeOptionsHtml(db, selected = '') { return statusOptionsHtml(riskTypes(db), selected); }
function riskCategoryOptionsHtml(db, selected = '') { return statusOptionsHtml(riskCategories(db), selected); }
function impactAreaOptionsHtml(db, selected = '') { return statusOptionsHtml(impactAreas(db), selected); }
function projectPhaseOptionsHtml(db, selected = '') { return statusOptionsHtml(projectPhases(db), selected); }
function projectHealthOptionsHtml(db, selected = 'Green') {
  const values = projectHealthValues(db);
  const selectedText = String(selected || '').trim() || 'Green';
  const list = values.includes(selectedText) ? values : [selectedText, ...values];
  return list.map(value => {
    const selectedAttr = value === selectedText ? ' selected' : '';
    const cssClass = projectHealthClass(value);
    return `<option class="${cssClass}" value="${escapeAttr(value)}"${selectedAttr}>${escapeHtml(value)}</option>`;
  }).join('');
}

function staffOptionsHtml(db, selected = '') {
  const staff = setupStaff(db);
  const options = staff.map(person => formOption(person.name, `${person.name} - ${person.role}`, selected));
  if (selected && !staff.some(person => String(person.name).toLowerCase() === String(selected).toLowerCase())) {
    options.push(formOption(selected, `${selected} - Existing value`, selected));
  }
  return options.join('');
}

function employeeOptionsHtml(db, selected = '') {
  const staff = setupStaff(db).filter(person => !person.isExternal);
  const options = staff.map(person => formOption(person.name, `${person.name} - ${person.role}`, selected));
  if (selected && !staff.some(person => String(person.name).toLowerCase() === String(selected).toLowerCase())) {
    options.push(formOption(selected, `${selected} - Existing value`, selected));
  }
  return options.join('');
}

function staffDatalistOptionsHtml(db, internalOnly = false) {
  return setupStaff(db)
    .filter(person => !internalOnly || !person.isExternal)
    .map(person => `<option value="${escapeAttr(person.name)}">${escapeHtml(person.role || '')}</option>`)
    .join('');
}

function staffDatalistHtml(db, id = 'staffList', internalOnly = false) {
  return `<datalist id="${escapeAttr(id)}">${staffDatalistOptionsHtml(db, internalOnly)}</datalist>`;
}

function peopleDatalistsHtml(db) {
  return `${staffDatalistHtml(db, 'staffList', false)}${staffDatalistHtml(db, 'employeeList', true)}`;
}

function staffInputHtml(db, name, selected = '', placeholder = 'Type or choose a person', internalOnly = false) {
  const listId = internalOnly ? 'employeeList' : 'staffList';
  return `<input name="${escapeAttr(name)}" list="${listId}" value="${escapeAttr(selected || '')}" placeholder="${escapeAttr(placeholder)}">${staffDatalistHtml(db, listId, internalOnly)}`;
}

function employeeInputHtml(db, name, selected = '', placeholder = 'Type or choose an employee') {
  const options = setupStaff(db).filter(person => !person.isExternal && !isExcludedFromDeliverables(person.name) &&
    !(db.users || []).some(u => isExcludedFromDeliverables(u) && samePerson(u.displayName, person.name)))
    .map(person => `<option value="${escapeAttr(person.name)}">${escapeHtml(person.role || '')}</option>`).join('');
  return `<input name="${escapeAttr(name)}" list="taskAssigneeList" value="${escapeAttr(selected || '')}" placeholder="${escapeAttr(placeholder)}"><datalist id="taskAssigneeList">${options}</datalist>`;
}

function roleForStaff(db, name) {
  const match = setupStaff(db).find(person => String(person.name).toLowerCase() === String(name || '').toLowerCase());
  return match ? match.role : '';
}

function projectNameFor(db, projectId) {
  const project = db.projects.find(p => p.id === projectId);
  return project ? project.name : '';
}

function updateProjectName(db, record) {
  record.projectName = projectNameFor(db, record.projectId);
}

function riskScore(r) {
  const score = Number(r.score || (Number(r.likelihood || 0) * Number(r.impact || 0)) || 0);
  return score || '';
}

function riskBand(score) {
  const s = Number(score || 0);
  if (s >= 15) return 'High';
  if (s >= 8) return 'Medium';
  if (s > 0) return 'Low';
  return '';
}

function deleteButton(action, id, question) {
  return `<form class="inline-form danger-action" method="post" action="${escapeAttr(action)}" onsubmit="return confirm('${escapeAttr(question)}');"><input type="hidden" name="id" value="${escapeAttr(id)}"><button type="submit" class="button danger-button">Delete</button></form>`;
}

function nextSequenceId(items, prefix, width = 4) {
  const max = (items || []).reduce((highest, item) => {
    const match = String(item.id || '').match(/(\d+)$/);
    const value = match ? Number(match[1]) : 0;
    return value > highest ? value : highest;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

function removeById(db, collection, id) {
  const list = db[collection] || [];
  const index = list.findIndex(item => item.id === id);
  if (index === -1) return null;
  return list.splice(index, 1)[0];
}

function optionalXlsx() {
  try {
    return require('xlsx');
  } catch (err) {
    return null;
  }
}

function excelCellText(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function excelDate(value, XLSX) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && XLSX && XLSX.SSF && typeof XLSX.SSF.parse_date_code === 'function') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = excelCellText(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const parsedDate = new Date(text);
  if (!Number.isNaN(parsedDate.getTime())) return parsedDate.toISOString().slice(0, 10);
  return text.slice(0, 10);
}

function excelNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).replace(/%/g, '').replace(/,/g, '').trim();
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

function excelProgress(value) {
  const n = excelNumber(value, 0);
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function rowValue(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  const wanted = names.map(name => String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(row)) {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.includes(normalized)) return value;
  }
  return '';
}


function excelRowNumber(row) {
  if (!row) return '';
  if (typeof row.__rowNum__ === 'number') return row.__rowNum__ + 1;
  return '';
}

function compactExcelSource(row) {
  const source = {};
  for (const [key, value] of Object.entries(row || {})) {
    const text = excelCellText(value);
    if (text) source[key] = text;
  }
  return source;
}

function integrationWarnings(row, requiredFields = []) {
  const warnings = [];
  for (const field of requiredFields) {
    if (!excelCellText(rowValue(row, Array.isArray(field) ? field : [field]))) {
      warnings.push(`Missing ${Array.isArray(field) ? field[0] : field}`);
    }
  }
  return warnings;
}

function addIntegrationWarning(warnings, sheet, row, id, messages) {
  if (!messages || !messages.length) return;
  warnings.push({
    sheet,
    row: excelRowNumber(row),
    id: id || '',
    warnings: messages
  });
}

function normalizedClosedLike(value) {
  return ['completed', 'closed', 'cancelled', 'approved', 'resolved', 'done'].includes(String(value || '').toLowerCase().trim());
}

function sheetRows(workbook, sheetNames, XLSX) {
  const names = Array.isArray(sheetNames) ? sheetNames : [sheetNames];
  const sheetName = names.find(name => workbook.Sheets[name]) || workbook.SheetNames.find(existing => names.some(name => String(existing).toLowerCase().trim() === String(name).toLowerCase().trim()));
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true });
  return rows.filter(row => Object.values(row).some(value => excelCellText(value)));
}

function upsertById(collection, record) {
  const index = collection.findIndex(item => String(item.id || '').toLowerCase() === String(record.id || '').toLowerCase());
  if (index >= 0) {
    collection[index] = { ...collection[index], ...record };
    return 'updated';
  }
  collection.push(record);
  return 'created';
}

function importSetupRows(db, rows) {
  if (!rows.length) return 0;
  const staff = [];
  const columns = {
    projectCategories: 'Project Category',
    taskStatuses: 'Task Status',
    priorities: 'Priority',
    yesNoValues: 'Yes/No',
    delayCategories: 'Delay Category',
    approvalTypes: 'Approval Type',
    approvalStatuses: 'Approval Status',
    riskTypes: 'Risk Type',
    riskCategories: 'Risk Category',
    riskStatuses: 'Risk Status',
    escalationLevels: 'Escalation Level',
    impactAreas: 'Impact Area',
    projectPhases: 'Project Phase',
    evidenceTypes: 'Evidence Type',
    qualityRatings: 'Quality Rating',
    projectStatuses: 'Project Status',
    projectHealthValues: 'Project Health'
  };
  const updates = {};
  for (const key of Object.keys(columns)) updates[key] = [];
  for (const row of rows) {
    const name = excelCellText(rowValue(row, ['Staff / Accountable Party', 'Staff', 'Accountable Party']));
    if (name) {
      const externalNames = ['buyer', 'supplier', 'transporter', 'bank', 'regulator / agency', 'regulator', 'agency'];
      const normalized = name.toUpperCase() === name ? name : name.toUpperCase();
      staff.push({
        name: normalized,
        role: excelCellText(rowValue(row, ['Role'])) || 'Staff',
        isExternal: externalNames.includes(name.toLowerCase())
      });
    }
    for (const [key, column] of Object.entries(columns)) {
      const value = excelCellText(rowValue(row, [column]));
      if (value) updates[key].push(value);
    }
  }
  db.setup = db.setup || {};
  let changed = 0;
  if (staff.length) {
    db.setup.staff = [...new Map(staff.map(person => [person.name.toLowerCase(), person])).values()];
    changed++;
  }
  for (const [key, values] of Object.entries(updates)) {
    if (values.length) {
      db.setup[key] = [...new Set(values)];
      changed++;
    }
  }
  db.setup.integrationFields = {
    projects: ['Project ID', 'Project Name', 'Project Category', 'Project Owner', 'Sponsor / Approver', 'Current Phase', 'Priority', 'Status', 'Start Date', 'Target End Date', 'Current Blocker', 'Next Milestone', 'Decision Required', 'Impact if Delayed', 'Last Update', 'Project Folder / Link'],
    tasks: ['Task ID', 'Project ID', 'Task / Deliverable', 'Assigned To', 'Assigned By', 'Priority', 'Status', 'Due Date', 'Progress %', 'Blocker?', 'Delay Category', 'Approval Required?', 'Evidence Link', 'Next Action', 'Evidence Type'],
    delays: ['Delay ID', 'Project ID', 'Related Task ID', 'Delay Category', 'Delay / Blocker Description', 'Responsible Party', 'Required Decision / Action', 'Impact Area', 'Estimated Days Impact', 'Resolution / Recovery Plan'],
    risks: ['Risk ID', 'Project ID', 'Risk / Issue', 'Type', 'Category', 'Owner / DRI', 'Likelihood (1-5)', 'Impact (1-5)', 'Mitigation / Preventive Action', 'Status'],
    approvals: ['Approval ID', 'Project ID', 'Approval Type', 'Requested By', 'Approver', 'Approval Item / Decision Needed', 'Required By', 'Status', 'Impact Area'],
    nxpTasks: ['Checklist ID', 'Project ID', 'Workstream', 'Required Item', 'Owner', 'Required By Stage', 'Status', 'Due Date', 'Blocker', 'Approver / External Party']
  };
  changed++;
  return changed;
}

function importProjects(db, rows, XLSX) {
  db.projects = db.projects || [];
  let created = 0, updated = 0;
  const warnings = [];
  for (const row of rows) {
    const id = excelCellText(rowValue(row, ['Project ID']));
    const name = excelCellText(rowValue(row, ['Project Name']));
    const missing = integrationWarnings(row, ['Project ID', 'Project Name']);
    if (!id || !name) { addIntegrationWarning(warnings, 'Project Register', row, id, missing); continue; }
    const record = {
      id,
      name,
      category: excelCellText(rowValue(row, ['Project Category'])) || 'Other',
      owner: excelCellText(rowValue(row, ['Project Owner', 'Owner'])),
      sponsor: excelCellText(rowValue(row, ['Sponsor / Approver', 'Sponsor'])),
      phase: excelCellText(rowValue(row, ['Current Phase', 'Project Phase'])) || 'Execution',
      priority: excelCellText(rowValue(row, ['Priority'])) || 'Medium',
      status: excelCellText(rowValue(row, ['Status'])) || 'Active',
      startDate: excelDate(rowValue(row, ['Start Date']), XLSX),
      targetEndDate: excelDate(rowValue(row, ['Target End Date', 'Due Date']), XLSX),
      daysToDeadline: excelNumber(rowValue(row, ['Days to Deadline']), ''),
      progress: excelProgress(rowValue(row, ['Progress %'])),
      tasksTotal: excelNumber(rowValue(row, ['Tasks Total']), 0),
      tasksCompleted: excelNumber(rowValue(row, ['Tasks Completed']), 0),
      overdueTasks: excelNumber(rowValue(row, ['Overdue Tasks']), 0),
      blockedDelayedTasks: excelNumber(rowValue(row, ['Blocked/Delayed Tasks', 'Blocked / Delayed Tasks']), 0),
      openApprovals: excelNumber(rowValue(row, ['Open Approvals']), 0),
      openRisks: excelNumber(rowValue(row, ['Open Risks']), 0),
      projectHealth: excelCellText(rowValue(row, ['Project Health'])) || 'Green',
      currentBlocker: excelCellText(rowValue(row, ['Current Blocker'])),
      nextMilestone: excelCellText(rowValue(row, ['Next Milestone'])),
      decisionRequired: excelCellText(rowValue(row, ['Decision Required'])),
      impactIfDelayed: excelCellText(rowValue(row, ['Impact if Delayed', 'Impact If Delayed'])),
      lastUpdate: excelDate(rowValue(row, ['Last Update', 'Last Update Date']), XLSX) || excelCellText(rowValue(row, ['Last Update'])),
      notes: excelCellText(rowValue(row, ['Notes'])),
      projectFolderLink: excelCellText(rowValue(row, ['Project Folder / Link', 'Project Folder', 'Folder Link'])),
      sourceSheet: 'Project Register',
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    const result = upsertById(db.projects, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importTasks(db, rows, XLSX, options = {}) {
  db.tasks = db.tasks || [];
  let created = 0, updated = 0;
  const warnings = [];
  const sheet = options.nxp ? 'Export-NXP Checklist' : 'Master Productivity Tracker';
  for (const row of rows) {
    const projectId = excelCellText(rowValue(row, ['Project ID']));
    const title = excelCellText(rowValue(row, ['Task / Deliverable', 'Required Item', 'Action Item']));
    const missing = integrationWarnings(row, options.nxp ? ['Project ID', 'Required Item', 'Owner'] : ['Project ID', 'Task / Deliverable', 'Assigned To']);
    if (!title && !projectId) { addIntegrationWarning(warnings, sheet, row, '', missing.length ? missing : ['Missing Project ID and task/required item']); continue; }
    if (missing.length) addIntegrationWarning(warnings, sheet, row, excelCellText(rowValue(row, ['Task ID', 'Checklist ID'])), missing);
    const explicitId = excelCellText(rowValue(row, ['Task ID', 'Checklist ID']));
    const nxpId = excelCellText(rowValue(row, ['Checklist ID']));
    let existing = null;
    if (explicitId) existing = db.tasks.find(task => String(task.id).toLowerCase() === explicitId.toLowerCase());
    if (!existing && nxpId) existing = db.tasks.find(task => String(task.nxpChecklistId || '').toLowerCase() === nxpId.toLowerCase());
    const id = existing ? existing.id : (explicitId && /^T/i.test(explicitId) ? explicitId : nextSequenceId(db.tasks, 'T'));
    const project = (db.projects || []).find(p => p.id === projectId);
    const assignedTo = excelCellText(rowValue(row, ['Assigned To', 'Owner'])) || 'ONAOPE';
    const status = excelCellText(rowValue(row, ['Status'])) || 'Not Started';
    const taskType = options.nxp ? 'NXP / Documentation Checklist' : (excelCellText(rowValue(row, ['Task Type', 'Workstream'])) || 'General Task');
    const workstream = excelCellText(rowValue(row, ['Workstream']));
    const requiredByStage = excelCellText(rowValue(row, ['Required By Stage']));
    const blocker = excelCellText(rowValue(row, ['Blocker?', 'Blocker']));
    const record = {
      id,
      originalExcelId: explicitId || nxpId || '',
      dateLogged: excelDate(rowValue(row, ['Date Logged']), XLSX) || todayDate(),
      weekStart: excelDate(rowValue(row, ['Week Start']), XLSX),
      projectId,
      projectName: project ? project.name : excelCellText(rowValue(row, ['Project Name'])),
      category: excelCellText(rowValue(row, ['Project Category'])) || (project ? project.category : ''),
      taskType,
      workstream,
      requiredByStage,
      title: title || 'Untitled imported task',
      assignedTo: assignedTo.toUpperCase(),
      assignedRole: taskRole(db, assignedTo),
      role: excelCellText(rowValue(row, ['Role'])) || taskRole(db, assignedTo),
      assignedBy: excelCellText(rowValue(row, ['Assigned By'])) || 'Excel Import',
      priority: excelCellText(rowValue(row, ['Priority'])) || 'Medium',
      status,
      workflowManaged: existing ? Boolean(existing.workflowManaged) : false,
      workflowOrder: existing ? Number(existing.workflowOrder || 0) : 0,
      phase: requiredByStage || (project ? project.phase : 'Execution'),
      startDate: excelDate(rowValue(row, ['Start Date']), XLSX),
      dueDate: excelDate(rowValue(row, ['Due Date']), XLSX),
      daysOutstanding: excelNumber(rowValue(row, ['Days Outstanding']), ''),
      daysToDue: excelNumber(rowValue(row, ['Days to Due']), ''),
      overdue: excelCellText(rowValue(row, ['Overdue?', 'Overdue'])) || (isOverdue({ dueDate: excelDate(rowValue(row, ['Due Date']), XLSX), status }) ? 'Yes' : 'No'),
      progress: excelProgress(rowValue(row, ['Progress %'])),
      blocker,
      blockerOwner: excelCellText(rowValue(row, ['Blocker Owner'])),
      delayCategory: excelCellText(rowValue(row, ['Delay Category'])),
      escalationRequired: excelCellText(rowValue(row, ['Escalation Required?'])),
      approvalRequired: excelCellText(rowValue(row, ['Approval Required?'])),
      approvalId: excelCellText(rowValue(row, ['Approval ID'])),
      evidenceLink: excelCellText(rowValue(row, ['Evidence Link'])),
      nextAction: excelCellText(rowValue(row, ['Next Action', 'Next Action ', 'Notes'])) || (options.nxp ? `Complete ${title || 'NXP documentation item'}.` : ''),
      managerComment: excelCellText(rowValue(row, ['Manager Comment'])),
      completionDate: excelDate(rowValue(row, ['Completion Date']), XLSX),
      qualityRating: excelNumber(rowValue(row, ['Quality Rating']), ''),
      productivityScore: excelNumber(rowValue(row, ['Productivity Score']), ''),
      lastUpdateDate: excelDate(rowValue(row, ['Last Update Date']), XLSX) || todayDate(),
      updateAging: excelNumber(rowValue(row, ['Update Aging']), ''),
      impactIfDelayed: excelCellText(rowValue(row, ['Impact if Delayed', 'Impact If Delayed'])),
      evidenceType: excelCellText(rowValue(row, ['Evidence Type'])),
      approverExternalParty: excelCellText(rowValue(row, ['Approver / External Party', 'Approver', 'External Party'])),
      notes: excelCellText(rowValue(row, ['Notes'])),
      nxpChecklistId: nxpId || (existing ? existing.nxpChecklistId : undefined),
      sourceModule: options.nxp ? 'NXP Checklist' : 'Master Productivity Tracker',
      sourceSheet: sheet,
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    if (normalizedClosedLike(status)) record.progress = 1;
    const result = upsertById(db.tasks, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importActions(db, rows, XLSX) {
  db.actions = db.actions || [];
  let created = 0, updated = 0;
  const warnings = [];
  for (const row of rows) {
    const item = excelCellText(rowValue(row, ['Action Item']));
    const missing = integrationWarnings(row, ['Action Item', 'Owner', 'Due Date']);
    if (!item) { addIntegrationWarning(warnings, 'Action Log', row, '', missing.length ? missing : ['Missing Action Item']); continue; }
    if (missing.length) addIntegrationWarning(warnings, 'Action Log', row, excelCellText(rowValue(row, ['Action ID'])), missing);
    const id = excelCellText(rowValue(row, ['Action ID'])) || nextSequenceId(db.actions, 'A');
    const record = {
      id,
      sourceDate: excelDate(rowValue(row, ['Meeting / Source Date', 'Source Date']), XLSX) || todayDate(),
      projectId: excelCellText(rowValue(row, ['Project ID'])),
      projectName: excelCellText(rowValue(row, ['Project Name'])),
      item,
      owner: excelCellText(rowValue(row, ['Owner'])).toUpperCase(),
      assignedBy: excelCellText(rowValue(row, ['Assigned By'])),
      priority: excelCellText(rowValue(row, ['Priority'])) || 'Medium',
      dueDate: excelDate(rowValue(row, ['Due Date']), XLSX),
      status: excelCellText(rowValue(row, ['Status'])) || 'Open',
      daysOutstanding: excelNumber(rowValue(row, ['Days Outstanding']), ''),
      overdue: excelCellText(rowValue(row, ['Overdue?', 'Overdue'])) || 'No',
      evidenceLink: excelCellText(rowValue(row, ['Evidence Link'])),
      nextFollowUpDate: excelDate(rowValue(row, ['Next Follow-up Date']), XLSX),
      managerComment: excelCellText(rowValue(row, ['Manager Comment'])),
      closedDate: excelDate(rowValue(row, ['Closed Date']), XLSX),
      sourceSheet: 'Action Log',
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    updateProjectName(db, record);
    const result = upsertById(db.actions, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importDelays(db, rows, XLSX) {
  db.delays = db.delays || [];
  db.risks = db.risks || [];
  let created = 0, updated = 0, removed = 0;
  const warnings = [];
  for (const row of rows) {
    const description = excelCellText(rowValue(row, ['Delay / Blocker Description', 'Description']));
    const id = excelCellText(rowValue(row, ['Delay ID'])) || nextSequenceId(db.delays, 'D');
    const missing = integrationWarnings(row, ['Delay ID', 'Project ID', 'Delay / Blocker Description', 'Responsible Party', ['Required Decision / Action', 'Required Action']]);
    if (!description) { addIntegrationWarning(warnings, 'Delay & Escalation Tracker', row, id, missing.length ? missing : ['Missing Delay / Blocker Description']); continue; }
    if (missing.length) addIntegrationWarning(warnings, 'Delay & Escalation Tracker', row, id, missing);
    const status = excelCellText(rowValue(row, ['Status'])) || 'Open';
    if (isClosed(status)) {
      const beforeD = db.delays.length, beforeR = (db.risks || []).length;
      db.delays = db.delays.filter(delay => String(delay.id).toLowerCase() !== id.toLowerCase());
      db.risks = (db.risks || []).filter(risk => String(risk.relatedDelayId || '').toLowerCase() !== id.toLowerCase());
      if (beforeD !== db.delays.length || beforeR !== (db.risks || []).length) removed++;
      continue;
    }
    const record = {
      id,
      dateRaised: excelDate(rowValue(row, ['Date Raised']), XLSX) || todayDate(),
      projectId: excelCellText(rowValue(row, ['Project ID'])),
      projectName: excelCellText(rowValue(row, ['Project Name'])),
      relatedTaskId: excelCellText(rowValue(row, ['Related Task ID', 'Task ID'])),
      category: excelCellText(rowValue(row, ['Delay Category', 'Category'])) || 'Internal Staff Delay',
      description,
      responsibleParty: excelCellText(rowValue(row, ['Responsible Party'])).toUpperCase(),
      escalationOwner: excelCellText(rowValue(row, ['Escalation Owner'])).toUpperCase(),
      severity: excelCellText(rowValue(row, ['Severity'])) || 'Medium',
      status,
      requiredAction: excelCellText(rowValue(row, ['Required Decision / Action', 'Required Action', 'Required Decision'])),
      requiredDecisionAction: excelCellText(rowValue(row, ['Required Decision / Action', 'Required Action', 'Required Decision'])),
      dueDate: excelDate(rowValue(row, ['Due Date']), XLSX),
      daysOutstanding: excelNumber(rowValue(row, ['Days Outstanding']), ''),
      overdue: excelCellText(rowValue(row, ['Overdue?', 'Overdue'])) || 'No',
      impactArea: excelCellText(rowValue(row, ['Impact Area'])) || 'Timeline',
      impactDescription: excelCellText(rowValue(row, ['Impact Description', 'Impact if Delayed'])),
      estimatedDaysImpact: excelNumber(rowValue(row, ['Estimated Days Impact']), ''),
      escalationLevel: excelCellText(rowValue(row, ['Escalation Level'])),
      evidenceLink: excelCellText(rowValue(row, ['Evidence Link'])),
      resolution: excelCellText(rowValue(row, ['Resolution / Recovery Plan', 'Resolution / Closeout', 'Resolution'])),
      resolutionRecoveryPlan: excelCellText(rowValue(row, ['Resolution / Recovery Plan', 'Resolution / Closeout', 'Resolution'])),
      closedDate: excelDate(rowValue(row, ['Closed Date']), XLSX),
      sourceSheet: 'Delay & Escalation Tracker',
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    updateProjectName(db, record);
    const result = upsertById(db.delays, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, removed, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importApprovals(db, rows, XLSX) {
  db.approvals = db.approvals || [];
  let created = 0, updated = 0;
  const warnings = [];
  for (const row of rows) {
    const item = excelCellText(rowValue(row, ['Approval Item / Decision Needed']));
    const missing = integrationWarnings(row, ['Approval ID', 'Project ID', 'Approval Type', 'Requested By', 'Approver', 'Approval Item / Decision Needed', 'Required By']);
    if (!item) { addIntegrationWarning(warnings, 'Executive Approval Tracker', row, excelCellText(rowValue(row, ['Approval ID'])), missing.length ? missing : ['Missing Approval Item / Decision Needed']); continue; }
    if (missing.length) addIntegrationWarning(warnings, 'Executive Approval Tracker', row, excelCellText(rowValue(row, ['Approval ID'])), missing);
    const id = excelCellText(rowValue(row, ['Approval ID'])) || nextSequenceId(db.approvals, 'AP');
    const record = {
      id,
      dateRequested: excelDate(rowValue(row, ['Date Requested']), XLSX) || todayDate(),
      projectId: excelCellText(rowValue(row, ['Project ID'])),
      projectName: excelCellText(rowValue(row, ['Project Name'])),
      type: excelCellText(rowValue(row, ['Approval Type'])) || 'Other Executive Decision',
      requestedBy: excelCellText(rowValue(row, ['Requested By'])).toUpperCase(),
      approver: excelCellText(rowValue(row, ['Approver'])).toUpperCase(),
      item,
      amountOrDocument: excelCellText(rowValue(row, ['Amount / Document'])),
      requiredBy: excelDate(rowValue(row, ['Required By']), XLSX),
      status: excelCellText(rowValue(row, ['Status'])) || 'Pending',
      daysOutstanding: excelNumber(rowValue(row, ['Days Outstanding']), ''),
      overdue: excelCellText(rowValue(row, ['Overdue?', 'Overdue'])) || 'No',
      impactArea: excelCellText(rowValue(row, ['Impact Area'])) || 'Timeline',
      impactIfDelayed: excelCellText(rowValue(row, ['Impact if Delayed'])),
      escalationLevel: excelCellText(rowValue(row, ['Escalation Level'])),
      dateApproved: excelDate(rowValue(row, ['Date Approved']), XLSX),
      decisionComment: excelCellText(rowValue(row, ['Decision / Comment'])),
      evidenceLink: excelCellText(rowValue(row, ['Evidence Link'])),
      sourceSheet: 'Executive Approval Tracker',
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    updateProjectName(db, record);
    const result = upsertById(db.approvals, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importRisks(db, rows, XLSX) {
  db.risks = db.risks || [];
  let created = 0, updated = 0, removed = 0;
  const warnings = [];
  for (const row of rows) {
    const issue = excelCellText(rowValue(row, ['Risk / Issue', 'Issue']));
    const id = excelCellText(rowValue(row, ['Risk ID'])) || nextSequenceId(db.risks, 'R');
    const missing = integrationWarnings(row, ['Risk ID', 'Project ID', 'Risk / Issue', 'Type', 'Category', 'Owner / DRI', 'Mitigation / Preventive Action']);
    if (!issue) { addIntegrationWarning(warnings, 'Risk Register', row, id, missing.length ? missing : ['Missing Risk / Issue']); continue; }
    if (missing.length) addIntegrationWarning(warnings, 'Risk Register', row, id, missing);
    const status = excelCellText(rowValue(row, ['Status'])) || 'Open';
    if (isClosed(status)) {
      const before = db.risks.length;
      db.risks = db.risks.filter(risk => String(risk.id).toLowerCase() !== id.toLowerCase());
      if (before !== db.risks.length) removed++;
      continue;
    }
    const likelihood = clampNumber(rowValue(row, ['Likelihood (1-5)', 'Likelihood']), 1, 5, 3);
    const impact = clampNumber(rowValue(row, ['Impact (1-5)', 'Impact']), 1, 5, 3);
    const score = excelNumber(rowValue(row, ['Risk Score']), likelihood * impact) || likelihood * impact;
    const record = {
      id,
      dateIdentified: excelDate(rowValue(row, ['Date Identified']), XLSX) || todayDate(),
      projectId: excelCellText(rowValue(row, ['Project ID'])),
      projectName: excelCellText(rowValue(row, ['Project Name'])),
      relatedDelayId: excelCellText(rowValue(row, ['Related Delay ID', 'Delay ID'])),
      relatedTaskId: excelCellText(rowValue(row, ['Related Task ID', 'Task ID'])),
      issue,
      type: excelCellText(rowValue(row, ['Type'])) || 'Risk',
      category: excelCellText(rowValue(row, ['Category'])) || 'Operational',
      owner: excelCellText(rowValue(row, ['Owner / DRI', 'Owner'])).toUpperCase(),
      likelihood,
      impact,
      score,
      heatMap: excelCellText(rowValue(row, ['Heat Map'])) || riskBand(score),
      earlyWarning: excelCellText(rowValue(row, ['Early Warning'])),
      mitigation: excelCellText(rowValue(row, ['Mitigation / Preventive Action', 'Mitigation'])),
      contingency: excelCellText(rowValue(row, ['Contingency / Pivot Plan', 'Contingency'])),
      dueDate: excelDate(rowValue(row, ['Due Date']), XLSX),
      status,
      escalationRequired: excelCellText(rowValue(row, ['Escalation Required?'])) || 'No',
      evidenceLink: excelCellText(rowValue(row, ['Evidence Link'])),
      resolution: excelCellText(rowValue(row, ['Resolution / Lesson', 'Resolution'])),
      closedDate: excelDate(rowValue(row, ['Closed Date']), XLSX),
      sourceSheet: 'Risk Register',
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    updateProjectName(db, record);
    const result = upsertById(db.risks, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, removed, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importLessons(db, rows, XLSX) {
  db.lessons = db.lessons || [];
  let created = 0, updated = 0;
  const warnings = [];
  for (const row of rows) {
    const event = excelCellText(rowValue(row, ['Event / Issue']));
    const missing = integrationWarnings(row, ['Project ID', 'Event / Issue', 'Root Cause', 'Permanent Control / Prevention Rule', 'Owner']);
    if (!event) { addIntegrationWarning(warnings, 'Lessons Learned', row, excelCellText(rowValue(row, ['Lesson ID'])), missing.length ? missing : ['Missing Event / Issue']); continue; }
    if (missing.length) addIntegrationWarning(warnings, 'Lessons Learned', row, excelCellText(rowValue(row, ['Lesson ID'])), missing);
    const id = excelCellText(rowValue(row, ['Lesson ID'])) || nextSequenceId(db.lessons, 'LL');
    const record = {
      id,
      date: excelDate(rowValue(row, ['Date']), XLSX) || todayDate(),
      projectId: excelCellText(rowValue(row, ['Project ID'])),
      projectName: excelCellText(rowValue(row, ['Project Name'])),
      event,
      expected: excelCellText(rowValue(row, ['What Was Supposed to Happen'])),
      actual: excelCellText(rowValue(row, ['What Actually Happened'])),
      missedSignal: excelCellText(rowValue(row, ['First Missed Signal'])),
      rootCause: excelCellText(rowValue(row, ['Root Cause'])),
      impact: excelCellText(rowValue(row, ['Impact'])),
      control: excelCellText(rowValue(row, ['Permanent Control / Prevention Rule'])),
      owner: excelCellText(rowValue(row, ['Owner'])).toUpperCase(),
      dueDate: excelDate(rowValue(row, ['Due Date']), XLSX),
      status: excelCellText(rowValue(row, ['Status'])) || 'Open',
      evidenceReference: excelCellText(rowValue(row, ['Evidence / Reference'])),
      sourceSheet: 'Lessons Learned',
      sourceRow: excelRowNumber(row),
      source: compactExcelSource(row),
      importWarnings: missing,
      importedFromExcel: true,
      importedAt: new Date().toISOString()
    };
    updateProjectName(db, record);
    const result = upsertById(db.lessons, record);
    if (result === 'created') created++; else updated++;
  }
  return { created, updated, warnings: warnings.slice(0, 25), warningCount: warnings.length };
}

function importWorkbookToDb(db, buffer, filename, actor) {
  const XLSX = optionalXlsx();
  if (!XLSX) {
    throw new Error('Excel import requires the xlsx package. Run npm install after extracting this updated project.');
  }
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const summary = {
    setupSections: importSetupRows(db, sheetRows(workbook, 'Setup', XLSX)),
    projects: importProjects(db, sheetRows(workbook, 'Project Register', XLSX), XLSX),
    tasks: importTasks(db, sheetRows(workbook, 'Master Productivity Tracker', XLSX), XLSX),
    nxpTasks: importTasks(db, sheetRows(workbook, 'Export-NXP Checklist', XLSX), XLSX, { nxp: true }),
    actions: { skipped: true, reason: 'Action Log module removed; historical records preserved' },
    delays: importDelays(db, sheetRows(workbook, 'Delay & Escalation Tracker', XLSX), XLSX),
    approvals: importApprovals(db, sheetRows(workbook, 'Executive Approval Tracker', XLSX), XLSX),
    risks: { skipped: true, reason: 'Risk module removed; historical records preserved' },
    lessons: importLessons(db, sheetRows(workbook, 'Lessons Learned', XLSX), XLSX)
  };
  summary.integrationWarnings = Object.entries(summary)
    .filter(([key, value]) => value && Array.isArray(value.warnings))
    .flatMap(([key, value]) => value.warnings.map(warning => ({ module: key, ...warning })));
  summary.integrationWarningCount = Object.values(summary).reduce((total, value) => total + Number(value && value.warningCount || 0), 0);
  syncUsersFromSpreadsheetStaff(db);
  syncOperationalAutomation(db, actor);
  db.importHistory = db.importHistory || [];
  db.importHistory.unshift({
    id: crypto.randomUUID(),
    filename: sanitizeFilename(filename || 'tracker.xlsx'),
    importedAt: new Date().toISOString(),
    importedBy: actor ? actor.displayName : 'System',
    summary
  });
  db.importHistory = db.importHistory.slice(0, 20);
  return summary;
}

function renderExcelImport(db, user, message = '', summary = null) {
  const history = (db.importHistory || []).slice(0, 8).map(item => {
    const totalProjects = item.summary?.projects ? `${item.summary.projects.created || 0}/${item.summary.projects.updated || 0}` : '0/0';
    const totalTasks = item.summary?.tasks ? `${item.summary.tasks.created || 0}/${item.summary.tasks.updated || 0}` : '0/0';
    const warnings = Number(item.summary?.integrationWarningCount || 0);
    const fileName = escapeHtml(item.filename || '');
    const fileCell = item.workbookBase64 ? `<a class="link" href="/excel-import/download/${escapeAttr(item.id)}">${fileName}</a><br><small>Workbook stored persistently</small>` : fileName;
    return `<tr><td>${escapeHtml(fmtDate(item.importedAt))}</td><td>${fileCell}</td><td>${escapeHtml(item.importedBy || '')}</td><td>${escapeHtml(totalProjects)}</td><td>${escapeHtml(totalTasks)}</td><td>${escapeHtml(JSON.stringify(item.summary?.delays || {}))}</td><td>${escapeHtml(warnings)}</td></tr>`;
  }).join('') || '<tr><td colspan="7">No Excel imports yet.</td></tr>';
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const warningsHtml = summary?.integrationWarnings?.length ? `<section class="panel-soft warning-panel"><h2>Integration warnings to review</h2><p>These rows were imported where possible, but the listed missing fields can affect smooth routing, accountability, automation, or reporting.</p><div class="table-wrap"><table><thead><tr><th>Module</th><th>Sheet</th><th>Row</th><th>ID</th><th>Warning</th></tr></thead><tbody>${summary.integrationWarnings.slice(0, 25).map(w => `<tr><td>${escapeHtml(w.module || '')}</td><td>${escapeHtml(w.sheet || '')}</td><td>${escapeHtml(w.row || '')}</td><td>${escapeHtml(w.id || '')}</td><td>${escapeHtml((w.warnings || []).join(', '))}</td></tr>`).join('')}</tbody></table></div></section>` : '';
  const summaryHtml = summary ? `<div class="import-summary"><h2>Import Result</h2><pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre></div>` : '';
  const fieldGuide = `<section class="panel-soft"><h2>Integration readiness fields now preserved</h2><p>The importer now keeps control fields that prevent poor routing or incomplete reporting when moving from Excel into the portal.</p><div class="field-grid"><div><b>Project fields</b><span>Deadline days, task totals, overdue count, blocked/delayed count, open approvals, current blocker, next milestone, decision required, last update, project folder link.</span></div><div><b>Task fields</b><span>Week start, days outstanding, days to due, overdue flag, blocker owner, approval ID, productivity score, update aging, evidence type, impact if delayed.</span></div><div><b>Delay fields</b><span>Required decision/action, days outstanding, overdue flag, estimated days impact, escalation level, evidence link, resolution/recovery plan, closed date.</span></div><div><b>NXP task fields</b><span>Workstream, required-by stage, approver/external party, blocker, escalation required, evidence link, and notes.</span></div><div><b>Validation fields</b><span>Each imported record stores source sheet, source row, original Excel values, and import warnings for review.</span></div></div></section>`;
  return page('Excel Import', `<div class="panel"><h1>Excel Tracker Integration</h1><p>Level 5 users can upload an Olutech tracker workbook. The system reads the workbook sheets and distributes records into Projects, Tasks, Delays, Approvals, Lessons, and NXP/documentation tasks.</p><p><b>Storage status:</b> ${escapeHtml(persistenceLabel())}. Imported workbook archives are kept in the database so the import record remains available after logout and server restarts.</p>${notice}<details class="create-box" open><summary>Upload Excel tracker</summary><form class="form-grid" method="post" action="/excel-import/upload" enctype="multipart/form-data"><label class="wide">Excel File<input type="file" name="excel" accept=".xlsx,.xls,.xlsm" required></label><label class="wide">Import Note<textarea name="note" placeholder="Optional note for the audit log"></textarea></label><button class="button">Import Excel Tracker</button></form></details><section class="panel-soft"><h2>What the importer does</h2><ul><li><b>Project Register</b> updates project records and preserves management dashboard fields.</li><li><b>Master Productivity Tracker</b> creates or updates assignable tasks with overdue, blocker, evidence, and productivity fields.</li><li><b>Export-NXP Checklist</b> becomes NXP / Documentation Checklist tasks with workstream and required-stage details.</li><li><b>Delay & Escalation Tracker</b> imports only active delays; resolved delays are removed.</li><li><b>Setup</b> refreshes dropdowns, statuses, priorities, evidence types, escalation levels, and staff/accountable parties.</li></ul></section>${fieldGuide}${warningsHtml}${summaryHtml}<div class="table-wrap"><table><thead><tr><th>Date</th><th>File</th><th>Imported By</th><th>Projects Created/Updated</th><th>Tasks Created/Updated</th><th>Delays</th><th>Warnings</th></tr></thead><tbody>${history}</tbody></table></div></div>`, user);
}

function hasProjectDependencies(db, projectId) {
  const keys = ['tasks', 'delays', 'approvals', 'nxpChecklist', 'lessons', 'files'];
  return keys.some(key => (db[key] || []).some(item => item.projectId === projectId));
}


function renderLessons(db, user, message = '') {
  const statusValues = ['Open', 'In Progress', 'Control Added', 'Completed', 'Closed'];
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const create = `<details class="create-box" open><summary>Add new lesson learned</summary><form class="form-grid" method="post" action="/lessons/new"><label>Date<input type="date" name="date" value="${todayDate()}"></label><label>Project<select name="projectId">${projectOptionsHtml(db, '', true)}</select></label><label>Owner${staffInputHtml(db, 'owner', user.displayName)}</label><label>Status<select name="status">${statusOptionsHtml(statusValues, 'Open')}</select></label><label>Due Date<input type="date" name="dueDate"></label><label class="wide">Event / Issue<textarea name="event" required placeholder="What happened? e.g. Truck was not confirmed early enough"></textarea></label><label class="wide">What was supposed to happen?<textarea name="expected" placeholder="State the expected process or standard."></textarea></label><label class="wide">What actually happened?<textarea name="actual" placeholder="Describe the real situation clearly."></textarea></label><label>First missed signal<textarea name="missedSignal"></textarea></label><label>Root cause<textarea name="rootCause" required></textarea></label><label>Impact<textarea name="impact"></textarea></label><label>Evidence / Reference<textarea name="evidenceReference" placeholder="File name, WhatsApp evidence, email reference, etc."></textarea></label><label class="wide">Permanent control / prevention rule<textarea name="control" required placeholder="What rule should stop this from happening again?"></textarea></label><button class="button">Create Lesson</button></form></details>`;

  const rows = db.lessons.map(l => {
    const edit = `<details><summary>Edit lesson</summary><form class="record-form" method="post" action="/lessons/update"><input type="hidden" name="id" value="${escapeAttr(l.id)}"><label>Date<input type="date" name="date" value="${escapeAttr(fmtDate(l.date))}"></label><label>Project<select name="projectId">${projectOptionsHtml(db, l.projectId || '', true)}</select></label><label>Owner${staffInputHtml(db, 'owner', l.owner || '')}</label><label>Status<select name="status">${statusOptionsHtml(statusValues, l.status || 'Open')}</select></label><label>Due Date<input type="date" name="dueDate" value="${escapeAttr(fmtDate(l.dueDate))}"></label><label class="wide">Event / Issue<textarea name="event" required>${escapeHtml(l.event || '')}</textarea></label><label class="wide">Expected<textarea name="expected">${escapeHtml(l.expected || '')}</textarea></label><label class="wide">Actual<textarea name="actual">${escapeHtml(l.actual || '')}</textarea></label><label>Missed Signal<textarea name="missedSignal">${escapeHtml(l.missedSignal || '')}</textarea></label><label>Root Cause<textarea name="rootCause" required>${escapeHtml(l.rootCause || '')}</textarea></label><label>Impact<textarea name="impact">${escapeHtml(l.impact || '')}</textarea></label><label>Evidence / Reference<textarea name="evidenceReference">${escapeHtml(l.evidenceReference || '')}</textarea></label><label class="wide">Permanent Control / Prevention Rule<textarea name="control" required>${escapeHtml(l.control || '')}</textarea></label><button class="button">Save Lesson</button></form>${user.clearance >= 3 ? deleteButton('/lessons/delete', l.id, 'Delete this lesson learned record?') : ''}</details>`;
    return `<tr><td>${escapeHtml(l.id)}<br><small>${escapeHtml(fmtDate(l.date))}</small></td><td><b>${escapeHtml(l.event)}</b><br><small>${escapeHtml(l.actual || '')}</small>${edit}</td><td>${escapeHtml(l.projectId || '')}</td><td>${escapeHtml(l.owner || '')}</td><td>${escapeHtml(l.rootCause || '')}</td><td>${escapeHtml(l.control || '')}</td><td>${pill(l.status, statusClass(l.status))}<br><small>${escapeHtml(fmtDate(l.dueDate))}</small></td></tr>`;
  }).join('');

  return page('Lessons Learned', `<div class="panel"><h1>Lessons Learned</h1><p>Use this module to make sure mistakes become permanent controls, not repeated issues. Level 2+ users can create and update lessons; Level 3+ users can delete records.</p>${notice}${create}<div class="table-wrap"><table><thead><tr><th>ID / Date</th><th>Event / Issue</th><th>Project</th><th>Owner</th><th>Root Cause</th><th>Control / Prevention Rule</th><th>Status / Due</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}


function renderAttendance(db, user, message = '', selectedEmployee = '') {
  if (!isTimeClockUser(user)) {
    return page('Time Clock', `<div class="panel"><h1>Time Clock Not Required</h1><p>Your account is excluded from clock-in / clock-out tracking. Other workspace features remain available.</p><p><a class="button" href="/dashboard">Back to dashboard</a></p></div>`, user);
  }
  const settings = workSettings(db);
  const today = localDate(new Date(), db);
  const nowText = formatLocalDateTime(new Date().toISOString(), db);
  const openRecord = openAttendanceRecord(db, user.id);
  const todayRecords = attendanceRecordsForUserDate(db, user.id, today);
  const todayMs = attendanceTotalMs(todayRecords);
  const expectedMs = expectedWorkdayMs(db);
  const dayFlag = attendanceDayFlag(db, user.id, today);
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const autoDue = openRecord ? attendanceAutomaticDueAt(db, openRecord) : null;
  const pulse = openRecord ? `<script>setInterval(async function(){try{const r=await fetch('/attendance/pulse',{credentials:'same-origin',cache:'no-store'});if(r.ok&&(await r.json()).closed)location.reload();}catch(_){}},30000);</script>` : '';
  const actionBox = openRecord
    ? `<form class="attendance-action-form" method="post" action="/attendance/clock-out"><label class="wide">Work Summary / Handover Note<textarea name="workSummary" placeholder="Optional: What did you work on today? Any handover notes?"></textarea></label><button class="button clock-button out">Clock Out</button></form>`
    : `<form class="attendance-action-form" method="post" action="/attendance/clock-in"><label class="wide">Start Note<textarea name="notes" placeholder="Optional: What are you starting with today?"></textarea></label><button class="button clock-button in">Clock In</button></form>`;

  const timeClockUsers = (db.users || []).filter(member => member.username !== 'admin' && isTimeClockUser(member));
  const teamToday = Number(user.clearance || 1) >= 5 ? `<section class="panel attendance-panel"><h2>Team Today</h2><p>Level 5 view of today's work-hour status for staff with time-clock access. AKIN is excluded.</p><div class="attendance-team-grid">${timeClockUsers.map(member => {
    const memberOpen = openAttendanceRecord(db, member.id);
    const memberMs = userDailyAttendanceMs(db, member.id, today);
    const flag = attendanceDayFlag(db, member.id, today);
    return `<div class="attendance-person"><b>${escapeHtml(member.displayName)}</b><span>${pill(memberOpen ? 'Clocked In' : flag, attendanceFlagClass(memberOpen ? 'Clocked In' : flag))}</span><small>${escapeHtml(formatDuration(memberMs))} today</small></div>`;
  }).join('')}</div></section>` : '';

  const isLevel5 = Number(user.clearance || 1) >= 5;
  const employeeIds = new Set((db.attendance || []).map(r => r.userId).filter(Boolean));
  for (const member of db.users || []) employeeIds.add(member.id);
  const employeeChoices = [...employeeIds].map(id => {
    const member = (db.users || []).find(u => u.id === id);
    const history = (db.attendance || []).find(r => r.userId === id);
    return { id, label: member?.displayName || history?.displayName || 'Former employee' };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const selectedId = isLevel5 && employeeIds.has(selectedEmployee) ? selectedEmployee : user.id;
  const selectedMember = employeeChoices.find(entry => entry.id === selectedId);
  const employeeFilter = isLevel5 ? `<form class="attendance-filter" method="get" action="/attendance"><label>View employee records<select name="employee" onchange="this.form.submit()">${employeeChoices.map(entry => `<option value="${escapeAttr(entry.id)}" ${entry.id === selectedId ? 'selected' : ''}>${escapeHtml(entry.label)}</option>`).join('')}</select></label><button class="button secondary">View Records</button></form>` : '';
  const records = attendanceVisibleRecords(db, user).filter(record => record.userId === selectedId).slice(0, 120);
  const rows = records.map(record => {
    const hours = formatDuration(recordDurationMs(record));
    const status = record.clockOutAt ? (record.autoClockOut ? 'Auto Clocked Out' : 'Completed') : 'Clocked In';
    const canDelete = Number(user.clearance || 1) >= 5 ? deleteButton('/attendance/delete', record.id, 'Delete this attendance record?') : '';
    return `<tr><td>${escapeHtml(record.workDate || '')}</td><td><b>${escapeHtml(record.displayName || record.username || '')}</b><br><small>${escapeHtml(record.username || '')}</small></td><td>${escapeHtml(formatLocalDateTime(record.clockInAt, db))}</td><td>${escapeHtml(record.clockOutAt ? formatLocalDateTime(record.clockOutAt, db) : 'Still working')}</td><td><b>${escapeHtml(hours)}</b></td><td>${pill(status, status === 'Completed' || status === 'Auto Clocked Out' ? 'good' : 'info')}</td><td>${escapeHtml(record.notes || record.workSummary || '')}${canDelete}</td></tr>`;
  }).join('') || '<tr><td colspan="7">No attendance records found.</td></tr>';

  return page('Time Clock', `<div class="panel"><h1>Employee Clock In / Clock Out</h1><p>Personal time-clock records are kept separately for each employee. Level 5 may switch between employees.</p><div class="notice"><b>Automatic Clock-Out Policy (Africa/Lagos):</b> The official workday runs from <b>9:00 AM to 6:00 PM</b>. Sessions started before 6:00 PM close automatically at 6:00 PM. Sessions started <b>at or after 6:00 PM</b> close automatically <b>30 minutes after clock-in</b>, even when that passes midnight. Early manual clock-out remains available. If the application is idle, the scheduled checkout is recorded on the next request using its actual due time.</div>${notice}<section class="attendance-hero"><div class="attendance-status-card"><span>Current Status</span><strong>${escapeHtml(openRecord ? 'Clocked In' : 'Clocked Out')}</strong><small>${escapeHtml(openRecord ? `Started at ${formatLocalDateTime(openRecord.clockInAt, db)}` : `Current time: ${nowText}`)}</small></div><div class="attendance-status-card"><span>Today's Hours</span><strong>${escapeHtml(formatDuration(todayMs))}</strong><small>${escapeHtml(dayFlag)} / Expected ${escapeHtml(formatDuration(expectedMs))}</small></div><div class="attendance-status-card"><span>Workday Time Frame</span><strong>${escapeHtml(settings.workdayStart)} - ${escapeHtml(settings.workdayEnd)}</strong><small>${escapeHtml(settings.timeZone)}</small></div></section><details class="create-box" open><summary>${openRecord ? 'Clock out for today' : 'Clock in for today'}</summary>${autoDue ? `<p class="notice">Automatic clock-out scheduled: ${escapeHtml(formatLocalDateTime(autoDue.toISOString(), db))} (${escapeHtml(settings.timeZone)}).</p>` : ''}${actionBox}</details></div>${teamToday}<div class="panel"><h2>${isLevel5 ? `Attendance Records: ${escapeHtml(selectedMember?.label || user.displayName)}` : 'My Attendance Records'}</h2><p>${isLevel5 ? 'Choose an employee below to view that person’s records separately.' : 'You can see only your own clock-in and clock-out records.'}</p>${employeeFilter}<div class="table-wrap"><table><thead><tr><th>Date</th><th>Employee</th><th>Clock In</th><th>Clock Out</th><th>Hours</th><th>Status</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div></div>${pulse}`, user);
}

function renderFiles(db, user, message = '') {
  const allowed = db.files.filter(f => Number(user.clearance) >= Number(f.requiredClearance || 1));
  const projectOptions = db.projects.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.id)} - ${escapeHtml(p.name)}</option>`).join('');
  const clearanceOptions = [1, 2, 3, 4, 5].filter(level => level <= user.clearance).map(level => `<option value="${level}">${escapeHtml(clearanceName(level))}</option>`).join('');
  const rows = allowed.map(f => {
    const action = f.type === 'external-link'
      ? `<a class="link" href="${escapeAttr(f.externalUrl)}" target="_blank" rel="noopener">Open link</a>`
      : `<a class="link" href="/files/download/${escapeAttr(f.id)}">Download</a>`;
    const canManage = user.clearance >= 3 || samePerson(f.uploadedBy, user.displayName);
    const selectedClearance = [1, 2, 3, 4, 5].filter(level => level <= user.clearance).map(level => formOption(level, clearanceName(level), f.requiredClearance || 1)).join('');
    const edit = canManage ? `<details><summary>Edit file details</summary><form class="record-form" method="post" action="/files/update"><input type="hidden" name="id" value="${escapeAttr(f.id)}"><label>Title<input name="title" value="${escapeAttr(f.title || f.originalName || '')}" required></label><label>Project<select name="projectId">${projectOptionsHtml(db, f.projectId || '', true)}</select></label><label>Module<input name="module" value="${escapeAttr(f.module || '')}"></label><label>Required Clearance<select name="requiredClearance">${selectedClearance}</select></label><label class="wide">Notes<textarea name="notes">${escapeHtml(f.notes || '')}</textarea></label>${f.type === 'external-link' ? `<label class="wide">External URL<input name="externalUrl" value="${escapeAttr(f.externalUrl || '')}"></label>` : ''}<button class="button">Save File Details</button></form>${deleteButton('/files/delete', f.id, 'Delete this file record? Local uploaded files will be removed from storage.')}</details>` : '';
    return `<tr><td><b>${escapeHtml(f.title || f.originalName)}</b><br><small>${escapeHtml(f.originalName || '')}</small>${edit}</td><td>${escapeHtml(f.projectId || '')}</td><td>${escapeHtml(f.module || '')}</td><td>${escapeHtml(f.uploadedBy || '')}</td><td>${escapeHtml(f.uploadedAt ? fmtDate(f.uploadedAt) : '')}</td><td>${pill(clearanceName(f.requiredClearance), f.requiredClearance >= 3 ? 'bad' : f.requiredClearance === 2 ? 'warn' : 'good')}</td><td>${action}</td></tr>`;
  }).join('');
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  return page('Files', `<div class="panel"><h1>Secure File Storage</h1><p>Employees can upload project files. Each file has a clearance level; users can only access files at or below their level. Uploaders and Level 3+ users can update file details.</p>${notice}<details class="create-box" open><summary>Upload project file</summary><form class="form-grid" method="post" action="/files/upload" enctype="multipart/form-data"><label>Title<input name="title" required placeholder="e.g. NXP receipt, truck evidence, inspection report"></label><label>Project<select name="projectId"><option value="">General / No project</option>${projectOptions}</select></label><label>Module<select name="module"><option>Task Evidence</option><option>NXP Evidence</option><option>Risk Evidence</option><option>Delay Evidence</option><option>Approval Evidence</option><option>Contract / Buyer Document</option><option>Management Report</option></select></label><label>Required Clearance<select name="requiredClearance">${clearanceOptions}</select></label><label class="wide">Notes<textarea name="notes"></textarea></label><label class="wide">File<input type="file" name="file" required></label><button class="button">Upload File</button></form></details><div class="table-wrap"><table><thead><tr><th>File</th><th>Project</th><th>Module</th><th>Uploaded By</th><th>Date</th><th>Clearance</th><th>Access</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}

function clearanceSelectOptions(selected, maxLevel = 5) {
  const current = Number(selected || 1);
  const options = [];
  for (let level = 1; level <= maxLevel; level++) options.push(`<option value="${level}" ${current === level ? 'selected' : ''}>${escapeHtml(clearanceName(level))}</option>`);
  return options.join('');
}


function maskSecret(value) {
  const text = String(value || '');
  if (!text) return 'Not set';
  if (text.length <= 8) return 'Set';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function renderStorageStatus(db, user, force = false) {
  const env = kvEnv();
  const health = await checkCloudStorage(force);
  const mode = storageMode();
  const statusPill = health.ok ? pill('Persistent Storage OK', 'good') : pill('Storage Needs Attention', mode === 'local' ? 'warn' : 'bad');
  const latestImport = (db.importHistory || [])[0];
  const openClockIns = (db.attendance || []).filter(record => record && record.clockInAt && !record.clockOutAt).length;
  const uploadedFiles = (db.files || []).length;
  const rows = `
    <tr><th>Current storage mode</th><td>${escapeHtml(persistenceLabel())}</td></tr>
    <tr><th>Cloud health</th><td>${statusPill}<br><small>${escapeHtml(health.message)}</small></td></tr>
    <tr><th>Provider</th><td>${escapeHtml(health.provider || 'none')}</td></tr>
    <tr><th>KV_REST_API_URL / UPSTASH_REDIS_REST_URL</th><td>${escapeHtml(maskSecret(env.url))}</td></tr>
    <tr><th>KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN</th><td>${escapeHtml(env.hasToken ? 'Set' : 'Not set')}</td></tr>
    <tr><th>OLUTECH_PERSISTENCE_KEY</th><td>${escapeHtml(PERSISTENCE_KEY)}</td></tr>
    <tr><th>Login session duration</th><td>${escapeHtml(String(SESSION_DURATION_DAYS))} day(s)</td></tr>
    <tr><th>Persisted active login sessions</th><td>${escapeHtml(String((db.authSessions || []).length))}</td></tr>
    <tr><th>Open clock-in records</th><td>${escapeHtml(String(openClockIns))}</td></tr>
    <tr><th>Excel import records</th><td>${escapeHtml(String((db.importHistory || []).length))}${latestImport ? `<br><small>Latest: ${escapeHtml(latestImport.fileName || latestImport.originalFileName || '')}</small>` : ''}</td></tr>
    <tr><th>Uploaded file records</th><td>${escapeHtml(String(uploadedFiles))}</td></tr>
    <tr><th>Last database update</th><td>${escapeHtml(db.meta && db.meta.updatedAt ? fmtDate(db.meta.updatedAt) : 'Not recorded')}</td></tr>`;
  const guidance = mode === 'temporary-vercel'
    ? `<div class="notice danger"><b>Action required:</b> this Vercel deployment does not have working cloud storage variables. Add KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, then redeploy. Until then, the system can reset.</div>`
    : `<div class="notice"><b>Persistence check:</b> use this page after every Vercel redeploy. If this page does not show Persistent Storage OK, do not upload important Excel files or rely on Time Clock until storage is fixed.</div>`;
  const counts = operationalCounts(db);
  const resetWidget = `<div class="panel"><h2>Start Fresh — Operational Records</h2>
    <p>This removes every <b>project, task, approval, and delay</b>, plus related task timers, workflow handoffs, NXP checklist tasks, project/task conversations and risks linked to deleted records. <b>Employees, passwords, attendance, files, lessons, import history, and audit records stay intact.</b></p>
    <p><b>Current records:</b> ${counts.projects} projects · ${counts.tasks} tasks · ${counts.approvals} approvals · ${counts.delays} delays.</p>
    <p class="notice danger">This is irreversible through the PMS interface. First download an external backup and ensure other employees are not updating the system. The server must also verify a separate backup before clearing any data.</p>
    <p><a class="button secondary" href="/admin/operations-backup">Download full database backup (JSON)</a></p>
    <details class="create-box"><summary>Confirm permanent reset</summary>
      <form class="form-grid" method="post" action="/admin/operations-reset" onsubmit="return confirm('LAST CHECK: remove ALL projects, tasks, approvals and delays? A verified backup is required.');">
        <label class="wide">Type RESET OPERATIONS to confirm<input name="confirmation" autocomplete="off" required placeholder="RESET OPERATIONS"></label>
        <label class="wide">Your current Level 5 password<input type="password" name="password" autocomplete="current-password" required></label>
        <label class="wide"><span><input type="checkbox" name="acknowledged" value="yes" required style="width:auto; min-height:unset; margin-right:8px">I have downloaded the backup and understand the selected records will be permanently cleared.</span></label>
        <button class="button danger-button" type="submit">Clear Projects, Tasks, Approvals and Delays</button>
      </form>
    </details>
  </div>`;
  return page('Storage Status', `<div class="panel"><h1>Storage & Persistence Status</h1><p>This page confirms whether the system is using durable cloud storage or temporary local storage. Level 5 only.</p>${guidance}<form method="get" action="/storage-status"><input type="hidden" name="check" value="1"><button class="button">Run Storage Test</button></form><div class="table-wrap"><table class="key-value"><tbody>${rows}</tbody></table></div></div>${resetWidget}`, user);
}

function renderUsers(db, user, message = '') {
  const liveUsers = activeSessionUserIds(db);
  const rows = db.users.map(u => {
    const online = liveUsers.has(u.id);
    const accountEnabled = u.accountEnabled !== false;
    const sessionStatus = online ? pill('Active', 'good') : pill('Inactive', 'bad');
    const accountStatus = accountEnabled ? pill('Enabled', 'good') : pill('Disabled', 'bad');
    const today = localDate(new Date(), db);
    const workOpen = isTimeClockUser(u) ? openAttendanceRecord(db, u.id) : null;
    const workStatusText = isTimeClockUser(u) ? (workOpen ? 'Clocked In' : attendanceDayFlag(db, u.id, today)) : 'Excluded';
    const workStatus = isTimeClockUser(u) ? pill(workStatusText, attendanceFlagClass(workStatusText)) : pill('Excluded', 'muted');
    const todayHours = isTimeClockUser(u) ? formatDuration(userDailyAttendanceMs(db, u.id, today)) : 'N/A';
    const isAdminAccount = normalizeLoginEmail(u.email || u.username) === `admin@${OFFICIAL_EMAIL_DOMAIN}`;
    const emailField = isAdminAccount
      ? `<label>Official Email<input name="email" type="email" value="${escapeAttr(u.email || u.username || '')}" readonly></label>`
      : `<label>Official Email<input name="email" type="email" value="${escapeAttr(u.email || u.username || '')}" required placeholder="name@olutechagro.com"></label>`;
    const isCurrentUser = u.id === user.id;
    const canDeleteUser = !isAdminAccount && !isCurrentUser;
    const deleteUserControl = canDeleteUser
      ? `<div class="danger-zone"><h4>Delete user</h4><p class="muted">This removes the login account and staff suggestion only. Existing projects, tasks, chats and history stay intact.</p><form method="post" action="/admin/user-delete" onsubmit="return confirm('Delete this user account? Existing tasks and project history will remain.');"><input type="hidden" name="id" value="${escapeAttr(u.id)}"><button class="button danger-button">Delete User</button></form></div>`
      : `<p class="muted">This protected account cannot be deleted here.</p>`;
    return `<tr><td><b>${escapeHtml(u.displayName)}</b><br><small>${escapeHtml(u.email || u.username)}</small></td><td>${escapeHtml(u.role)}</td><td>${escapeHtml(clearanceName(u.clearance))}</td><td>${sessionStatus}</td><td>${workStatus}<br><small>${escapeHtml(todayHours)} today</small></td><td>${accountStatus}</td><td>${escapeHtml(u.lastLoginAt ? fmtDate(u.lastLoginAt) : '')}</td><td><details><summary>Edit user</summary><form class="record-form" method="post" action="/admin/user-update"><input type="hidden" name="id" value="${escapeAttr(u.id)}">${emailField}<label>Display Name<input name="displayName" list="employeeList" value="${escapeAttr(u.displayName || '')}" required placeholder="Employee name">${staffDatalistHtml(db, 'employeeList', true)}</label><label>Role<input name="role" value="${escapeAttr(u.role || '')}" placeholder="Job role / responsibility"></label><label>Clearance<select name="clearance">${clearanceSelectOptions(u.clearance, 5)}</select></label><label>Account Access<select name="accountEnabled"><option value="true" ${accountEnabled ? 'selected' : ''}>Enabled - can log in</option><option value="false" ${!accountEnabled ? 'selected' : ''}>Disabled - cannot log in</option></select></label><label class="wide">Change / Reset Password <small>Level 5 only. User will be asked to change it after login.</small><input name="password" type="password" placeholder="Leave blank to keep current password"></label><button class="button">Save User</button></form>${deleteUserControl}</details></td></tr>`;
  }).join('');
  const notice = message ? `<div class="notice">${escapeHtml(message)}</div>` : '';
  const createForm = `<details class="create-box"><summary>Add new employee / user</summary><form class="form-grid" method="post" action="/admin/user-new"><label>Display Name<input name="displayName" list="employeeList" required placeholder="e.g. TUNDE">${staffDatalistHtml(db, 'employeeList', true)}</label><label>Official Email<input name="email" type="email" required placeholder="name@olutechagro.com"></label><label>Role<input name="role" required placeholder="e.g. Export Documentation Officer"></label><label>Clearance<select name="clearance">${clearanceSelectOptions(2, 5)}</select></label><label>Account Access<select name="accountEnabled"><option value="true" selected>Enabled - can log in</option><option value="false">Disabled - cannot log in</option></select></label><label class="wide">Temporary Password<input type="password" name="password" required placeholder="Set a temporary password"></label><button class="button">Create Employee User</button></form><p class="muted">New employees are saved into the internal staff list and will appear as suggestions when assigning projects, workflow steps, tasks, delays, approvals, risks, lessons and other ownership fields.</p></details>`;
  return page('Users', `<div class="panel"><h1>User, Role & Clearance Management</h1><p>Level 5 can add completely new employees, update users, delete user accounts, set official Olutech Agro email login, role, clearance level and temporary password. Employee fields across the system are type-to-search inputs. Akin and System Administrator remain login/approval accounts but are excluded from task delivery assignments, weekly deliverables reports, and employee scorecards.</p>${notice}${createForm}<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Clearance</th><th>Active Session</th><th>Work Status</th><th>Account Access</th><th>Last Login</th><th>Manage</th></tr></thead><tbody>${rows}</tbody></table></div></div>`, user);
}

function loginPage(error = '') {
  return page('Login', `<div class="login-screen"><section class="login-card jira-login-card" aria-label="Olutech Agro login"><div class="auth-logo jira-auth-logo"><span class="brand-mark">OA</span><span>OLUTECH AGRO</span></div><h1>Log in to continue</h1><p class="auth-subtitle">Use your official @olutechagro.com email address to access the workspace.</p>${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}<form class="auth-form jira-auth-form" method="post" action="/login"><label class="sr-only" for="login-email">Official email</label><div class="jira-input-row"><input id="login-email" name="email" type="email" autocomplete="username" required placeholder="name@olutechagro.com"><span class="input-edit-icon" aria-hidden="true">✎</span></div><label class="sr-only" for="login-password">Password</label><div class="jira-input-row password-row"><input id="login-password" type="password" name="password" autocomplete="current-password" required placeholder="Enter password"><span class="password-eye" aria-hidden="true">◉</span></div><button class="button login-button">Log in</button></form><div class="auth-divider jira-auth-divider"><span>Secure employee access</span></div><div class="jira-auth-options"><div><b>Official email only</b><span>Access is restricted to Olutech Agro staff accounts.</span></div><div><b>Password protected</b><span>Users can change their passwords after login.</span></div><div><b>Clearance controlled</b><span>Permissions are based on each employee's clearance level.</span></div></div><div class="auth-links"><a href="#" onclick="return false;">Can't log in?</a><span>•</span><a href="#" onclick="return false;">Contact system admin</a></div></section></div>`, null);
}

function renderChangePassword(user, message = '', isError = false) {
  const notice = message ? `<div class="${isError ? 'error' : 'notice'}">${escapeHtml(message)}</div>` : '';
  const prompt = user.mustChangePassword ? '<p class="notice">Please change your temporary password before continuing.</p>' : '';
  const title = Number(user.clearance || 1) >= 5 ? 'Password Administration' : 'Change Password';
  const helper = Number(user.clearance || 1) >= 5
    ? 'Level 5 users can keep this page for their own password. To change another employee password, use Users → Edit user → Change / Reset Password.'
    : 'Update your temporary password. After this is completed, this menu will be removed from your portal.';
  return page('Change Password', `<div class="panel narrow-panel"><h1>${title}</h1><p>${escapeHtml(helper)}</p><p>Signed in as <b>${escapeHtml(user.email || user.username || '')}</b>.</p>${prompt}${notice}<form class="form-grid" method="post" action="/change-password"><label class="wide">Current Password<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>New Password<input type="password" name="newPassword" autocomplete="new-password" minlength="8" required placeholder="Minimum 8 characters"></label><label>Confirm New Password<input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required></label><button class="button">Update Password</button></form></div>`, user);
}

function renderPasswordAccessClosed(user, message = 'Your password has already been changed. Contact a Level 5 administrator if you need another reset.') {
  return page('Password Updated', `<div class="panel narrow-panel"><h1>Password Updated</h1><div class="notice">${escapeHtml(message)}</div><p>The password-change feature is only shown to normal users while they are still using a temporary password.</p><a class="button" href="/dashboard">Back to dashboard</a></div>`, user);
}


function headerValue(req, name) {
  const value = req.headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return value ? String(value) : '';
}

function normalizeRoutePath(value) {
  let route = String(value || '').trim();
  if (!route || route === 'undefined' || route === 'null') return '';
  try { route = decodeURIComponent(route); } catch (_) {}
  if (/^https?:\/\//i.test(route)) {
    try { route = new URL(route).pathname; } catch (_) {}
  }
  route = route.split('?')[0];
  if (!route.startsWith('/')) route = '/' + route;
  route = route.replace(/\/+/g, '/');
  return route || '/';
}

function requestUrl(req) {
  const host = req.headers.host || 'localhost';
  const parsed = new URL(req.url || '/', `http://${host}`);
  const rewrittenToApi = parsed.pathname === '/api/index.js' || parsed.pathname === '/api' || parsed.pathname === '/api/';
  if (rewrittenToApi) {
    const preservedPath = parsed.searchParams.get('__path')
      || parsed.searchParams.get('path')
      || headerValue(req, 'x-original-url')
      || headerValue(req, 'x-rewrite-url')
      || headerValue(req, 'x-forwarded-uri')
      || headerValue(req, 'x-invoke-path');
    const routePath = normalizeRoutePath(preservedPath);
    if (routePath && !routePath.startsWith('/api')) {
      parsed.pathname = routePath;
      parsed.searchParams.delete('__path');
      parsed.searchParams.delete('path');
    }
  }
  return parsed;
}

async function handleRequest(req, res) {
  const db = await loadDb();
  let maintenanceChanged = false;
  maintenanceChanged = syncSessionActivity(db) || maintenanceChanged;
  // On Vercel, no process runs continuously. Reconcile due attendance on each request
  // using the exact scheduled checkout time even if this request arrives later.
  maintenanceChanged = autoClockOutAttendance(db) || maintenanceChanged;
  if (maintenanceChanged) await saveDb(db);
  const url = requestUrl(req);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/public/')) {
      const file = path.join(ROOT, pathname);
      if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) return notFound(res, null);
      const ext = path.extname(file).toLowerCase();
      const type = ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // Removed modules are disabled, but their historical data is never deleted.
    if (pathname === '/actions' || pathname.startsWith('/actions/') || pathname === '/risks' || pathname.startsWith('/risks/')) {
      const user = requireLogin(req, res, db); if (!user) return;
      return send(res, req.method === 'GET' ? 410 : 403, page('Module retired', '<div class="panel"><h1>Module retired</h1><p>Action Log and Risk Register were removed from the active PMS. Historical records remain stored safely.</p><a class="button" href="/dashboard">Back to dashboard</a></div>', user));
    }

    if (req.method === 'GET' && pathname === '/notifications') {
      const user = requireLogin(req, res, db); if (!user) return;
      res.setHeader('Cache-Control', 'private, no-store');
      return sendJson(res, 200, notificationFeed(db, user));
    }
    if (req.method === 'POST' && pathname === '/notifications/read') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const own = (db.notifications || []).filter(n => n.userId === user.id && !n.readAt && (form.all === 'yes' || n.id === form.id));
      if (own.length) {
        const at = new Date().toISOString();
        own.forEach(n => { n.readAt = at; });
        await saveDb(db);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return sendJson(res, 200, { updated: own.length, ...notificationFeed(db, user) });
    }

    if (req.method === 'POST' && pathname === '/preferences/theme') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      if (!['light', 'dark'].includes(String(form.theme || ''))) return send(res, 400, page('Theme preference', '<div class="panel"><h1>Invalid theme selection</h1></div>', user));
      user.theme = form.theme;
      await saveDb(db);
      return redirect(res, safeReturnTo(form.returnTo, '/dashboard'));
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/login')) {
      const user = currentUser(req, db);
      if (user) return redirect(res, '/dashboard');
      return send(res, 200, loginPage());
    }

    if (req.method === 'POST' && pathname === '/login') {
      const form = await parseUrlEncoded(req);
      const loginEmail = normalizeLoginEmail(form.email || form.username);
      if (!loginEmail.endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`)) {
        return send(res, 401, loginPage('Please use your official Olutech Agro email address.'));
      }
      const user = db.users.find(u => normalizeLoginEmail(u.email || u.username) === loginEmail && u.accountEnabled !== false);
      if (!user || !verifyPassword(form.password || '', user.passwordHash)) {
        return send(res, 401, loginPage('Invalid email or password.'));
      }
      if (user.username !== loginEmail) user.username = loginEmail;
      if (user.email !== loginEmail) user.email = loginEmail;
      user.lastLoginAt = new Date().toISOString();
      const token = crypto.randomUUID();
      addAuthSession(db, token, user.id);
      // `active` is driven only by valid login sessions. Sessions are persisted
      // in the database so Vercel cold starts do not log users out immediately.
      syncSessionActivity(db);
      addAudit(db, user, 'login', `User logged in. Session valid for ${SESSION_DURATION_DAYS} day(s).`);
      await saveDb(db);
      const destination = user.mustChangePassword ? '/change-password?required=1' : '/dashboard';
      res.writeHead(302, { 'Set-Cookie': `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION_SECONDS}`, Location: destination });
      return res.end();
    }

    if (req.method === 'POST' && pathname === '/logout') {
      const token = parseCookies(req).session;
      const session = token ? (sessions.get(token) || storedSession(db, token)) : null;
      const logoutUser = session ? db.users.find(u => u.id === session.userId) : null;
      if (token) removeAuthSession(db, token);
      if (logoutUser) {
        logoutUser.lastLogoutAt = new Date().toISOString();
        addAudit(db, logoutUser, 'logout', 'User logged out');
      }
      syncSessionActivity(db);
      await saveDb(db);
      res.writeHead(302, { 'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', Location: '/login' });
      return res.end();
    }

    if (req.method === 'GET' && pathname === '/change-password') {
      const user = requireLogin(req, res, db); if (!user) return;
      if (Number(user.clearance || 1) < 5 && user.mustChangePassword !== true) {
        return send(res, 200, renderPasswordAccessClosed(user));
      }
      const required = url.searchParams.get('required') === '1';
      return send(res, 200, renderChangePassword(user, required ? 'Your account is using a temporary password. Please set a new password.' : ''));
    }

    if (req.method === 'POST' && pathname === '/change-password') {
      const user = requireLogin(req, res, db); if (!user) return;
      if (Number(user.clearance || 1) < 5 && user.mustChangePassword !== true) {
        return send(res, 403, renderPasswordAccessClosed(user));
      }
      const form = await parseUrlEncoded(req);
      const currentPassword = String(form.currentPassword || '');
      const newPassword = String(form.newPassword || '');
      const confirmPassword = String(form.confirmPassword || '');
      if (!verifyPassword(currentPassword, user.passwordHash)) {
        return send(res, 400, renderChangePassword(user, 'Current password is incorrect.', true));
      }
      if (newPassword.length < 8) {
        return send(res, 400, renderChangePassword(user, 'New password must be at least 8 characters.', true));
      }
      if (newPassword !== confirmPassword) {
        return send(res, 400, renderChangePassword(user, 'New password and confirmation do not match.', true));
      }
      user.passwordHash = hashPassword(newPassword);
      user.mustChangePassword = false;
      user.passwordChangedAt = new Date().toISOString();
      addAudit(db, user, 'password_change', 'User changed their password');
      await saveDb(db);
      if (Number(user.clearance || 1) < 5) {
        return send(res, 200, renderPasswordAccessClosed(user, 'Password updated successfully. The password menu has now been removed from your portal.'));
      }
      return send(res, 200, renderChangePassword(user, 'Password updated successfully.'));
    }

    if (req.method === 'GET' && pathname === '/reports') {
      const user = requireLogin(req, res, db); if (!user) return;
      return redirect(res, '/reports/weekly');
    }
    if (req.method === 'GET' && pathname === '/reports/weekly') {
      const user = requireLogin(req, res, db); if (!user) return;
      try { buildWeeklyReport(db, user, {week:url.searchParams.get('week'),employee:url.searchParams.get('employee'),project:url.searchParams.get('project')}); }
      catch (err) { return send(res, 400, page('Weekly Reports', `<div class="panel"><h1>Invalid report filter</h1><p>${escapeHtml(err.message)}</p><a href="/reports/weekly" class="button">Return to reports</a></div>`, user)); }
      return send(res, 200, renderWeeklyReports(db, user, url));
    }
    if (req.method === 'GET' && pathname === '/reports/weekly.pdf') {
      const user = requireLogin(req, res, db); if (!user) return;
      let report;
      try { report = buildWeeklyReport(db, user, {week:url.searchParams.get('week'),employee:url.searchParams.get('employee'),project:url.searchParams.get('project')}); }
      catch (err) { return send(res, 400, page('Weekly Reports', `<div class="panel"><h1>Invalid report filter</h1><p>${escapeHtml(err.message)}</p></div>`, user)); }
      const pdf = renderWeeklyPdf(report);
      const filename = `Olutech_Weekly_Deliverables_${report.monday}.pdf`;
      res.writeHead(200, {'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${filename}"`, 'Content-Length':pdf.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      return res.end(pdf);
    }
    if (req.method === 'GET' && pathname === '/dashboard') {
      const user = requireLogin(req, res, db); if (!user) return;
      return send(res, 200, dashboard(db, user));
    }

    if (req.method === 'GET' && pathname === '/admin/operations-backup') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      // Browser download only; do not modify the cloud database.
      const content = JSON.stringify(db, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="olutech-full-backup-${todayDate()}.json"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(content);
      return;
    }

    if (req.method === 'POST' && pathname === '/admin/operations-reset') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      if (form.confirmation !== 'RESET OPERATIONS' || form.acknowledged !== 'yes' || !verifyPassword(form.password || '', user.passwordHash)) {
        return send(res, 400, page('Reset not authorized', '<div class="panel"><h1>No records were deleted</h1><p>The confirmation, backup acknowledgement, or password was incorrect.</p><a href="/storage-status">Back to Storage Status</a></div>', user));
      }
      // Require same-origin browser request: a cross-site form may not destroy data.
      const origin = headerValue(req, 'origin');
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch (_) {}
        const allowedHosts = [headerValue(req, 'host'), headerValue(req, 'x-forwarded-host')].filter(Boolean);
        if (!originHost || !allowedHosts.includes(originHost)) {
          return send(res, 403, page('Reset refused', '<div class="panel"><h1>Invalid request origin</h1><p>No records were deleted.</p></div>', user));
        }
      }
      // Read production again and verify the backup before altering any registers.
      const snapshot = await verifiedPreResetBackup(db);
      const fresh = JSON.parse(JSON.stringify(snapshot.source));
      const loggedIn = (fresh.users || []).find(candidate => candidate.id === user.id && candidate.accountEnabled !== false && Number(candidate.clearance || 1) >= 5);
      if (!loggedIn || !verifyPassword(form.password, loggedIn.passwordHash)) throw new Error('The admin session changed during the reset. Backup exists; no data was deleted.');
      const result = clearOperationalRecords(fresh);
      if (!fresh.meta) fresh.meta = {};
      fresh.meta.lastOperationalResetAt = new Date().toISOString();
      fresh.meta.lastOperationalResetBy = user.email || user.username;
      fresh.meta.preResetBackupReference = snapshot.backupName;
      addAudit(fresh, user, 'operations_fresh_start', `Reset operational registers after verified ${snapshot.storage} backup. Counts: ${JSON.stringify(result.removed)}`);
      if (snapshot.storage === 'cloud') {
        const wasSaved = await writeCloudDb(fresh);
        if (!wasSaved) throw new Error('Cloud reset save was not acknowledged. The backup was retained.');
        const verified = await readCloudDb();
        if (!verified || verified.meta?.lastOperationalResetAt !== fresh.meta.lastOperationalResetAt ||
            ['projects','tasks','approvals','delays','nxpChecklist'].some(key => (verified[key] || []).length !== 0)) {
          throw new Error('Could not verify reset in cloud storage. Check backup and Storage Status before further changes.');
        }
        writeDbLocal(fresh);
      } else {
        writeDbLocal(fresh);
      }
      return send(res, 200, page('Operational registers cleared', `<div class="panel"><h1>Fresh start completed</h1>
        <p>Projects, tasks, approvals and delays are now empty. Employee accounts, attendance, files, lessons, and audit history are unchanged.</p>
        <p><b>Verified backup:</b> <code>${escapeHtml(snapshot.backupName)}</code></p>
        <p><b>Removed:</b> ${result.removed.projects} projects, ${result.removed.tasks} tasks, ${result.removed.approvals} approvals, ${result.removed.delays} delays. Linked task/time and NXP records were also cleared.</p>
        <a class="button" href="/dashboard">Go to clean dashboard</a></div>`, loggedIn));
    }

    if (req.method === 'GET' && pathname === '/storage-status') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      return send(res, 200, await renderStorageStatus(db, user, url.searchParams.get('check') === '1'));
    }

    if (req.method === 'GET' && pathname === '/attendance') {
      const user = requireLogin(req, res, db); if (!user) return;
      return send(res, 200, renderAttendance(db, user, '', url.searchParams.get('employee') || ''));
    }

    if (req.method === 'GET' && pathname === '/attendance/pulse') {
      const user = requireLogin(req, res, db); if (!user) return;
      return sendJson(res, 200, {closed: !Boolean(openAttendanceRecord(db, user.id)), at: new Date().toISOString()});
    }

    if (req.method === 'POST' && pathname === '/attendance/clock-in') {
      const user = requireLogin(req, res, db); if (!user) return;
      if (!isTimeClockUser(user)) return send(res, 403, renderAttendance(db, user));
      normalizeAttendance(db);
      const existingOpen = openAttendanceRecord(db, user.id);
      if (existingOpen) return send(res, 200, renderAttendance(db, user, 'You are already clocked in. Please clock out before starting another work session.'));
      const form = await parseUrlEncoded(req);
      const now = new Date();
      const settings = workSettings(db);
      const record = {
        id: `ATT-${localDate(now, db).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        workDate: localDate(now, db),
        clockInAt: now.toISOString(),
        clockInTime: localTime(now, db),
        clockOutAt: null,
        clockOutTime: null,
        totalMs: 0,
        status: 'Clocked In',
        timeZone: settings.timeZone,
        expectedStart: settings.workdayStart,
        expectedEnd: settings.workdayEnd,
        autoClockOutDueAt: null,
        notes: cleanText(form.notes),
        workSummary: ''
      };
      record.autoClockOutDueAt = attendanceAutomaticDueAt(db, record).toISOString();
      db.attendance.unshift(record);
      addAudit(db, user, 'clock_in', `Clocked in at ${record.clockInTime}`);
      await saveDb(db);
      return send(res, 200, renderAttendance(db, user, 'Clock-in recorded successfully.'));
    }

    if (req.method === 'POST' && pathname === '/attendance/clock-out') {
      const user = requireLogin(req, res, db); if (!user) return;
      if (!isTimeClockUser(user)) return send(res, 403, renderAttendance(db, user));
      normalizeAttendance(db);
      const record = openAttendanceRecord(db, user.id);
      if (!record) return send(res, 200, renderAttendance(db, user, 'You do not have an open clock-in record.'));
      const form = await parseUrlEncoded(req);
      const now = new Date();
      record.clockOutAt = now.toISOString();
      record.clockOutTime = localTime(now, db);
      record.totalMs = Math.max(0, new Date(record.clockOutAt) - new Date(record.clockInAt));
      record.status = 'Completed';
      record.workSummary = cleanText(form.workSummary);
      addAudit(db, user, 'clock_out', `Clocked out after ${formatDuration(record.totalMs)}`);
      await saveDb(db);
      return send(res, 200, renderAttendance(db, user, `Clock-out recorded. Total time for this session: ${formatDuration(record.totalMs)}.`));
    }

    if (req.method === 'POST' && pathname === '/attendance/delete') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'attendance', form.id);
      if (removed) { addAudit(db, user, 'attendance_delete', `Deleted ${removed.id}`); await saveDb(db); }
      return send(res, 200, renderAttendance(db, user, 'Attendance record deleted.'));
    }

    if (req.method === 'GET' && pathname === '/projects') {
      const user = requireLogin(req, res, db); if (!user) return;
      return send(res, 200, renderProjects(db, user));
    }
    if (req.method === 'GET' && pathname === '/tasks') {
      const user = requireLogin(req, res, db); if (!user) return;
      return send(res, 200, renderTasks(db, user, url.searchParams.get('view') || 'all'));
    }
    if (req.method === 'GET' && pathname === '/tasks/view') {
      const user = requireLogin(req, res, db); if (!user) return;
      const task = (db.tasks || []).find(item => String(item.id) === String(url.searchParams.get('id') || ''));
      if (!task) return notFound(res, user);
      if (!visibleTasks(db, user).some(item => item.id === task.id)) return send(res, 403, page('Task restricted', '<div class="panel"><h1>Access restricted</h1><p>You do not have access to this task.</p></div>', user));
      // Only an assignee opening their own task is a meaningful first-open event.
      // Track per-assignment, not per-page-load or per-tab: no duplicate alerts.
      const assignee = taskEventRecipient(db, task, 'assigned');
      const assignmentKey = String(task.assignedUserId || task.assignedTo || '');
      if (assignee && user.id === assignee.id && assignmentKey && !taskStatusClosedLike(task.status) && task.notificationOpenedAssignmentKey !== assignmentKey) {
        task.notificationOpenedAssignmentKey = assignmentKey;
        task.firstOpenedAt = new Date().toISOString();
        task.firstOpenedByUserId = user.id;
        addTaskNotification(db, task, 'opened', user);
        await saveDb(db);
      }
      return send(res, 200, renderTaskWorkspace(db, user, task, url.searchParams.get('tab')));
    }
    if (req.method === 'POST' && pathname === '/chat/new') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const targetType = String(form.targetType || '').toLowerCase() === 'task' ? 'task' : 'project';
      const targetId = cleanText(form.targetId);
      const message = cleanText(form.message);
      const fallback = targetType === 'task' ? '/tasks' : '/projects';
      const returnTo = safeReturnTo(form.returnTo, fallback);
      if (!message) return redirect(res, returnTo);
      if (targetType === 'task') {
        const task = db.tasks.find(t => t.id === targetId);
        if (!canViewTaskChat(db, task, user)) return send(res, 403, page('Chat restricted', '<div class="panel"><h1>Access restricted</h1><p>You can only comment on tasks visible to you.</p></div>', user));
      } else {
        const project = db.projects.find(p => p.id === targetId);
        if (!canViewProjectChat(db, project, user)) return send(res, 403, page('Chat restricted', '<div class="panel"><h1>Access restricted</h1><p>You can only comment on projects connected to your work.</p></div>', user));
      }
      db.chatMessages = db.chatMessages || [];
      db.chatMessages.push({
        id: crypto.randomUUID(),
        targetType,
        targetId,
        message,
        author: user.displayName || user.username,
        authorUsername: user.username,
        authorRole: user.role || clearanceName(user.clearance),
        createdAt: new Date().toISOString()
      });
      addAudit(db, user, 'chat_message_create', `Added ${targetType} chat message on ${targetId}`);
      await saveDb(db);
      return redirect(res, returnTo);
    }
    if (req.method === 'POST' && pathname === '/tasks/update') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const task = db.tasks.find(t => t.id === form.id);
      if (!task) return send(res, 404, page('Task not found', '<div class="panel"><h1>Task not found</h1></div>', user));
      if (!taskAssignableByUser(task, user)) return send(res, 403, page('Access restricted', '<div class="panel"><h1>You can only update tasks assigned to you or assigned by you. Level 5 can update all tasks.</h1></div>', user));
      if (Number(user.clearance || 1) < 5 && task.workflowManaged && samePerson(task.assignedTo, user.displayName) && !isCurrentWorkflowTask(db, task)) return send(res, 403, page('Workflow step locked', '<div class="panel"><h1>This step is not active yet.</h1><p>Earlier workflow steps must be completed before you can pick up this task.</p><p><a class="button" href="/tasks">Back to tasks</a></p></div>', user));
      if (form.assignedTo && isExcludedFromDeliverables(form.assignedTo) && !samePerson(form.assignedTo, task.assignedTo))
        return send(res, 400, page('Task assignment restricted', '<div class="panel"><h1>Task assignment restricted</h1><p>Akin and System Administrator are excluded from deliverable tasks.</p></div>', user));
      const previousStatus = task.status;
      const previousAssignee = task.assignedTo;
      task.status = cleanText(form.status) || task.status;
      task.workflowStatus = task.status;
      if (taskStatusClosedLike(task.status)) stopTaskTimersForTask(db, task.id);
      if ((!task.workflowManaged || Number(user.clearance || 1) >= 5) && form.assignedTo) {
        task.assignedTo = cleanText(form.assignedTo) || task.assignedTo;
        task.assignedUserId = (db.users || []).find(u => samePerson(u.displayName, task.assignedTo))?.id || null;
        task.assignedRole = taskRole(db, task.assignedTo);
        task.role = task.assignedRole;
      }
      if ((!task.workflowManaged || Number(user.clearance || 1) >= 5) && form.taskType) task.taskType = cleanText(form.taskType) || task.taskType || 'General Task';
      task.progress = Math.max(0, Math.min(1, Number(form.progress || 0) / 100));
      if (['completed', 'closed', 'approved'].includes(String(task.status).toLowerCase())) {
        task.progress = 1;
        task.completedAt = task.completedAt || new Date().toISOString();
        task.completedBy = user.displayName;
      } else if (['completed', 'closed', 'approved'].includes(String(previousStatus).toLowerCase())) {
        task.completedAt = null; // Reopened tasks need a new completion timestamp next time.
      }
      if (String(task.status).toLowerCase() === 'in progress') {
        task.startedAt = task.startedAt || new Date().toISOString();
        if (!task.progress) task.progress = 0.25;
      }
      task.nextAction = cleanText(form.nextAction) || task.nextAction;
      if (typeof form.comments !== 'undefined') task.comments = cleanText(form.comments);
      task.lastUpdateDate = todayDate();
      task.lastUpdatedBy = user.displayName;
      if (task.workflowManaged && previousStatus !== task.status) {
        db.projectHandoffs = db.projectHandoffs || [];
        db.projectHandoffs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), projectId: task.projectId, taskId: task.id, fromStatus: previousStatus, toStatus: task.status, by: user.displayName, note: task.nextAction || '' });
        db.projectHandoffs = db.projectHandoffs.slice(0, 500);
      }
      if (previousAssignee !== task.assignedTo) {
        // A reassignment starts a new first-open cycle for the incoming employee.
        task.notificationOpenedAssignmentKey = null;
        addTaskNotification(db, task, 'assigned', user);
        addAudit(db, user, 'task_reassign', `Reassigned ${task.id} from ${previousAssignee || 'unassigned'} to ${task.assignedTo || 'unassigned'}`);
      }
      if (!taskStatusClosedLike(previousStatus) && taskStatusClosedLike(task.status)) {
        addTaskNotification(db, task, 'closed', user);
      }
      syncOperationalAutomation(db, user);
      addAudit(db, user, 'task_update', `Updated ${task.id}`);
      await saveDb(db);
      return redirect(res, '/tasks');
    }
    if (req.method === 'POST' && pathname === '/tasks/new') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const project = db.projects.find(p => p.id === form.projectId);
      if (!project) return send(res, 400, page('Project required', '<div class="panel"><h1>Select a valid project first.</h1><p><a class="button" href="/tasks">Back to tasks</a></p></div>', user));
      if (isExcludedFromDeliverables(form.assignedTo))
        return send(res, 400, page('Task assignment restricted', '<div class="panel"><h1>Select a staff member other than Akin or System Administrator.</h1></div>', user));
      const id = nextSequenceId(db.tasks, 'T');
      const status = cleanText(form.status) || 'Not Started';
      const task = {
        id,
        dateLogged: todayDate(),
        projectId: project.id,
        projectName: project.name || '',
        category: project.category || '',
        taskType: cleanText(form.taskType) || 'General Task',
        title: cleanText(form.title),
        assignedTo: cleanText(form.assignedTo),
        assignedRole: taskRole(db, form.assignedTo),
        role: taskRole(db, form.assignedTo),
        assignedBy: user.displayName,
        assignedByUserId: user.id,
        assignedUserId: (db.users || []).find(u => samePerson(u.displayName, form.assignedTo))?.id || null,
        priority: cleanText(form.priority) || 'Medium',
        status,
        workflowManaged: false,
        workflowOrder: 0,
        phase: project.phase || 'Execution',
        startDate: String(status).toLowerCase() === 'in progress' ? todayDate() : null,
        dueDate: nullableText(form.dueDate),
        progress: taskStatusClosedLike(status) ? 1 : (String(status).toLowerCase() === 'in progress' ? 0.25 : 0),
        nextAction: cleanText(form.nextAction),
        comments: cleanText(form.comments),
        lastUpdateDate: todayDate(),
        impactIfDelayed: cleanText(form.impactIfDelayed) || project.impactIfDelayed || '',
        completedAt: ['completed','closed','approved'].includes(String(status).toLowerCase()) ? new Date().toISOString() : null
      };
      db.tasks.push(task);
      addTaskNotification(db, task, 'assigned', user);
      syncOperationalAutomation(db, user);
      addAudit(db, user, 'task_create', `Created task ${id} for ${project.id}`);
      await saveDb(db);
      return redirect(res, '/tasks');
    }

    if (req.method === 'POST' && pathname === '/workflow/add-step') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const project = db.projects.find(p => p.id === form.projectId);
      if (!project) return send(res, 400, page('Project required', '<div class="panel"><h1>Select a valid project first.</h1><p><a class="button" href="/projects">Back to projects</a></p></div>', user));
      if (isExcludedFromDeliverables(form.assignedTo))
        return send(res, 400, page('Workflow assignment restricted', '<div class="panel"><h1>Akin and System Administrator cannot own workflow deliverables.</h1></div>', user));
      const id = nextSequenceId(db.tasks, 'T');
      const order = nextWorkflowOrder(db, project.id);
      const existingSteps = workflowTasks(db, project.id);
      const shouldBeReady = existingSteps.length === 0 || existingSteps.every(taskDone);
      const initialStatus = shouldBeReady ? 'Ready' : 'Waiting';
      const task = {
        id,
        dateLogged: todayDate(),
        projectId: project.id,
        projectName: project.name || '',
        category: project.category || '',
        taskType: 'Workflow Step',
        title: cleanText(form.title),
        assignedTo: cleanText(form.assignedTo),
        assignedRole: taskRole(db, form.assignedTo),
        role: taskRole(db, form.assignedTo),
        assignedBy: user.displayName,
        assignedByUserId: user.id,
        assignedUserId: (db.users || []).find(u => samePerson(u.displayName, form.assignedTo))?.id || null,
        priority: cleanText(form.priority) || project.priority || 'Medium',
        status: initialStatus,
        workflowStatus: initialStatus,
        workflowManaged: true,
        workflowOrder: order,
        phase: '',
        startDate: shouldBeReady ? todayDate() : null,
        readyAt: shouldBeReady ? new Date().toISOString() : null,
        dueDate: nullableText(form.dueDate),
        progress: 0,
        nextAction: cleanText(form.nextAction) || (shouldBeReady ? 'Pick up this workflow step.' : 'Waiting for previous workflow step.'),
        lastUpdateDate: todayDate(),
        impactIfDelayed: project.impactIfDelayed || ''
      };
      db.tasks.push(task);
      addTaskNotification(db, task, 'assigned', user);
      project.workflowEnabled = true;
      syncOperationalAutomation(db, user);
      addAudit(db, user, 'workflow_step_create', `Level 5 added workflow step ${order} (${id}) for ${project.id}`);
      await saveDb(db);
      return redirect(res, '/projects');
    }

    if (req.method === 'POST' && pathname === '/workflow/update-step') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const task = db.tasks.find(t => t.id === form.id && t.workflowManaged);
      if (!task) return send(res, 404, page('Workflow step not found', '<div class="panel"><h1>Workflow step not found</h1></div>', user));
      if (form.assignedTo && isExcludedFromDeliverables(form.assignedTo) && !samePerson(form.assignedTo, task.assignedTo))
        return send(res, 400, page('Workflow assignment restricted', '<div class="panel"><h1>Akin and System Administrator cannot own workflow deliverables.</h1></div>', user));
      const previousStepAssignee = task.assignedTo;
      task.title = cleanText(form.title) || task.title;
      task.assignedTo = cleanText(form.assignedTo) || task.assignedTo;
      task.assignedUserId = (db.users || []).find(u => samePerson(u.displayName, task.assignedTo))?.id || null;
      task.assignedRole = taskRole(db, task.assignedTo);
      task.role = task.assignedRole;
      task.priority = cleanText(form.priority) || task.priority;
      task.dueDate = nullableText(form.dueDate);
      task.nextAction = cleanText(form.nextAction) || task.nextAction;
      task.workflowOrder = Math.max(1, Number(form.workflowOrder || task.workflowOrder || 1));
      task.lastUpdateDate = todayDate();
      if (!samePerson(previousStepAssignee, task.assignedTo)) {
        task.notificationOpenedAssignmentKey = null;
        addTaskNotification(db, task, 'assigned', user);
      }
      const steps = workflowTasks(db, task.projectId);
      steps.forEach((step, idx) => { step.workflowOrder = idx + 1; });
      syncOperationalAutomation(db, user);
      addAudit(db, user, 'workflow_step_update', `Level 5 updated workflow step ${task.id}`);
      await saveDb(db);
      return redirect(res, '/projects');
    }

    if (req.method === 'POST' && pathname === '/tasks/timer/start') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const task = (db.tasks || []).find(t => t.id === form.id);
      if (!task || !taskAssignableByUser(task, user)) return send(res, 403, renderTasks(db, user, 'open', 'You do not have access to start this task timer.'));
      if (taskStatusClosedLike(task.status)) return send(res, 400, renderTasks(db, user, 'open', 'Closed tasks cannot start a new timer.'));
      if (task.workflowManaged && Number(user.clearance || 1) < 5 && !isCurrentWorkflowTask(db, task)) return send(res, 403, renderTasks(db, user, 'open', 'This workflow step is not active yet.'));
      db.taskTimeEntries = db.taskTimeEntries || [];
      if (db.taskTimeEntries.some(entry => entry.userId === user.id && !entry.stoppedAt)) return send(res, 409, renderTasks(db, user, 'open', 'You already have a running timer. Stop it before starting another task.'));
      db.taskTimeEntries.unshift({ id: crypto.randomUUID(), taskId: task.id, taskTitle: task.title, userId: user.id, displayName: user.displayName, startedAt: new Date().toISOString(), stoppedAt: null, elapsedMs: 0, status: 'running' });
      addAudit(db, user, 'task_timer_start', `Started timer for ${task.id}`);
      await saveDb(db);
      return redirect(res, '/tasks?view=open');
    }

    if (req.method === 'POST' && pathname === '/tasks/timer/stop') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      // An employee can stop their own running timer even after reassignment.
      const entry = (db.taskTimeEntries || []).find(e => e.taskId === form.id && e.userId === user.id && !e.stoppedAt);
      if (!entry) return send(res, 400, renderTasks(db, user, 'open', 'No running timer for this task was found.'));
      const now = new Date();
      entry.stoppedAt = now.toISOString();
      entry.elapsedMs = Math.max(0, now.getTime() - new Date(entry.startedAt).getTime());
      entry.status = 'stopped';
      addAudit(db, user, 'task_timer_stop', `Stopped timer for ${entry.taskId}`);
      await saveDb(db);
      return redirect(res, '/tasks?view=open');
    }

    if (req.method === 'POST' && pathname === '/tasks/delete-selected') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncodedMany(req);
      const ids = [...new Set(form.getAll('ids').map(cleanText).filter(Boolean))];
      const view = form.get('view') === 'closed' ? 'closed' : 'open';
      if (!ids.length) return send(res, 400, renderTasks(db, user, view, 'Select at least one task to delete.'));
      const selected = ids.map(id => (db.tasks || []).find(t => t.id === id));
      if (selected.some(t => !t)) return send(res, 400, renderTasks(db, user, view, 'Some selected tasks no longer exist. Refresh the page.'));
      if (selected.some(t => (t.workflowManaged && Number(user.clearance || 1) < 5) || (!t.workflowManaged && !taskAssignableByUser(t, user)))) return send(res, 403, renderTasks(db, user, view, 'You do not have permission to delete one or more selected tasks.'));
      const now = new Date();
      for (const id of ids) stopTaskTimersForTask(db, id, now);
      const removedSet = new Set(ids);
      db.tasks = db.tasks.filter(t => !removedSet.has(t.id));
      for (const file of db.files || []) if (removedSet.has(file.taskId)) file.taskId = null;
      syncOperationalAutomation(db, user);
      addAudit(db, user, 'task_bulk_delete', `Deleted ${ids.length} selected tasks: ${ids.join(', ')}`);
      await saveDb(db);
      return redirect(res, `/tasks?view=${view}`);
    }

    if (req.method === 'POST' && pathname === '/tasks/delete') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const task = db.tasks.find(t => t.id === form.id);
      if (!task) return redirect(res, '/tasks');
      if (task.workflowManaged && Number(user.clearance) < 5) {
        return send(res, 403, page('Workflow control restricted', '<div class="panel"><h1>Workflow step deletion requires Level 5.</h1><p>Only Level 5 can change workflow structure.</p><p><a class="button" href="/tasks">Back to tasks</a></p></div>', user));
      }
      if (!task.workflowManaged && !taskAssignableByUser(task, user) && Number(user.clearance) < 5) {
        return send(res, 403, page('Access restricted', '<div class="panel"><h1>You can only delete tasks assigned to you or assigned by you.</h1></div>', user));
      }
      stopTaskTimersForTask(db, form.id);
      const removed = removeById(db, 'tasks', form.id);
      if (removed) {
        for (const file of db.files || []) if (file.taskId === removed.id) file.taskId = null;
        syncOperationalAutomation(db, user);
        addAudit(db, user, 'task_delete', `Deleted ${removed.id} (${['Created in error', 'No longer needed', 'Duplicate task'].includes(form.reason) ? form.reason : 'No reason given'})`);
        await saveDb(db);
      }
      return redirect(res, `/tasks?view=${form.view === 'closed' ? 'closed' : 'open'}`);
    }

    if (req.method === 'POST' && pathname === '/projects/new') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = cleanText(form.id) || nextSequenceId(db.projects, 'PRJ');
      if (db.projects.some(p => p.id === id)) return send(res, 400, renderProjects(db, user, `Project ID ${id} already exists.`));
      if (workflowStepIndexesFromForm(form).some(i => cleanText(form[`stepTitle${i}`]) && isExcludedFromDeliverables(form[`stepAssignee${i}`])))
        return send(res, 400, renderProjects(db, user, 'Akin and System Administrator cannot own workflow deliverables. Choose an employee.'));
      const project = {
        id,
        name: cleanText(form.name),
        category: '',
        owner: cleanText(form.owner),
        sponsor: '',
        phase: '',
        priority: cleanText(form.priority) || 'High',
        status: 'Active',
        workflowEnabled: String(form.projectMode || 'workflow') !== 'standard',
        projectHealth: 'Amber',
        progress: 0,
        startDate: nullableText(form.startDate) || todayDate(),
        targetEndDate: nullableText(form.targetEndDate),
        currentBlocker: '',
        nextMilestone: '',
        decisionRequired: cleanText(form.decisionRequired),
        impactIfDelayed: cleanText(form.impactIfDelayed),
        notes: cleanText(form.notes),
        createdBy: user.displayName,
        createdAt: new Date().toISOString()
      };
      db.projects.unshift(project);
      const createdTasks = [];
      const stepIndexes = workflowStepIndexesFromForm(form);
      for (const i of stepIndexes) {
        const title = cleanText(form[`stepTitle${i}`]);
        const assignee = cleanText(form[`stepAssignee${i}`]);
        if (!title || !assignee) continue;
        const isFirstStep = createdTasks.length === 0;
        const task = {
          id: nextSequenceId([...db.tasks, ...createdTasks], 'T'),
          dateLogged: todayDate(),
          projectId: id,
          projectName: project.name,
          category: project.category,
          title,
          assignedTo: assignee,
          assignedRole: taskRole(db, assignee),
          role: taskRole(db, assignee),
          assignedBy: user.displayName,
          assignedByUserId: user.id,
          assignedUserId: (db.users || []).find(u => samePerson(u.displayName, assignee))?.id || null,
          priority: project.priority,
          status: isFirstStep ? 'Ready' : 'Waiting',
          workflowStatus: isFirstStep ? 'Ready' : 'Waiting',
          workflowManaged: true,
          workflowOrder: createdTasks.length + 1,
          phase: '',
          startDate: isFirstStep ? todayDate() : null,
          readyAt: isFirstStep ? new Date().toISOString() : null,
          dueDate: nullableText(form[`stepDue${i}`]),
          progress: 0,
          nextAction: isFirstStep ? 'Pick up this first workflow step.' : 'Waiting for previous workflow step.',
          lastUpdateDate: todayDate(),
          impactIfDelayed: cleanText(form.impactIfDelayed)
        };
        createdTasks.push(task);
        addTaskNotification(db, task, 'assigned', user);
      }
      if (project.workflowEnabled && !createdTasks.length) {
        db.projects = db.projects.filter(p => p.id !== id);
        return send(res, 400, renderProjects(db, user, 'Add at least one valid workflow step with an assigned user, or choose No Workflow for a normal project.'));
      }
      if (createdTasks.length) db.tasks.push(...createdTasks);
      syncProjectAutomation(db, id, user, true);
      addAudit(db, user, 'project_create', project.workflowEnabled ? `Created workflow project ${id} with ${createdTasks.length} steps` : `Created no-workflow project ${id}`);
      await saveDb(db);
      return redirect(res, '/projects');
    }

    if (req.method === 'POST' && pathname === '/projects/update') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const project = db.projects.find(p => p.id === form.id);
      if (!project) return send(res, 404, page('Project not found', '<div class="panel"><h1>Project not found</h1></div>', user));
      project.name = cleanText(form.name) || project.name;
      project.owner = cleanText(form.owner) || project.owner;
      project.priority = cleanText(form.priority) || project.priority;
      project.startDate = nullableText(form.startDate);
      project.targetEndDate = nullableText(form.targetEndDate);
      project.impactIfDelayed = cleanText(form.impactIfDelayed);
      project.notes = cleanText(form.notes);
      for (const key of ['tasks','actions','delays','approvals','risks','nxpChecklist','lessons']) {
        for (const item of db[key] || []) if (item.projectId === project.id) item.projectName = project.name;
      }
      syncOperationalAutomation(db, user);
      addAudit(db, user, 'project_update', `Updated ${project.id}`);
      await saveDb(db);
      return redirect(res, '/projects');
    }

    if (req.method === 'POST' && pathname === '/projects/delete-selected') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncodedMany(req);
      const ids = [...new Set(form.getAll('ids').map(cleanText).filter(Boolean))];
      if (!ids.length) return send(res, 400, renderProjects(db, user, 'Select at least one project to delete.'));
      if (ids.some(id => !(db.projects || []).some(p => p.id === id))) return send(res, 400, renderProjects(db, user, 'Some selected projects no longer exist. Refresh the page.'));
      const blocked = ids.filter(id => hasProjectDependencies(db, id));
      if (blocked.length) return send(res, 400, renderProjects(db, user, `Delete cancelled: these projects have linked tasks, files, delays, approvals or lessons: ${blocked.join(', ')}. Remove the links first.`));
      const removedIds = new Set(ids);
      db.projects = db.projects.filter(p => !removedIds.has(p.id));
      addAudit(db, user, 'project_bulk_delete', `Deleted ${ids.length} selected projects: ${ids.join(', ')}`);
      await saveDb(db);
      return redirect(res, '/projects');
    }

    if (req.method === 'POST' && pathname === '/projects/delete') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      if (hasProjectDependencies(db, form.id)) return send(res, 400, renderProjects(db, user, 'This project still has linked tasks, files, risks, approvals, or lessons. Move or delete linked records before deleting the project.'));
      const removed = removeById(db, 'projects', form.id);
      if (removed) { addAudit(db, user, 'project_delete', `Deleted ${removed.id}`); await saveDb(db); }
      return redirect(res, '/projects');
    }

        if (req.method === 'POST' && pathname === '/actions/new') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = nextSequenceId(db.actions, 'A');
      const action = {
        id,
        sourceDate: nullableText(form.sourceDate) || todayDate(),
        projectId: cleanText(form.projectId),
        projectName: '',
        item: cleanText(form.item),
        owner: cleanUpper(form.owner) || cleanUpper(user.displayName),
        assignedBy: cleanText(form.assignedBy) || user.displayName,
        priority: cleanText(form.priority) || 'Medium',
        dueDate: nullableText(form.dueDate),
        status: cleanText(form.status) || 'Open',
        evidenceLink: nullableText(form.evidenceLink),
        nextFollowUpDate: nullableText(form.nextFollowUpDate),
        managerComment: cleanText(form.managerComment),
        closedDate: null
      };
      updateProjectName(db, action);
      if (isClosed(action.status)) action.closedDate = todayDate();
      db.actions.unshift(action);
      addAudit(db, user, 'action_create', `Created ${id}`);
      await saveDb(db);
      return redirect(res, '/actions');
    }

    if (req.method === 'POST' && pathname === '/actions/update') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const action = db.actions.find(a => a.id === form.id);
      if (!action) return send(res, 404, page('Action not found', '<div class="panel"><h1>Action not found</h1></div>', user));
      if (user.clearance < 2 && !samePerson(action.owner, user.displayName)) return send(res, 403, page('Access restricted', '<div class="panel"><h1>You can only update your own action items.</h1></div>', user));
      action.sourceDate = nullableText(form.sourceDate);
      action.projectId = cleanText(form.projectId);
      updateProjectName(db, action);
      action.item = cleanText(form.item) || action.item;
      action.owner = cleanUpper(form.owner) || action.owner;
      action.assignedBy = cleanText(form.assignedBy);
      action.priority = cleanText(form.priority) || action.priority;
      action.dueDate = nullableText(form.dueDate);
      action.status = cleanText(form.status) || action.status;
      action.evidenceLink = nullableText(form.evidenceLink);
      action.nextFollowUpDate = nullableText(form.nextFollowUpDate);
      action.managerComment = cleanText(form.managerComment);
      if (isClosed(action.status) && !action.closedDate) action.closedDate = todayDate();
      if (!isClosed(action.status)) action.closedDate = null;
      addAudit(db, user, 'action_update', `Updated ${action.id}`);
      await saveDb(db);
      return redirect(res, '/actions');
    }

    if (req.method === 'POST' && pathname === '/actions/delete') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'actions', form.id);
      if (removed) { addAudit(db, user, 'action_delete', `Deleted ${removed.id}`); await saveDb(db); }
      return redirect(res, '/actions');
    }

    if (req.method === 'POST' && pathname === '/delays/new') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = nextSequenceId(db.delays, 'D');
      const delay = {
        id,
        dateRaised: nullableText(form.dateRaised) || todayDate(),
        projectId: cleanText(form.projectId),
        projectName: '',
        relatedTaskId: nullableText(form.relatedTaskId),
        category: cleanText(form.category),
        description: cleanText(form.description),
        responsibleParty: cleanUpper(form.responsibleParty),
        escalationOwner: cleanUpper(form.escalationOwner),
        severity: cleanText(form.severity) || 'Medium',
        status: cleanText(form.status) || 'Open',
        requiredAction: cleanText(form.requiredAction),
        dueDate: nullableText(form.dueDate),
        impactArea: cleanText(form.impactArea),
        impactDescription: cleanText(form.impactDescription),
        escalationLevel: cleanText(form.escalationLevel),
        resolution: cleanText(form.resolution),
        resolvedDate: null
      };
      updateProjectName(db, delay);
      if (isClosed(delay.status)) {
        addAudit(db, user, 'delay_resolved_removed', `Delay ${id} was entered as resolved and was not kept in the active delay register`);
        syncOperationalAutomation(db, user);
        await saveDb(db);
        return redirect(res, '/delays');
      }
      db.delays.unshift(delay);
      addAudit(db, user, 'delay_create', `Created ${id}`);
      syncOperationalAutomation(db, user);
      await saveDb(db);
      return redirect(res, '/delays');
    }

    if (req.method === 'POST' && pathname === '/delays/update') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const delay = db.delays.find(d => d.id === form.id);
      if (!delay) return send(res, 404, page('Delay not found', '<div class="panel"><h1>Delay not found</h1></div>', user));
      delay.dateRaised = nullableText(form.dateRaised);
      delay.projectId = cleanText(form.projectId);
      updateProjectName(db, delay);
      delay.relatedTaskId = nullableText(form.relatedTaskId);
      delay.category = cleanText(form.category);
      delay.description = cleanText(form.description) || delay.description;
      delay.responsibleParty = cleanUpper(form.responsibleParty);
      delay.escalationOwner = cleanUpper(form.escalationOwner);
      delay.severity = cleanText(form.severity) || delay.severity;
      delay.status = cleanText(form.status) || delay.status;
      delay.requiredAction = cleanText(form.requiredAction);
      delay.dueDate = nullableText(form.dueDate);
      delay.impactArea = cleanText(form.impactArea);
      delay.impactDescription = cleanText(form.impactDescription);
      delay.escalationLevel = cleanText(form.escalationLevel);
      delay.resolution = cleanText(form.resolution);
      if (isClosed(delay.status)) {
        const removedId = delay.id;
        db.delays = db.delays.filter(d => d.id !== removedId);
        db.risks = (db.risks || []).filter(r => r.relatedDelayId !== removedId);
        addAudit(db, user, 'delay_resolved_removed', `Resolved delay ${removedId} and removed linked active risk records`);
        syncOperationalAutomation(db, user);
        await saveDb(db);
        return redirect(res, '/delays');
      }
      delay.resolvedDate = null;
      addAudit(db, user, 'delay_update', `Updated ${delay.id}`);
      syncOperationalAutomation(db, user);
      await saveDb(db);
      return redirect(res, '/delays');
    }

    if (req.method === 'POST' && pathname === '/delays/delete') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'delays', form.id);
      if (removed) { addAudit(db, user, 'delay_delete', `Deleted ${removed.id}`); syncOperationalAutomation(db, user);
      await saveDb(db); }
      return redirect(res, '/delays');
    }

    if (req.method === 'POST' && pathname === '/risks/new') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = nextSequenceId(db.risks, 'R');
      const likelihood = clampNumber(form.likelihood, 1, 5, 3);
      const impact = clampNumber(form.impact, 1, 5, 3);
      const score = likelihood * impact;
      const risk = {
        id,
        dateIdentified: nullableText(form.dateIdentified) || todayDate(),
        projectId: cleanText(form.projectId),
        projectName: '',
        issue: cleanText(form.issue),
        type: cleanText(form.type) || 'Risk',
        category: cleanText(form.category),
        owner: cleanText(form.owner),
        likelihood,
        impact,
        score,
        heatMap: riskBand(score),
        earlyWarning: cleanText(form.earlyWarning),
        mitigation: cleanText(form.mitigation),
        contingency: cleanText(form.contingency),
        dueDate: nullableText(form.dueDate),
        status: cleanText(form.status) || 'Open',
        escalationRequired: cleanText(form.escalationRequired) || 'No',
        evidenceLink: nullableText(form.evidenceLink),
        resolution: cleanText(form.resolution)
      };
      updateProjectName(db, risk);
      if (isClosed(risk.status)) {
        addAudit(db, user, 'risk_resolved_removed', `Risk ${id} was entered as resolved and was not kept in the active risk register`);
        syncOperationalAutomation(db, user);
        await saveDb(db);
        return redirect(res, '/risks');
      }
      db.risks.unshift(risk);
      addAudit(db, user, 'risk_create', `Created ${id}`);
      syncOperationalAutomation(db, user);
      await saveDb(db);
      return redirect(res, '/risks');
    }

    if (req.method === 'POST' && pathname === '/risks/update') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const risk = db.risks.find(r => r.id === form.id);
      if (!risk) return send(res, 404, page('Risk not found', '<div class="panel"><h1>Risk not found</h1></div>', user));
      const likelihood = clampNumber(form.likelihood, 1, 5, 3);
      const impact = clampNumber(form.impact, 1, 5, 3);
      const score = likelihood * impact;
      risk.dateIdentified = nullableText(form.dateIdentified);
      risk.projectId = cleanText(form.projectId);
      updateProjectName(db, risk);
      risk.issue = cleanText(form.issue) || risk.issue;
      risk.type = cleanText(form.type) || risk.type;
      risk.category = cleanText(form.category);
      risk.owner = cleanUpper(form.owner);
      risk.likelihood = likelihood;
      risk.impact = impact;
      risk.score = score;
      risk.heatMap = riskBand(score);
      risk.earlyWarning = cleanText(form.earlyWarning);
      risk.mitigation = cleanText(form.mitigation);
      risk.contingency = cleanText(form.contingency);
      risk.dueDate = nullableText(form.dueDate);
      risk.status = cleanText(form.status) || risk.status;
      risk.escalationRequired = cleanText(form.escalationRequired) || 'No';
      risk.resolution = cleanText(form.resolution);
      if (isClosed(risk.status)) {
        const removedId = risk.id;
        db.risks = db.risks.filter(r => r.id !== removedId);
        addAudit(db, user, 'risk_resolved_removed', `Resolved risk ${removedId} and removed it from the active risk register`);
        syncOperationalAutomation(db, user);
        await saveDb(db);
        return redirect(res, '/risks');
      }
      addAudit(db, user, 'risk_update', `Updated ${risk.id}`);
      syncOperationalAutomation(db, user);
      await saveDb(db);
      return redirect(res, '/risks');
    }

    if (req.method === 'POST' && pathname === '/risks/delete') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'risks', form.id);
      if (removed) { addAudit(db, user, 'risk_delete', `Deleted ${removed.id}`); syncOperationalAutomation(db, user);
      await saveDb(db); }
      return redirect(res, '/risks');
    }

    if (req.method === 'POST' && pathname === '/approvals/new') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = nextSequenceId(db.approvals, 'AP');
      const approval = {
        id,
        dateRequested: nullableText(form.dateRequested) || todayDate(),
        projectId: cleanText(form.projectId),
        projectName: '',
        type: cleanText(form.type),
        requestedBy: cleanUpper(form.requestedBy) || cleanUpper(user.displayName),
        approver: cleanUpper(form.approver),
        item: cleanText(form.item),
        amountOrDocument: cleanText(form.amountOrDocument),
        requiredBy: nullableText(form.requiredBy),
        status: cleanText(form.status) || 'Pending',
        impactArea: cleanText(form.impactArea),
        impactIfDelayed: cleanText(form.impactIfDelayed),
        escalationLevel: cleanText(form.escalationLevel),
        dateApproved: null,
        decisionComment: cleanText(form.decisionComment),
        evidenceLink: nullableText(form.evidenceLink)
      };
      updateProjectName(db, approval);
      if (['approved', 'rejected'].includes(String(approval.status).toLowerCase())) approval.dateApproved = todayDate();
      db.approvals.unshift(approval);
      addAudit(db, user, 'approval_create', `Created ${id}`);
      syncOperationalAutomation(db, user);
      await saveDb(db);
      return redirect(res, '/approvals');
    }

    if (req.method === 'POST' && pathname === '/approvals/update') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const approval = db.approvals.find(a => a.id === form.id);
      if (!approval) return send(res, 404, page('Approval not found', '<div class="panel"><h1>Approval not found</h1></div>', user));
      approval.dateRequested = nullableText(form.dateRequested);
      approval.projectId = cleanText(form.projectId);
      updateProjectName(db, approval);
      approval.type = cleanText(form.type);
      approval.requestedBy = cleanUpper(form.requestedBy);
      approval.approver = cleanUpper(form.approver);
      approval.item = cleanText(form.item) || approval.item;
      approval.amountOrDocument = cleanText(form.amountOrDocument);
      approval.requiredBy = nullableText(form.requiredBy);
      const previousStatus = approval.status;
      approval.status = cleanText(form.status) || approval.status;
      approval.impactArea = cleanText(form.impactArea);
      approval.impactIfDelayed = cleanText(form.impactIfDelayed);
      approval.escalationLevel = cleanText(form.escalationLevel);
      approval.decisionComment = cleanText(form.decisionComment);
      approval.evidenceLink = nullableText(form.evidenceLink);
      if (['approved', 'rejected'].includes(String(approval.status).toLowerCase()) && previousStatus !== approval.status) approval.dateApproved = todayDate();
      addAudit(db, user, 'approval_update', `Updated ${approval.id}`);
      syncOperationalAutomation(db, user);
      await saveDb(db);
      return redirect(res, '/approvals');
    }

    if (req.method === 'POST' && pathname === '/approvals/delete') {
      const user = requireClearance(req, res, db, 4); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'approvals', form.id);
      if (removed) { addAudit(db, user, 'approval_delete', `Deleted ${removed.id}`); syncOperationalAutomation(db, user);
      await saveDb(db); }
      return redirect(res, '/approvals');
    }

    if (req.method === 'POST' && pathname === '/nxp/new') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = nextSequenceId(db.nxpChecklist, 'NXP');
      const item = {
        id,
        projectId: cleanText(form.projectId),
        projectName: '',
        workstream: cleanText(form.workstream),
        item: cleanText(form.item),
        owner: cleanText(form.owner),
        requiredByStage: cleanText(form.requiredByStage),
        status: cleanText(form.status) || 'Not Started',
        dueDate: nullableText(form.dueDate),
        evidenceLink: nullableText(form.evidenceLink),
        blocker: cleanText(form.blocker),
        escalationRequired: cleanText(form.escalationRequired) || 'No',
        approverExternalParty: cleanText(form.approverExternalParty),
        notes: cleanText(form.notes)
      };
      updateProjectName(db, item);
      db.nxpChecklist.unshift(item);
      addAudit(db, user, 'nxp_create', `Created ${id}`);
      await saveDb(db);
      return redirect(res, '/nxp');
    }

    if (req.method === 'POST' && pathname === '/nxp/update') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const item = db.nxpChecklist.find(n => n.id === form.id);
      if (!item) return send(res, 404, page('Checklist item not found', '<div class="panel"><h1>Checklist item not found</h1></div>', user));
      item.projectId = cleanText(form.projectId);
      updateProjectName(db, item);
      item.workstream = cleanText(form.workstream);
      item.item = cleanText(form.item) || item.item;
      item.owner = cleanUpper(form.owner);
      item.requiredByStage = cleanText(form.requiredByStage);
      item.status = cleanText(form.status) || item.status;
      item.dueDate = nullableText(form.dueDate);
      item.evidenceLink = nullableText(form.evidenceLink);
      item.blocker = cleanText(form.blocker);
      item.escalationRequired = cleanText(form.escalationRequired) || 'No';
      item.approverExternalParty = cleanText(form.approverExternalParty);
      item.notes = cleanText(form.notes);
      addAudit(db, user, 'nxp_update', `Updated ${item.id}`);
      await saveDb(db);
      return redirect(res, '/nxp');
    }

    if (req.method === 'POST' && pathname === '/nxp/delete') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'nxpChecklist', form.id);
      if (removed) { addAudit(db, user, 'nxp_delete', `Deleted ${removed.id}`); await saveDb(db); }
      return redirect(res, '/nxp');
    }

    if (req.method === 'POST' && pathname === '/lessons/new') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const id = nextSequenceId(db.lessons, 'LL');
      const lesson = {
        id,
        date: nullableText(form.date) || todayDate(),
        projectId: cleanText(form.projectId),
        projectName: '',
        event: cleanText(form.event),
        expected: cleanText(form.expected),
        actual: cleanText(form.actual),
        missedSignal: cleanText(form.missedSignal),
        rootCause: cleanText(form.rootCause),
        impact: cleanText(form.impact),
        control: cleanText(form.control),
        owner: cleanText(form.owner),
        dueDate: nullableText(form.dueDate),
        status: cleanText(form.status) || 'Open',
        evidenceReference: cleanText(form.evidenceReference)
      };
      updateProjectName(db, lesson);
      db.lessons.unshift(lesson);
      addAudit(db, user, 'lesson_create', `Created ${id}`);
      await saveDb(db);
      return redirect(res, '/lessons');
    }

    if (req.method === 'POST' && pathname === '/lessons/update') {
      const user = requireClearance(req, res, db, 2); if (!user) return;
      const form = await parseUrlEncoded(req);
      const lesson = db.lessons.find(l => l.id === form.id);
      if (!lesson) return send(res, 404, page('Lesson not found', '<div class="panel"><h1>Lesson not found</h1></div>', user));
      lesson.date = nullableText(form.date) || lesson.date;
      lesson.projectId = cleanText(form.projectId);
      updateProjectName(db, lesson);
      lesson.event = cleanText(form.event) || lesson.event;
      lesson.expected = cleanText(form.expected);
      lesson.actual = cleanText(form.actual);
      lesson.missedSignal = cleanText(form.missedSignal);
      lesson.rootCause = cleanText(form.rootCause) || lesson.rootCause;
      lesson.impact = cleanText(form.impact);
      lesson.control = cleanText(form.control) || lesson.control;
      lesson.owner = cleanUpper(form.owner);
      lesson.dueDate = nullableText(form.dueDate);
      lesson.status = cleanText(form.status) || lesson.status;
      lesson.evidenceReference = cleanText(form.evidenceReference);
      addAudit(db, user, 'lesson_update', `Updated ${lesson.id}`);
      await saveDb(db);
      return redirect(res, '/lessons');
    }

    if (req.method === 'POST' && pathname === '/lessons/delete') {
      const user = requireClearance(req, res, db, 3); if (!user) return;
      const form = await parseUrlEncoded(req);
      const removed = removeById(db, 'lessons', form.id);
      if (removed) { addAudit(db, user, 'lesson_delete', `Deleted ${removed.id}`); await saveDb(db); }
      return redirect(res, '/lessons');
    }

    if (req.method === 'GET' && pathname === '/actions') { const user = requireLogin(req, res, db); if (!user) return; return send(res, 200, renderActions(db, user)); }
    if (req.method === 'GET' && pathname === '/delays') { const user = requireClearance(req, res, db, 2); if (!user) return; return send(res, 200, renderDelays(db, user)); }
    if (req.method === 'GET' && pathname === '/risks') { const user = requireClearance(req, res, db, 2); if (!user) return; return send(res, 200, renderRisks(db, user)); }
    if (req.method === 'GET' && pathname === '/approvals') { const user = requireClearance(req, res, db, 3); if (!user) return; return send(res, 200, renderApprovals(db, user)); }
    if (req.method === 'GET' && pathname === '/nxp') { const user = requireClearance(req, res, db, 2); if (!user) return; return redirect(res, '/tasks'); }
    if (req.method === 'GET' && pathname === '/kpi') { const user = requireClearance(req, res, db, 2); if (!user) return; return send(res, 200, renderKpi(db, user)); }
    if (req.method === 'GET' && pathname === '/lessons') { const user = requireClearance(req, res, db, 2); if (!user) return; return send(res, 200, renderLessons(db, user)); }
    if (req.method === 'GET' && pathname === '/files') { const user = requireLogin(req, res, db); if (!user) return; return redirect(res, '/tasks?view=open'); }
    if (req.method === 'GET' && pathname === '/excel-import') { const user = requireClearance(req, res, db, 5); if (!user) return; return send(res, 200, renderExcelImport(db, user)); }

    if (req.method === 'GET' && pathname.startsWith('/excel-import/download/')) {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const id = pathname.split('/').pop();
      const item = (db.importHistory || []).find(record => record.id === id);
      if (!item || !item.workbookBase64) return notFound(res, user);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(item.filename || 'tracker.xlsx')}"`
      });
      return res.end(Buffer.from(item.workbookBase64, 'base64'));
    }

    if (req.method === 'POST' && pathname === '/excel-import/upload') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      try {
        const { fields, files } = await parseMultipart(req);
        const file = files.find(f => f.fieldName === 'excel');
        if (!file || !file.buffer.length) return send(res, 400, renderExcelImport(db, user, 'No Excel file was selected.'));
        const ext = path.extname(file.filename || '').toLowerCase();
        if (!['.xlsx', '.xls', '.xlsm'].includes(ext)) return send(res, 400, renderExcelImport(db, user, 'Please upload a valid Excel workbook: .xlsx, .xls, or .xlsm.'));
        const summary = importWorkbookToDb(db, file.buffer, file.filename, user);
        const importRecord = db.importHistory && db.importHistory[0];
        if (importRecord) {
          importRecord.workbookBase64 = file.buffer.toString('base64');
          importRecord.size = file.buffer.length;
          importRecord.note = cleanText(fields.note || '');
          importRecord.persisted = true;
        }
        addAudit(db, user, 'excel_import', `Imported Excel tracker ${sanitizeFilename(file.filename)}${fields.note ? ': ' + cleanText(fields.note) : ''}`);
        await saveDb(db);
        return send(res, 200, renderExcelImport(db, user, 'Excel tracker imported successfully. Active records have been distributed into their modules.', summary));
      } catch (err) {
        return send(res, 500, renderExcelImport(db, user, err.message || 'Excel import failed.'));
      }
    }

    if (req.method === 'POST' && pathname === '/files/attach') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const file = (db.files || []).find(item => String(item.id) === String(form.id || ''));
      const task = (db.tasks || []).find(item => String(item.id) === String(form.taskId || ''));
      if (!file || (file.taskId && (db.tasks || []).some(item => String(item.id) === String(file.taskId))) || !task || !canSeeTaskFile(db, user, file) || !canManageTaskFile(user, file) || !visibleTasks(db, user).some(item => item.id === task.id)) return send(res, 403, renderTasks(db, user, 'open', 'You cannot attach that file to this task.'));
      file.taskId = task.id;
      file.wasTaskAttached = true;
      file.projectId = task.projectId || null;
      addAudit(db, user, 'file_attach', `Attached ${file.id} to ${task.id}`);
      await saveDb(db);
      return redirect(res, taskWorkspaceLink(task.id, 'files'));
    }

    if (req.method === 'POST' && pathname === '/files/upload') {
      const user = requireLogin(req, res, db); if (!user) return;
      const { fields, files } = await parseMultipart(req);
      const file = files.find(f => f.fieldName === 'file');
      if (!file || !file.buffer.length) return send(res, 400, renderTasks(db, user, 'open', 'No file was selected.'));
      const task = (db.tasks || []).find(item => String(item.id) === String(fields.taskId || ''));
      if (!task || !visibleTasks(db, user).some(item => item.id === task.id)) return send(res, 403, renderTasks(db, user, 'open', 'Choose a task you have access to.'));
      if (file.buffer.length > MAX_TASK_FILE_BYTES) return send(res, 413, renderTasks(db, user, 'open', 'File too large. Maximum attachment size is 4 MB.'));
      const required = Math.max(1, Math.min(Number(fields.requiredClearance || 1), Number(user.clearance)));
      const original = sanitizeFilename(file.filename);
      const id = `FILE-${String(Date.now()).slice(-8)}-${crypto.randomBytes(3).toString('hex')}`;
      const savedName = `${id}-${original}`;
      const savedPath = path.join(UPLOAD_DIR, savedName);
      fs.writeFileSync(savedPath, file.buffer);
      db.files.unshift({
        id,
        title: fields.title || original,
        projectId: task.projectId || null,
        taskId: task.id,
        wasTaskAttached: true,
        module: 'Task Evidence',
        uploadedByUserId: user.id,
        uploadedBy: user.displayName,
        uploadedAt: new Date().toISOString(),
        requiredClearance: required,
        type: 'local-file',
        storedName: savedName,
        originalName: original,
        size: file.buffer.length,
        contentBase64: file.buffer.toString('base64'),
        persistentStored: true,
        notes: fields.notes || ''
      });
      addAudit(db, user, 'file_upload', `Uploaded ${original} (${clearanceName(required)})`);
      await saveDb(db);
      return redirect(res, taskWorkspaceLink(task.id, 'files'));
    }


    if (req.method === 'POST' && pathname === '/files/update') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const file = db.files.find(f => f.id === form.id);
      if (!file) return send(res, 404, page('File not found', '<div class="panel"><h1>File not found</h1></div>', user));
      if (!canSeeTaskFile(db, user, file) || !canManageTaskFile(user, file)) return send(res, 403, page('Access restricted', '<div class="panel"><h1>You cannot edit this task file.</h1></div>', user));
      file.title = cleanText(form.title) || file.title;
      // Task files always inherit their linked project's ID.
      const linkedTask = file.taskId && (db.tasks || []).find(item => item.id === file.taskId);
      file.projectId = linkedTask ? linkedTask.projectId : nullableText(form.projectId);
      file.module = cleanText(form.module) || 'General';
      file.requiredClearance = Math.max(1, Math.min(Number(form.requiredClearance || file.requiredClearance || 1), Number(user.clearance)));
      file.notes = cleanText(form.notes);
      if (file.type === 'external-link') file.externalUrl = cleanText(form.externalUrl) || file.externalUrl;
      addAudit(db, user, 'file_update', `Updated ${file.id}`);
      await saveDb(db);
      return redirect(res, linkedTask ? taskWorkspaceLink(linkedTask.id, 'files') : '/tasks?view=open');
    }

    if (req.method === 'POST' && pathname === '/files/delete') {
      const user = requireLogin(req, res, db); if (!user) return;
      const form = await parseUrlEncoded(req);
      const file = db.files.find(f => f.id === form.id);
      if (!file) return send(res, 404, page('File not found', '<div class="panel"><h1>File not found</h1></div>', user));
      if (!canSeeTaskFile(db, user, file) || !canManageTaskFile(user, file)) return send(res, 403, page('Access restricted', '<div class="panel"><h1>You cannot delete this task file.</h1></div>', user));
      const removed = removeById(db, 'files', form.id);
      if (removed && removed.type === 'local-file' && removed.storedName) {
        const full = path.join(UPLOAD_DIR, removed.storedName);
        if (full.startsWith(UPLOAD_DIR) && fs.existsSync(full)) fs.unlinkSync(full);
      }
      if (removed) { addAudit(db, user, 'file_delete', `Deleted ${removed.id}`); await saveDb(db); }
      return redirect(res, file.taskId && (db.tasks || []).some(task => String(task.id) === String(file.taskId)) ? taskWorkspaceLink(file.taskId, 'files') : '/tasks?view=open');
    }

    if (req.method === 'GET' && pathname.startsWith('/files/download/')) {
      const user = requireLogin(req, res, db); if (!user) return;
      const id = pathname.split('/').pop();
      const file = db.files.find(f => f.id === id);
      if (!file || file.type !== 'local-file') return notFound(res, user);
      if (!canSeeTaskFile(db, user, file)) return send(res, 403, page('Access restricted', '<div class="panel"><h1>You cannot access this task file.</h1></div>', user));
      const full = path.join(UPLOAD_DIR, file.storedName || '');
      const hasLocalFile = file.storedName && full.startsWith(UPLOAD_DIR) && fs.existsSync(full);
      const hasArchivedFile = Boolean(file.contentBase64);
      if (!hasLocalFile && !hasArchivedFile) return notFound(res, user);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(file.originalName)}"`
      });
      if (hasLocalFile) return fs.createReadStream(full).pipe(res);
      return res.end(Buffer.from(file.contentBase64, 'base64'));
    }

    if (req.method === 'GET' && pathname === '/admin/users') { const user = requireClearance(req, res, db, 5); if (!user) return; return send(res, 200, renderUsers(db, user)); }
    if (req.method === 'POST' && pathname === '/admin/user-clearance') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const target = db.users.find(u => u.id === form.id);
      if (target) {
        target.clearance = Math.max(1, Math.min(5, Number(form.clearance || target.clearance)));
        addAudit(db, user, 'clearance_update', `Updated ${target.username} to ${clearanceName(target.clearance)}`);
        await saveDb(db);
      }
      return send(res, 200, renderUsers(db, user, 'Clearance updated.'));
    }
    if (req.method === 'POST' && pathname === '/admin/user-new') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const displayName = canonicalStaffName(cleanText(form.displayName));
      const role = cleanText(form.role) || 'Team Member';
      const email = normalizeLoginEmail(form.email || officialEmailForName(displayName));
      if (!displayName) return send(res, 400, renderUsers(db, user, 'Enter a valid employee name.'));
      if (!email.endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`)) return send(res, 400, renderUsers(db, user, 'Employee login email must be an official @olutechagro.com address.'));
      if (db.users.some(u => normalizeLoginEmail(u.email || u.username) === email)) return send(res, 400, renderUsers(db, user, 'That official email already has a user account.'));
      if (db.users.some(u => samePerson(u.displayName, displayName))) return send(res, 400, renderUsers(db, user, 'That employee name already has a user account. Edit the existing user instead.'));
      upsertSetupStaff(db, { name: displayName, role, isExternal: false });
      db.users.push(makeUser({
        username: email,
        email,
        displayName,
        role,
        clearance: Math.max(1, Math.min(5, Number(form.clearance || inferClearance(displayName, role)))),
        password: form.password || 'olutech123',
        mustChangePassword: true
      }));
      const created = db.users[db.users.length - 1];
      created.adminManaged = true;
      created.accountEnabled = String(form.accountEnabled) !== 'false';
      addAudit(db, user, 'user_create', `Created ${email}`);
      await saveDb(db);
      return send(res, 200, renderUsers(db, user, 'New employee user created and added to staff suggestions.'));
    }
    if (req.method === 'POST' && pathname === '/admin/user-update') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const target = db.users.find(u => u.id === form.id);
      if (!target) return send(res, 404, page('User not found', '<div class="panel"><h1>User not found</h1></div>', user));
      const oldName = target.displayName;
      const displayName = canonicalStaffName(cleanText(form.displayName)) || target.displayName;
      const isAdminTarget = normalizeLoginEmail(target.email || target.username) === `admin@${OFFICIAL_EMAIL_DOMAIN}` || String(target.displayName || '').toLowerCase().includes('system administrator');
      const email = isAdminTarget ? `admin@${OFFICIAL_EMAIL_DOMAIN}` : normalizeLoginEmail(form.email || target.email || officialEmailForName(displayName));
      if (!email.endsWith(`@${OFFICIAL_EMAIL_DOMAIN}`)) return send(res, 400, renderUsers(db, user, 'Employee login email must be an official @olutechagro.com address.'));
      const duplicate = db.users.find(u => u.id !== target.id && normalizeLoginEmail(u.email || u.username) === email);
      if (duplicate) return send(res, 400, renderUsers(db, user, 'Another user already has that official email.'));
      if (db.users.some(u => u.id !== target.id && samePerson(u.displayName, displayName))) return send(res, 400, renderUsers(db, user, 'Another employee already uses that display name. Choose a unique name.'));
      target.displayName = displayName;
      target.email = email;
      target.username = email;
      target.role = cleanText(form.role) || target.role || 'Team Member';
      target.clearance = Math.max(1, Math.min(5, Number(form.clearance || target.clearance)));
      target.accountEnabled = String(form.accountEnabled) !== 'false';
      target.adminManaged = true;
      if (oldName && !samePerson(oldName, target.displayName)) markSetupStaffDeleted(db, oldName);
      upsertSetupStaff(db, { name: target.displayName, role: target.role, isExternal: false });
      if (oldName && !samePerson(oldName, target.displayName)) {
        for (const item of [...(db.projects || []), ...(db.tasks || []), ...(db.actions || []), ...(db.delays || []), ...(db.approvals || []), ...(db.risks || []), ...(db.lessons || []), ...(db.nxpChecklist || [])]) {
          for (const key of ['owner','sponsor','assignedTo','assignedBy','responsibleParty','escalationOwner','requestedBy','approver','createdBy']) {
            if (samePerson(item[key], oldName)) item[key] = target.displayName;
          }
        }
        // Task access is name-based in this version. Update all live assignments
        // immediately and leave immutable audit messages intact.
        for (const attendance of db.attendance || []) {
          if (attendance.userId === target.id) { attendance.displayName = target.displayName; attendance.username = target.username; }
        }
        for (const entry of db.taskTimeEntries || []) {
          if (entry.userId === target.id) entry.displayName = target.displayName;
        }
      }
      for (const task of db.tasks || []) {
        if (samePerson(task.assignedTo, target.displayName)) {
          task.assignedRole = target.role;
          task.role = target.role;
        }
      }
      if (!target.accountEnabled) {
        stopRunningUserTimers(db, target.id);
        removeUserAuthSessions(db, target.id);
        syncSessionActivity(db);
      }
      if (form.password) {
        target.passwordHash = hashPassword(form.password);
        target.mustChangePassword = true;
        target.passwordChangedAt = null;
        target.passwordResetBy = user.id;
        target.passwordResetAt = new Date().toISOString();
        removeUserAuthSessions(db, target.id);
        syncSessionActivity(db);
        addAudit(db, user, 'password_admin_reset', `Changed/reset password for ${target.username}`);
      }
      addAudit(db, user, 'user_update', `Updated ${target.username}`);
      await saveDb(db);
      return send(res, 200, renderUsers(db, user, 'User updated.'));
    }

    if (req.method === 'POST' && pathname === '/admin/user-delete') {
      const user = requireClearance(req, res, db, 5); if (!user) return;
      const form = await parseUrlEncoded(req);
      const target = db.users.find(u => u.id === form.id);
      if (!target) return send(res, 404, renderUsers(db, user, 'User not found.'));
      const targetEmail = normalizeLoginEmail(target.email || target.username);
      const isAdminTarget = targetEmail === `admin@${OFFICIAL_EMAIL_DOMAIN}` || String(target.displayName || '').toLowerCase().includes('system administrator');
      if (isAdminTarget) return send(res, 400, renderUsers(db, user, 'The main system admin account cannot be deleted.'));
      if (target.id === user.id) return send(res, 400, renderUsers(db, user, 'You cannot delete the account you are currently using.'));
      const otherLevel5 = db.users.filter(u => u.id !== target.id && u.accountEnabled !== false && Number(u.clearance || 1) >= 5);
      if (Number(target.clearance || 1) >= 5 && otherLevel5.length === 0) return send(res, 400, renderUsers(db, user, 'At least one active Level 5 account must remain.'));
      const deletedName = target.displayName || target.email || target.username || target.id;
      const deletedEmail = target.email || target.username || target.id;
      stopRunningUserTimers(db, target.id);
      removeUserAuthSessions(db, target.id);
      const removed = removeById(db, 'users', target.id);
      if (removed) {
        markSetupStaffDeleted(db, deletedName);
        syncSessionActivity(db);
        addAudit(db, user, 'user_delete', `Deleted user ${deletedEmail}`);
        await saveDb(db);
      }
      return send(res, 200, renderUsers(db, user, `${deletedName} has been deleted. Existing task/project history was kept.`));
    }


    return notFound(res, currentUser(req, db));
  } catch (err) {
    console.error(err);
    const user = currentUser(req, db);
    send(res, 500, page('Server error', `<div class="panel"><h1>Server error</h1><p>${escapeHtml(err.message)}</p></div>`, user));
  }
}

function boot() {
  ensureDirectories();
  initialiseDb();
}

if (require.main === module) {
  boot();
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`Olutech Agro PMS running at http://localhost:${PORT}`);
  });
} else {
  boot();
  module.exports = handleRequest;
}
