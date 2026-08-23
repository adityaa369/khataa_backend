# KHATHA DISASTER RECOVERY & BACKUP RUNBOOK

## 1. RPO and RTO Targets
* **RPO (Recovery Point Objective):** `5 Minutes`.
  * Khatha's financial data must not drift. We utilize MongoDB Atlas **Continuous Cloud Backups (PITR - Point in Time Recovery)** to restore to the exact minute before a catastrophic event.
* **RTO (Recovery Time Objective):** `30 Minutes`.
  * The maximum acceptable time from Incident Declaration to operational traffic restoration.

## 2. Data Classification Matrix
Not all collections require the same level of protection. Restoration focuses on *Authoritative* state.

| Collection | Classification | Must Restore? | Reconstructable? |
| :--- | :--- | :--- | :--- |
| **Loan** | Financial authority | ? Yes | ? No |
| **LedgerEntry** | Financial authority | ? Yes | ? No |
| **ChitLedger** | Financial authority | ? Yes | ? No |
| **ChitBid** | Financial audit | ? Yes | ? No |
| **ChitTransaction** | Financial authority | ? Yes | ? No |
| **User** | Identity / Auth | ? Yes | ? No |
| **AuditLog** | Compliance / Audit | ? Yes | ? No |
| **Session** | Security state | Usually | ? Yes (Users re-login) |
| **OtpChallenge** | Temp Security | No | ? Yes |
| **Redis Cache** | Coordination | ? No | ? Yes |
| **Socket Rooms** | Runtime State | ? No | ? Yes |

## 3. Disaster Response Scenarios

### Scenario A: MongoDB Unavailable (Data Corruption or Deletion)
**Detect:** Health checks fail (`GET /health/ready`), alerts fire in Sentry/Render.
**1. Declare Incident & Kill Switch:** Set `FINANCIAL_KILL_SWITCH=true` in Render to stop all writes and prevent financial divergence.
**2. Assess Atlas:** Log into MongoDB Atlas to determine if it is a transient network issue or actual data loss.
**3. Restore (PITR):** 
   - Navigate to **Atlas -> Clusters -> Backup -> Restore**.
   - Select **Point in Time** right before the corruption.
   - Restore to a **new Isolated DR Cluster** (never overwrite the existing live cluster).
**4. Connect DR Backend:** Point the staging/DR Render backend to the new DR Cluster.
**5. Reconcile:** Run `node scripts/reconcile-financials.js`. Verify user counts, loan state, and ledger debit/credits match the snapshot expectations.
**6. Traffic Restoration:** Update DNS or Render Routing to point to the DR backend, and set `FINANCIAL_KILL_SWITCH=false`.

### Scenario B: Redis Unavailable
**Detect:** Rate limiter fails open/closed, WebSocket rooms disconnect.
**1. Assess:** Check Redis dashboard.
**2. Recover:** If lost, provision a new Redis instance.
**3. Rebuild Coordination:** Update `REDIS_URI`. The backend `utils/redisClient.js` will auto-reconnect. Socket.IO clients will automatically reconnect and pull authoritative state from MongoDB. **No financial data is lost.**

### Scenario C: Backend Workers Crash (e.g. Memory Leak, Infinite Loop)
**Detect:** HTTP 502/503 errors.
**1. PM2 Recovery:** The `ecosystem.config.js` is set to `autorestart: true`. PM2 will instantly replace the crashed worker.
**2. Rollback:** If the crash is persistent, rollback to the previous Render deploy. Active MongoDB transactions will cleanly rollback (no partial financial writes).
