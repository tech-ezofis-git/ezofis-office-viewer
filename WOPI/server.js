const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');

const PORT = process.env.PORT || 8080;
const STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const STORAGE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'ez-documents';
const TOKEN_SECRET = process.env.WOPI_TOKEN_SECRET || 'dev-secret-change-me';
const TOKEN_TTL_MS = Number(process.env.WOPI_TOKEN_TTL_MS || 10 * 60 * 60 * 1000); // 10h
const COLLABORA_BASE_URL =
  process.env.COLLABORA_BASE_URL ||
  'https://ez-officeviewer-app.graycoast-78e47e4a.southindia.azurecontainerapps.io';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // e.g. https://ez-officeviewer-wopi.azurewebsites.net

if (!STORAGE_CONNECTION_STRING) {
  console.error('AZURE_STORAGE_CONNECTION_STRING is not set');
  process.exit(1);
}

const blobService = BlobServiceClient.fromConnectionString(STORAGE_CONNECTION_STRING);
const container = blobService.getContainerClient(STORAGE_CONTAINER);

const app = express();
app.disable('x-powered-by');

// Browser-facing endpoints (upload/list/editor-url) may be called cross-origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ---------- access tokens ----------

function signToken(fileId, expiresAt) {
  const mac = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${fileId}|${expiresAt}`)
    .digest('base64url');
  return `${expiresAt}.${mac}`;
}

function issueToken(fileId) {
  return signToken(fileId, Date.now() + TOKEN_TTL_MS);
}

function verifyToken(fileId, token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = signToken(fileId, expiresAt);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function requireToken(req, res, next) {
  const token = req.query.access_token;
  if (!verifyToken(req.params.id, token)) {
    return res.status(401).json({ error: 'Invalid or expired access_token' });
  }
  next();
}

// ---------- helpers ----------

function blobFor(fileId) {
  return container.getBlockBlobClient(fileId);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

let discoveryCache = { xml: null, fetchedAt: 0 };

async function getEditorUrlSrc(ext) {
  if (!discoveryCache.xml || Date.now() - discoveryCache.fetchedAt > 60 * 60 * 1000) {
    const resp = await fetch(`${COLLABORA_BASE_URL}/hosting/discovery`);
    if (!resp.ok) throw new Error(`discovery fetch failed: ${resp.status}`);
    discoveryCache = { xml: await resp.text(), fetchedAt: Date.now() };
  }
  // Prefer the "edit" action for this extension, fall back to any urlsrc
  const editRe = new RegExp(`ext="${ext}"[^>]*name="edit"[^>]*urlsrc="([^"]+)"`, 'i');
  const anyRe = new RegExp(`ext="${ext}"[^>]*urlsrc="([^"]+)"`, 'i');
  const m = discoveryCache.xml.match(editRe) || discoveryCache.xml.match(anyRe);
  if (!m) throw new Error(`no Collabora action found for extension .${ext}`);
  return m[1];
}

// ---------- health ----------

app.get('/', (req, res) => {
  res.json({ service: 'ezofis-office-viewer-wopi', status: 'ok' });
});

// ---------- Collabora proxies (convenience: same endpoints as the Collabora host) ----------

app.get('/hosting/capabilities', async (req, res) => {
  try {
    const resp = await fetch(`${COLLABORA_BASE_URL}/hosting/capabilities`);
    res.status(resp.status).type('application/json').send(await resp.text());
  } catch (err) {
    res.status(502).json({ error: `Collabora unreachable: ${err.message}` });
  }
});

app.get('/hosting/discovery', async (req, res) => {
  try {
    const resp = await fetch(`${COLLABORA_BASE_URL}/hosting/discovery`);
    res.status(resp.status).type('text/xml').send(await resp.text());
  } catch (err) {
    res.status(502).json({ error: `Collabora unreachable: ${err.message}` });
  }
});

// ---------- file management (called by your app) ----------

