# SECRET ROTATION RUNBOOK

## ?? HISTORICAL EXPOSURE DETECTED (SPRINT 3.5)
**Status:** ACTION REQUIRED
**Findings:** The Git history of this repository contains plain text production credentials.
1. **MongoDB Atlas:** `adityaamruthaluri369_db_user` / `REDACTED`
2. **JWT Secret:** `REDACTED`

**Immediate Action:**
- Log into MongoDB Atlas and DELETE or ROTATE the password for `adityaamruthaluri369_db_user`.
- Change `JWT_SECRET` in your production `.env` and Render dashboard.

---

## Standard Rotation Procedure

### 1. Identify compromised secret
Identify exactly what leaked (e.g. JWT_SECRET, ENCRYPTION_KEY, FIREBASE_API_KEY). Do NOT panic-delete it if the system is live.

### 2. JWT Signing Key Rotation (Zero Downtime)
If `JWT_SECRET` is compromised:
1. Generate a new strong secret: `K2`
2. Update the environment variables in your deployment (e.g. Render/AWS):
   - Set `JWT_SECRET_PREVIOUS` = `<the old compromised key>`
   - Set `JWT_SECRET` = `<K2>`
3. Restart the server. New logins will receive ATs signed with `K2`. Active sessions (15-min life) signed with the old key will gracefully validate via `JWT_SECRET_PREVIOUS`.
4. Wait 16 minutes (longer than the 15m token lifecycle).
5. Remove `JWT_SECRET_PREVIOUS` from the environment completely.

### 3. KYC Encryption Key Rotation
If `ENCRYPTION_KEY` is compromised:
1. Ensure the attacker does NOT have the database dump. If they do, the data is already compromised.
2. The current implementation uses AES-256-GCM. We must perform an envelope re-encryption or a manual migration.
3. Write a script that iterates `User.find()`, decrypts using the old key, and re-encrypts using a new `ENCRYPTION_KEY_V2`.
4. Update the schema logic to check key versions.

### 4. Third-Party Credentials (Firebase / MongoDB / SMS)
1. Generate a second active API key or Database User in the provider's dashboard.
2. Update the backend `.env` to the new credential and deploy.
3. Verify the backend reconnects successfully.
4. Delete the original compromised credential from the provider dashboard.

### 5. Flutter Security Warning
**NEVER** ship the backend `.env` file, MongoDB URIs, or `ENCRYPTION_KEY` inside the Flutter client. The APK can be decompiled in seconds.
