# ezofis Office Viewer — WOPI host API

Node.js WOPI host for Collabora Online. Documents are stored in **Azure Blob Storage**.

Deployed to Azure App Service: `ez-officeviewer-wopi` (plan `asp-ez-officeviewer-b1`, RG `rg-ez-officeviewer`).

## Endpoints

### App-facing

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Health check |
| `POST` | `/files` | Upload document (multipart field `file`) — returns `fileId` + `editorUrl` |
| `GET` | `/files` | List documents |
| `DELETE` | `/files/:id` | Delete document |
| `GET` | `/editor-url/:id?permission=readonly&origin=...` | Build Collabora iframe URL for a file |

### WOPI (called by Collabora)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/wopi/files/:id` | CheckFileInfo |
| `GET` | `/wopi/files/:id/contents` | GetFile |
| `POST` | `/wopi/files/:id/contents` | PutFile (save) |

All WOPI routes require a valid `access_token` (HMAC-signed, issued by this API).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_STORAGE_CONNECTION_STRING` | yes | Blob storage connection string |
| `AZURE_STORAGE_CONTAINER` | no | Container name (default `ez-documents`) |
| `WOPI_TOKEN_SECRET` | yes (prod) | Secret for signing access tokens |
| `COLLABORA_BASE_URL` | no | Collabora server URL (default: ezofis ACA instance) |
| `PUBLIC_BASE_URL` | no | Public URL of this API (behind proxy) |

## Quick test

```bash
# health
curl https://ez-officeviewer-wopi.azurewebsites.net/

# upload
curl -F "file=@test.docx" https://ez-officeviewer-wopi.azurewebsites.net/files

# open returned editorUrl in an iframe
```

## Local dev

```bash
npm install
set AZURE_STORAGE_CONNECTION_STRING=...
npm start
```