// Upload a document. Returns the file id, WOPI URL and a ready-to-use editor URL.
app.post('/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'multipart field "file" is required' });
    const fileId = crypto.randomUUID();
    const blob = blobFor(fileId);
    await blob.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype || 'application/octet-stream' },
      metadata: { filename: encodeURIComponent(req.file.originalname) },
    });
    const token = issueToken(fileId);
    const wopiSrc = `${baseUrl(req)}/wopi/files/${fileId}`;
    res.status(201).json({
      fileId,
      fileName: req.file.originalname,
      size: req.file.size,
      wopiSrc,
      accessToken: token,
      editorUrl: await buildEditorUrl(req, fileId, req.file.originalname, {}),
    });
  } catch (err) {
    console.error('upload failed', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/files', async (req, res) => {
  try {
    const files = [];
    for await (const item of container.listBlobsFlat({ includeMetadata: true })) {
      files.push({
        fileId: item.name,
        fileName: decodeURIComponent(item.metadata?.filename || item.name),
        size: item.properties.contentLength,
        lastModified: item.properties.lastModified,
      });
    }
    res.json(files);
  } catch (err) {
    console.error('list failed', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/files/:id', async (req, res) => {
  try {
    await blobFor(req.params.id).deleteIfExists();
    res.json({ deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function buildEditorUrl(req, fileId, fileName, { permission, origin }) {
  const ext = (fileName.split('.').pop() || 'docx').toLowerCase();
  const urlsrc = await getEditorUrlSrc(ext);
  const wopiSrc = `${baseUrl(req)}/wopi/files/${fileId}`;
  const params = new URLSearchParams({
    WOPISrc: wopiSrc,
    access_token: issueToken(fileId),
    access_token_ttl: '0',
  });
  if (permission) params.set('permission', permission);
  if (origin) params.set('postMessageOrigin', origin);
  return `${urlsrc}${params.toString()}`;
}

// Build the Collabora iframe URL for an existing file.
// GET /editor-url/:id?permission=readonly&origin=http://localhost:8080
app.get('/editor-url/:id', async (req, res) => {
  try {
    const blob = blobFor(req.params.id);
    const props = await blob.getProperties();
    const fileName = decodeURIComponent(props.metadata?.filename || req.params.id);
    const editorUrl = await buildEditorUrl(req, req.params.id, fileName, {
      permission: req.query.permission,
      origin: req.query.origin,
    });
    res.json({ fileId: req.params.id, fileName, editorUrl });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'file not found' });
    console.error('editor-url failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- WOPI protocol (called by Collabora) ----------

// CheckFileInfo
app.get('/wopi/files/:id', requireToken, async (req, res) => {
  try {
    const props = await blobFor(req.params.id).getProperties();
    const fileName = decodeURIComponent(props.metadata?.filename || req.params.id);
    res.json({
      BaseFileName: fileName,
      Size: props.contentLength,
      UserId: 'ezofis-user',
      UserFriendlyName: 'ezofis user',
      UserCanWrite: true,
      HideUserList: true,
      DisablePrint: false,
      DisableExport: false,
      HideSaveOption: true,
      DownloadAsPostMessage: true,
      LastModifiedTime: props.lastModified.toISOString(),
      PostMessageOrigin: req.query.origin || '*',
    });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).end();
    console.error('CheckFileInfo failed', err);
    res.status(500).end();
  }
});

// GetFile
app.get('/wopi/files/:id/contents', requireToken, async (req, res) => {
  try {
    const download = await blobFor(req.params.id).download();
    res.setHeader('Content-Type', download.contentType || 'application/octet-stream');
    download.readableStreamBody.pipe(res);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).end();
    console.error('GetFile failed', err);
    res.status(500).end();
  }
});

// PutFile (save from Collabora)
app.post(
  '/wopi/files/:id/contents',
  requireToken,
  express.raw({ type: '*/*', limit: '100mb' }),
  async (req, res) => {
    try {
      const blob = blobFor(req.params.id);
      const existing = await blob.getProperties().catch(() => null);
      await blob.uploadData(req.body, {
        blobHTTPHeaders: { blobContentType: existing?.contentType || 'application/octet-stream' },
        metadata: existing?.metadata,
      });
      res.json({ LastModifiedTime: new Date().toISOString() });
    } catch (err) {
      console.error('PutFile failed', err);
      res.status(500).end();
    }
  }
);

app.listen(PORT, () => {
  console.log(`WOPI host listening on :${PORT}`);
  console.log(`  Storage container: ${STORAGE_CONTAINER}`);
  console.log(`  Collabora: ${COLLABORA_BASE_URL}`);
});
