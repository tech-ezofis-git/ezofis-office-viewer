# ezofis-office-viewer

Collabora Online + WOPI host for ezofis Office Viewer.

## Layout

| Path | Purpose |
|------|---------|
| `WOPI/` | Node.js WOPI host API (Azure Blob storage) — deployed to App Service |
| `.github/workflows/azure-deploy.yml` | CI/CD → `ez-officeviewer-wopi` |

## WOPI API

See [WOPI/README.md](WOPI/README.md).

After deploy:

- Health: `https://ez-officeviewer-wopi.azurewebsites.net/`
- WOPI CheckFileInfo: `https://ez-officeviewer-wopi.azurewebsites.net/wopi/files/{id}?access_token=...`
- Upload: `POST https://ez-officeviewer-wopi.azurewebsites.net/files`
