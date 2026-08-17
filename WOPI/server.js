/**
 * WOPI host + PDF editing workflow for Collabora Online CODE.
 *
 * Flow for PDFs:
 *   upload .pdf  ->  convert to .odg (Collabora Conversion API)
 *                ->  open the .odg in Collabora over WOPI (fully editable)
 *                ->  on save, write the .odg and regenerate a .pdf in the background
 *                ->  frontend downloads the regenerated .pdf
 *
 * Non-PDF files (docx, xlsx, pptx, odt...) pass straight through, unchanged.
 *
 * Requires Node 18+ (global fetch, FormData, Blob).
 * DEV ONLY: in-memory registry, no real auth, no locking.
 */

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const crypto = require("crypto");
const { convert } = require("./lib/converter");

const app = express();
app.use(cors());



// ---------------------------------------------------------------- config

const PORT = process.env.PORT || 5000;
const COLLABORA_URL = process.env.COLLABORA_URL ||  "https://ez-officeviewer-app.graycoast-78e47e4a.southindia.azurecontainerapps.io" ||"http://localhost:9980" ||   "https://ez-officeviewer-wopi.azurewebsites.net";
const POST_MESSAGE_ORIGIN = process.env.APP_ORIGIN || "https://trial.ezofis.com" || "http://localhost:8080" ||"http://localhost:3000" || "https://demoapp.ezofis.com" || "https://v6app.ezofis.com";
const CONVERT_TIMEOUT_MS = 180_000;   // big/scanned PDFs are slow
const SAVE_DEBOUNCE_MS = 2_000;       // collapse rapid autosaves into one convert

const UPLOAD_DIR = path.join(__dirname, "storage", "originals");
const WORK_DIR = path.join(__dirname, "storage", "working");
const OUTPUT_DIR = path.join(__dirname, "storage", "output");

