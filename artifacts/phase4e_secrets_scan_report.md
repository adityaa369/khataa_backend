# Phase 4E - Suite 13: Secrets & Configuration Scan

## Scan Parameters
The scan targeted all source code, git history, configuration files (`.env`, `ecosystem.config.js`, `render.yaml`, `Dockerfile`), and deployment configurations to classify and detect leaked secrets or misconfigurations.

## Discovery Results

| Secret / Config | Location | Classification | Current Exposure | Git History | Action Required |
| --- | --- | --- | --- | --- | --- |
| **MongoDB Credential** | `.env` | Secret | **Protected** | 🚨 **EXPOSED** | **Rotate/Revoke** |
| **JWT Secret** | `.env` | Secret | **Protected** | 🚨 **EXPOSED** | **Rotate/Revoke** |
| **Firebase Admin Key** | `FIREBASE_SERVICE_ACCOUNT` (env string) | Privileged Secret | **Protected** | Clean | None |
| **Firebase Client Key** | `.env` | Public Client Config | **Intentional** | Clean | None |
| **MSG91 Auth Key** | `.env` | Secret | **Protected** | Clean | None |
| **SMTP Credentials** | Server Env | Secret | **Protected** | Clean | None |
| **Encryption Key** | Server Env | Secret | **Protected** | Clean | None |
| **Migration Secret** (`x-migration-bypass`) | `middleware/MaintenanceGuard.js` | Privileged Secret | **Restricted** (IP restricted) | Clean | **Rotate/Revoke** |

### Git History Exposure 🚨
The repository's git history contains the actual production MongoDB URI (with password `REDACTED`) and the JWT Secret (`REDACTED`) in three files:
- `index_final.js` (Jun 5 2026, Feb 14 2026)
- `index_hardcoded.js`
- `clear_prod.js`

While these files have been subsequently deleted from the current source tree, the secrets remain deeply embedded in the git history and must be assumed compromised.

### Migration Bypass (`x-migration-bypass`)
The fallback bypass secret `INTERNAL_MIGRATION_ONLY` is hardcoded in `middleware/MaintenanceGuard.js` for when `MIGRATION_SECRET` is omitted from the environment. Although the `MaintenanceGuard` strictly limits the bypass to internal `127.0.0.1` origins—preventing external exploitation—the presence of an internal fallback string in the source code violates strict secret separation.

### Production Environment Separation
- `render.yaml` dynamically provisions secrets from `khatha-secrets` groups.
- `ecosystem.config.js` properly specifies the `NODE_ENV: "production"` boundary.

## Next Steps
To formally close the Acceptance Gate for Suite 13, the following remediation actions must be performed:
1. Hard-rotate the `JWT_SECRET` in `.env` using a staggered rotation approach (set old key to `JWT_SECRET_PREVIOUS`).
2. Require rotation of the Atlas MongoDB `adityaamruthaluri369_db_user` password (since we cannot do this programmatically).
3. Eliminate the hardcoded `INTERNAL_MIGRATION_ONLY` fallback in `MaintenanceGuard.js`.
