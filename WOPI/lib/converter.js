const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 180_000);

const TEMP_ROOT = path.join(os.tmpdir(), "ezofis-convert");

function log(stage, msg, extra = {}) {
  const detail = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[convert:${stage}] ${msg}${detail}`);
}

/**
 * Every conversion runs in its own throwaway directory.
 * LibreOffice writes the output next to whatever --outdir it is given,
 * and derives the output filename from the input stem. If two conversions
 * shared a directory and both inputs were named "invoice", the second
 * would silently overwrite the first.
 */
async function withTempDir(fn) {
  await fsp.mkdir(TEMP_ROOT, { recursive: true });
  const dir = path.join(TEMP_ROOT, crypto.randomUUID());
  await fsp.mkdir(dir);
  try {
    return await fn(dir);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch((err) =>
      log("cleanup", `could not remove ${dir}: ${err.message}`)
    );
  }
}

let chain = Promise.resolve();
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CONVERSIONS ||5);
let active = 0;
const waiting = [];

async function serialize(fn) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

async function runSoffice(inputPath, targetFormat, outDir) {
  const profile = `/tmp/lo-${crypto.randomUUID()}`;
  const { stdout, stderr } = await execFileAsync("soffice", [
    "--headless",
    "--norestore",
    "--nolockcheck",
    `-env:UserInstallation=file://${profile}`,
    "--convert-to", targetFormat,
    "--outdir", outDir,
    inputPath,
  ], {
    timeout: CONVERT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (stderr && stderr.trim()) log("soffice", stderr.trim().slice(0, 400));
  return stdout;
}
/**
 * Convert a document and return a Buffer of the result.
 * Callers never see temp paths - they get bytes and decide where to store them.
 */
async function convert(inputPath, targetFormat) {
  const started = Date.now();
  const stem = path.basename(inputPath, path.extname(inputPath));

  return withTempDir(async (outDir) => {
    try {
    await serialize(() => runSoffice(inputPath, targetFormat, outDir));
    } catch (err) {
      if (err.killed || err.signal === "SIGTERM") {
        throw new Error(`Conversion to ${targetFormat} timed out.`);
      }
      throw new Error(
        `LibreOffice failed: ${(err.stderr || err.message || "").slice(0, 400)}`
      );
    }

    const [outExt] = targetFormat.split(":");
    const produced = path.join(outDir, `${stem}.${outExt}`);

    if (!fs.existsSync(produced)) {
      const found = await fsp.readdir(outDir).catch(() => []);
      throw new Error(
        `No ${targetFormat} produced. Output dir contained: ${found.join(", ") || "nothing"}`
      );
    }

    const buffer = await fsp.readFile(produced);
    if (buffer.length === 0) throw new Error(`Produced an empty ${targetFormat}.`);

    log("done", `${path.extname(inputPath)} to ${targetFormat}`, {
      ms: Date.now() - started,
      bytes: buffer.length,
    });
    return buffer;
  });
}

module.exports = { convert };
