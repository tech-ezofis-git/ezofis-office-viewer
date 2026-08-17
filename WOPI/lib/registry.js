const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const STORAGE_ROOT = path.join(__dirname, "..", "storage");
const DIRS = {
  originals: path.join(STORAGE_ROOT, "originals"),
  working: path.join(STORAGE_ROOT, "working"),
  output: path.join(STORAGE_ROOT, "output"),
};

for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

const entries = new Map();
let counter = 1;

/**
 * kind: "native"      - Collabora edits the uploaded file directly (docx, xlsx...)
 *       "pdf-derived" - uploaded a PDF, Collabora edits a generated ODG
 */

const STATE_FILE = path.join(STORAGE_ROOT, "registry.json");
 
function persist() {
  const data = [...entries.values()].map((e) => {
    const { _lock, ...rest } = e;
    return rest;
  });
  fs.writeFile(STATE_FILE, JSON.stringify({ counter, data }, null, 2), () => {});
}
 
function restore() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const { counter: c, data } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    counter = c;
    for (const e of data) entries.set(e.id, { ...e, _lock: Promise.resolve() });
    console.log(`[registry] restored ${data.length} entries`);
  } catch (err) {
    console.error("[registry] restore failed:", err.message);
  }
}
 
restore();
function create({ originalName, kind }) {
  const id = String(counter++);
  const ext = path.extname(originalName).toLowerCase();
  const stem = path.basename(originalName, ext);

  const entry = {
    id,
    token: crypto.randomUUID(),
    kind,
    displayName: originalName,

    originalPath: path.join(DIRS.originals, `${id}${ext}`),
    originalName,

    editPath: null,
    editName: null,

    versions: [],
    dirty: false,
    converting: false,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,

    _lock: Promise.resolve(),
  };

  if (kind === "native") {
    entry.editPath = entry.originalPath;
    entry.editName = originalName;
  } else {
    entry.editPath = path.join(DIRS.working, `${id}.odg`);
    entry.editName = `${stem}.odg`;
  }

  entries.set(id, entry);
  return entry;
}

function get(id) {
  return entries.get(String(id));
}

function authorize(id, token) {
  const entry = get(id);
  if (!entry || entry.token !== token) return null;
  return entry;
}

function nextVersionPath(entry) {
  const version = entry.versions.length + 1;
  return {
    version,
    filePath: path.join(DIRS.output, `${entry.id}.v${version}.pdf`),
  };
}

function recordVersion(entry, version, filePath) {
  entry.versions.push({ version, filePath, createdAt: new Date().toISOString() });
  entry.updatedAt = new Date().toISOString();
}

function latestVersion(entry) {
  return entry.versions[entry.versions.length - 1] || null;
}

/**
 * Per-file serial queue. Every conversion for one file waits for the
 * previous one to finish, so two saves in quick succession can never
 * read a half-written ODG or write the same version number twice.
 * Different files still convert in parallel.
 */
function withLock(entry, fn) {
  const result = entry._lock.then(fn, fn);
  entry._lock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

module.exports = { DIRS, create, get, authorize, nextVersionPath, recordVersion, latestVersion, withLock };
