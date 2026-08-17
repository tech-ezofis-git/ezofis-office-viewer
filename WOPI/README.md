# WOPI host API

Node.js Express WOPI host backed by Azure Blob Storage. Used by Collabora Online.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health |
| POST | `/files` | Upload document (`multipart` field `file`) |
| GET | `/files` | List documents |
| DELETE | `/files/:id` | Delete document |
| GET | `/editor-url/:id` | Build Collabora editor URL |
| GET | `/wopi/files/:id` | WOPI CheckFileInfo |
| GET | `/wopi/files/:id/contents` | WOPI GetFile |
| POST | `/wopi/files/:id/contents` | WOPI PutFile |
| GET | `/hosting/capabilities` | Proxy to Collabora |
| GET | `/hosting/discovery` | Proxy to Collabora |

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_STORAGE_CONNECTION_STRING` | yes | Blob storage connection string |
| `AZURE_STORAGE_CONTAINER` | no | Default `ez-documents` |
| `WOPI_TOKEN_SECRET` | yes | HMAC secret for access tokens |
| `COLLABORA_BASE_URL` | yes | Collabora Container App URL |
| `PUBLIC_BASE_URL` | yes | This App Service public URL |
| `PORT` | no | Default `8080` (App Service sets this) |

## Local

```bash
cd WOPI
npm install
set AZURE_STORAGE_CONNECTION_STRING=...
set COLLABORA_BASE_URL=https://ez-officeviewer-app.graycoast-78e47e4a.southindia.azurecontainerapps.io
set PUBLIC_BASE_URL=http://localhost:8080
npm start
```