for (const dir of [UPLOAD_DIR, WORK_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Keep the original extension - Collabora picks its import filter from it.
const upload1 = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const STAGING_DIR = path.join(__dirname, "storage", "staging");
fs.mkdirSync(STAGING_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: STAGING_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/**
 * fileRegistry[id] = {
 *   token,            access token for this file
 *   kind,             "native" | "pdf-derived"
 *   originalPath,     path to the file as uploaded (PDF kept immutable)
 *   originalName,     "invoice.pdf"
 *   editPath,         what Collabora actually opens (.odg for PDFs)
 *   editName,         "invoice.odg"  <- drives BaseFileName
 *   outputPath,       regenerated PDF (pdf-derived only)
 *   dirty,            edited since last PDF regeneration
 *   converting,       a regeneration is in flight
 *   lastError,        last conversion error message, if any
 * }
 */
const fileRegistry = {};
let fileCounter = 1;
const saveTimers = new Map();

// ------------------------------------------------------- conversion layer

/**
 * POST a file to Collabora's documented Conversion API.
 * Endpoint: POST {collabora}/cool/convert-to/{format}, multipart field "data".
 * Access is gated by net.post_allow in coolwsd.xml.
 */
async function convertDocument(inputPath, targetFormat) {
  const buffer = await fsp.readFile(inputPath);

  const form = new FormData();
  // The filename matters: Collabora infers the source filter from its extension.
  form.append("data", new Blob([buffer]), path.basename(inputPath));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS);

  try {
    const res = await fetch(`${COLLABORA_URL}/cool/convert-to/${targetFormat}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `convert-to/${targetFormat} returned ${res.status}. ${detail.slice(0, 300)}`
      );
    }

    const out = Buffer.from(await res.arrayBuffer());
    if (out.length === 0) {
      throw new Error(`convert-to/${targetFormat} returned an empty document.`);
    }
    return out;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Conversion to ${targetFormat} timed out.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function regeneratePdf(id) {
  const file = fileRegistry[id];
  if (!file || file.kind !== "pdf-derived" || file.converting) return;

  file.converting = true;
  try {
    const pdf = await convertDocument(file.editPath, "pdf");
    await fsp.writeFile(file.outputPath, pdf);
    file.dirty = false;
    file.lastError = null;
    file.updatedAt = new Date().toISOString();
    console.log(`[convert] regenerated PDF for file ${id}`);
  } catch (err) {
    file.lastError = err.message;
    console.error(`[convert] PDF regeneration failed for ${id}:`, err.message);
  } finally {
    file.converting = false;
  }
}

function scheduleRegeneration(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      regeneratePdf(id);
    }, SAVE_DEBOUNCE_MS)
  );
}

// -------------------------------------------------------------- upload

// app.post("/upload", upload.single("document"), async (req, res) => {
//   if (!req.file) return res.status(400).json({ error: "No file uploaded." });

//   const id = String(fileCounter++);
//   const token = crypto.randomUUID();
//   const ext = path.extname(req.file.originalname).toLowerCase();
//   const stem = path.basename(req.file.originalname, ext);

//   if (ext !== ".pdf") {
//     // Normal path - Collabora edits the uploaded file directly.
//     fileRegistry[id] = {
//       token,
//       kind: "native",
//       originalPath: req.file.path,
//       originalName: req.file.originalname,
//       editPath: req.file.path,
//       editName: req.file.originalname,
//     };
//     return res.json({ fileId: id, token, mode: "native" });
//   }

//   // PDF path - convert to ODG so the text becomes editable Draw objects.
//   try {
//     const odg = await convertDocument(req.file.path, "odg");
//     const editPath = path.join(WORK_DIR, `${id}.odg`);
//     await fsp.writeFile(editPath, odg);

//     fileRegistry[id] = {
//       token,
//       kind: "pdf-derived",
//       originalPath: req.file.path,
//       originalName: req.file.originalname,
//       editPath,
//       editName: `${stem}.odg`,
//       outputPath: path.join(OUTPUT_DIR, `${id}.pdf`),
//       dirty: false,
//       converting: false,
//       lastError: null,
//     };

//     // Seed the output with the untouched original so a download always works.
//     await fsp.copyFile(req.file.path, fileRegistry[id].outputPath);

//     res.json({ fileId: id, token, mode: "pdf-converted" });
//   } catch (err) {
//     console.error("[upload] PDF conversion failed:", err.message);
//     res.status(502).json({
//       error: "Could not convert this PDF for editing.",
//       detail: err.message,
//       hint: "Scanned PDFs have no text layer - run OCR first.",
//     });
//   }
// });

const REGEN_DEBOUNCE_MS = Number(process.env.REGEN_DEBOUNCE_MS || 2000);
const regenTimers = new Map();
 
async function regeneratePdf(entry) {
  if (entry.kind !== "pdf-derived" || !entry.dirty) return;
 
  return registry.withLock(entry, async () => {
    if (!entry.dirty) return;          // another run got here first
    entry.converting = true;
    entry.dirty = false;               // clear before converting
 
    try {
      const pdf = await convert(entry.editPath, "pdf");
      const { version, filePath } = registry.nextVersionPath(entry);
      await fsp.writeFile(filePath, pdf);
      registry.recordVersion(entry, version, filePath);
      entry.lastError = null;
      console.log(`[regen] ${entry.id} -> v${version} (${pdf.length} bytes)`);
    } catch (err) {
      entry.lastError = err.message;
      entry.dirty = true;              // restore so a retry can happen
      console.error(`[regen] ${entry.id} failed:`, err.message);
    } finally {
      entry.converting = false;
    }
  });
}
 
function scheduleRegeneration(entry) {
  clearTimeout(regenTimers.get(entry.id));
  regenTimers.set(
    entry.id,
    setTimeout(() => {
      regenTimers.delete(entry.id);
      regeneratePdf(entry);
    }, REGEN_DEBOUNCE_MS)
  );
}

app.post("/upload", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const isPdf = ext === ".pdf";

  const entry = registry.create({
    originalName: req.file.originalname,
    kind: isPdf ? "pdf-derived" : "native",
  });

  try {
    await fsp.rename(req.file.path, entry.originalPath);
  } catch (err) {
    // rename fails across drives - fall back to copy
    await fsp.copyFile(req.file.path, entry.originalPath);
    await fsp.unlink(req.file.path).catch(() => {});
  }

  if (!isPdf) {
    console.log(`[upload] ${entry.id} native ${ext}`);
    return res.json({
      fileId: entry.id,
      token: entry.token,
      name: entry.displayName,
      mode: "native",
    });
  }

  // The ingested PDF is version 1 and is never overwritten.
  registry.recordVersion(entry, 1, entry.originalPath);

  try {
   const odg = await registry.withLock(entry, () => convert(entry.originalPath, "odg:draw8"));
    await fsp.writeFile(entry.editPath, odg);

    console.log(`[upload] ${entry.id} converted to ODG (${odg.length} bytes)`);

    res.json({
      fileId: entry.id,
      token: entry.token,
      name: entry.displayName,
      mode: "editable",
      version: 1,
    });
  } catch (err) {
    console.error(`[upload] ${entry.id} conversion failed:`, err.message);
    entry.lastError = err.message;
    entry.kind = "pdf-readonly";

    res.status(200).json({
      fileId: entry.id,
      token: entry.token,
      name: entry.displayName,
      mode: "view-only",
      version: 1,
      notice: "This PDF could not be prepared for editing. It can be viewed and annotated.",
    });
  }
});

// ---------------------------------------------------------------- WOPI

app.use("/wopi/files/:id/contents", express.raw({ type: "*/*", limit: "100mb" }));

function authorize(req, res) {
  const file = fileRegistry[req.params.id];
  if (!file || req.query.access_token !== file.token) {
    res.status(401).send("Invalid token");
    return null;
  }
  if (!fs.existsSync(file.editPath)) {
    res.status(404).send("File not found");
    return null;
  }
  return file;
}
const REQUIRE_TOKEN = process.env.REQUIRE_TOKEN === "true";
 
function requireFile(req, res) {
  const entry = registry.get(req.params.id);
 
  if (!entry) {
    console.warn(`[wopi] unknown file id ${req.params.id}`);
    res.status(404).send("Unknown file");
    return null;
  }
  if (REQUIRE_TOKEN && entry.token !== req.query.access_token) {
    console.warn(
      `[wopi] token mismatch on ${entry.id}: got ${req.query.access_token?.length} chars, expected ${entry.token.length}`
    );
    res.status(401).send("Invalid token");
    return null;
  }
  if (!fs.existsSync(entry.editPath)) {
    res.status(404).send("File missing on disk");
    return null;
  }
  return entry;
}
// 1. CheckFileInfo
app.get("/wopi/files/:id", (req, res) => {
  const entry = requireFile(req, res);
  if (!entry) return;
 
  const stat = fs.statSync(entry.editPath);
  const readOnly = entry.kind === "pdf-readonly";
 
  res.json({
    // The extension here decides which editor Collabora loads.
    // "sample.odg" -> Draw with editable text.
    BaseFileName: entry.editName,
    Size: stat.size,
    Version: String(stat.mtimeMs),
    LastModifiedTime: stat.mtime.toISOString(),
 
    OwnerId: "ezofis",
    UserId: "thanaselvi-local",
    UserFriendlyName: "Thanaselvi",
 
    UserCanWrite: !readOnly,
    UserCanNotWriteRelative: true,
    SupportsUpdate: !readOnly,
    SupportsLocks: false,
 
    HideUserList: true,
    DisablePrint: true,
    DisableExport: false,
    HideSaveOption: false,
    DisableInactiveMessages: true,
    PostMessageOrigin: "*",
  });
});

// 2. GetFile
app.get("/wopi/files/:id/contents", (req, res) => {
  const entry = requireFile(req, res);
  if (!entry) return;
  res.sendFile(entry.editPath);
});

// 3. PutFile
app.post("/wopi/files/:id/contents", async (req, res) => {
  const entry = requireFile(req, res);
  if (!entry) return;
 
  if (entry.kind === "pdf-readonly") return res.sendStatus(404);
 
  if (!req.body || req.body.length === 0) {
    console.warn(`[wopi] ${entry.id} empty PutFile body - refusing`);
    return res.sendStatus(400);
  }
 
  try {
    await registry.withLock(entry, () => fsp.writeFile(entry.editPath, req.body));
    console.log(`[wopi] ${entry.id} saved ${entry.editName} (${req.body.length} bytes)`);
 
    if (entry.kind === "pdf-derived") entry.dirty = true ; scheduleRegeneration(entry);
 
    res.sendStatus(200);
  } catch (err) {
    console.error(`[wopi] ${entry.id} PutFile failed:`, err.message);
    res.sendStatus(500);
  }
});

async function flushPdf(entry) {
  clearTimeout(regenTimers.get(entry.id));
  regenTimers.delete(entry.id);
  await regeneratePdf(entry);
  return registry.latestVersion(entry);
}



app.get("/files/:id/pdf", async (req, res) => {
  const entry = registry.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Unknown file" });
 
  const latest = await flushPdf(entry);
  if (!latest) return res.status(500).json({ error: entry.lastError || "No PDF available" });
 
  res.download(latest.filePath, entry.displayName);
});
 
app.get("/files/:id/pdf-base64", async (req, res) => {
  const entry = registry.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Unknown file" });
 
  const latest = await flushPdf(entry);
  if (!latest) return res.status(500).json({ error: entry.lastError || "No PDF available" });
 
  const buffer = await fsp.readFile(latest.filePath);
 
  res.json({
    fileId: entry.id,
    name: entry.displayName,
    version: latest.version,
    createdAt: latest.createdAt,
    mimeType: "application/pdf",
    size: buffer.length,
    base64: buffer.toString("base64"),
  });
});
app.get("/files/:id/versions", (req, res) => {
  const entry = registry.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Unknown file" });
 
  res.json({
    name: entry.displayName,
    dirty: entry.dirty,
    converting: entry.converting,
    error: entry.lastError,
    versions: entry.versions.map((v) => ({ version: v.version, createdAt: v.createdAt })),
  });
});
// ------------------------------------------------- app-facing endpoints

// Poll this after a save to know when the PDF is ready.
app.get("/files/:id/status", (req, res) => {
  const file = fileRegistry[req.params.id];
  if (!file) return res.status(404).json({ error: "Unknown file" });

  res.json({
    kind: file.kind,
    dirty: !!file.dirty,
    converting: !!file.converting,
    updatedAt: file.updatedAt || null,
    error: file.lastError || null,
  });
});

// Download the current PDF. Forces a conversion first if edits are pending.
app.get("/files/:id/pdf", async (req, res) => {
  const file = fileRegistry[req.params.id];
  if (!file) return res.status(404).send("Unknown file");
  if (file.kind !== "pdf-derived") return res.status(400).send("Not a PDF-derived file");

  if (file.dirty || file.converting) {
    clearTimeout(saveTimers.get(req.params.id));
    saveTimers.delete(req.params.id);
    await regeneratePdf(req.params.id);
  }

  if (file.lastError) {
    return res.status(502).json({ error: "Conversion failed", detail: file.lastError });
  }

  res.download(file.outputPath, file.originalName);
});

// The untouched upload, for version history / rollback.
app.get("/files/:id/original", (req, res) => {
  const file = fileRegistry[req.params.id];
  if (!file) return res.status(404).send("Unknown file");
  res.download(file.originalPath, file.originalName);
});

// ---------------------------------------------------------------- boot

async function checkCollabora() {
  try {
    const res = await fetch(`${COLLABORA_URL}/hosting/capabilities`);
    const caps = await res.json();
    const ok = caps?.convert_to?.available ?? caps?.["convert-to"]?.available;
    console.log(
      ok
        ? "[startup] Collabora conversion API is available."
        : "[startup] WARNING: conversion API unavailable - check net.post_allow in coolwsd.xml."
    );
  } catch (err) {
    console.error(`[startup] Cannot reach Collabora at ${COLLABORA_URL}:`, err.message);
  }
}

// app.get("/test-convert", async (req, res) => {
//   try {
//     const buf = await convert("C:\\Users\\Shiva\\test\\sample.pdf", "odg");
//     await require("fs/promises").writeFile("C:\\Users\\Shiva\\test\\out.odg", buf);
//     res.send(`OK - ${buf.length} bytes`);
//   } catch (err) {
//     res.status(500).send(err.message);
//   }
// });

const registry = require("./lib/registry");

// app.get("/test-registry", async (req, res) => {
//   const entry = registry.create({ originalName: "invoice.pdf", kind: "pdf-derived" });

//   const order = [];
//   const slow = (n, ms) => registry.withLock(entry, () =>
//     new Promise((r) => setTimeout(() => { order.push(n); r(); }, ms))
//   );

//   await Promise.all([slow("first", 300), slow("second", 50), slow("third", 10)]);

//   res.json({
//     editName: entry.editName,
//     editPath: entry.editPath,
//     originalPath: entry.originalPath,
//     lockOrder: order,
//   });
// });
app.get("/health", (_req, res) => res.send("ok"));
app.listen(PORT, "0.0.0.0", async () => {
    console.log(`WOPI host running on port ${PORT}`);
    await checkCollabora();
  });
