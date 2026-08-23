# KHATHA: SPRINT 4.2 DATABASE RELIABILITY REPORT

## Executive Summary
This report details the operational, structural, and financial integrity of the MongoDB schemas powering the Khatha application. Given that MongoDB is the authoritative ledger for Khatha's financial ecosystem, all race conditions, index gaps, and floating-point errors here represent critical business risks.

**Collections Audited:** 18
**Total Potential PM2 Mongo Connections:** 200 (4 workers × 50 maxPoolSize). *Warning: MongoDB Atlas Free tier limits connections to 500. A spike in workers could exhaust pool limits.*

---

## 1. Index Audit & Query Plans

### **Missing / COLLSCAN Indexes**
* **`AuditLog`**: Lacks all indexes. Queries against `userId` or `resourceId` will execute a full COLLSCAN. (Severity: **MEDIUM**).
* **`ChitFund`**: Lacks an index on `owner`. `ChitFund.find({ owner: req.user.id })` triggers a COLLSCAN. (Severity: **HIGH**).
* **`ChitSubscription`**: Has a compound unique index `{ user: 1, chitFund: 1 }`. However, querying `ChitSubscription.find({ chitFund: XYZ })` (to fetch members of a chit) bypasses the prefix rule, resulting in a COLLSCAN. Needs an explicit index on `{ chitFund: 1 }`. (Severity: **HIGH**).
* **`Loan`**: Pagination and sorting is currently handled in JavaScript memory! `getGivenLoans` executes `Loan.find({ lender })` and subsequently uses `Array.prototype.sort`. This will catastrophically exhaust heap memory at scale. Requires compound index: `{ lender: 1, createdAt: -1 }`. (Severity: **CRITICAL**).

### **Uniqueness & Integrity (PASS)**
* **`Session`**: Enforces TTL via `expiresAt: { expires: '1s' }` and indexes `userId`.
* **`IdempotencyKey`**: Enforces strict `{ key: 1, user: 1 }` uniqueness and `expires: '1s'` cleanup.
* **`ChitLedger` & `ChitAuction`**: Both strictly enforce `{ groupId: 1, cycleIndex: 1 }` uniqueness, structurally blocking double-auctions.

---

## 2. Financial Consistency & Representation

### **Floating-Point vs. Paise Accounting (FAIL)**
* **Chit System**: correctly utilizes `Money.toPaise()` internally.
* **Loan System**: `Loan.js` stores `amount`, `emiAmount`, `totalPayable`, and `paidAmount` as raw `Number` without `Number.isInteger` validation. `controllers/loans.js` accepts floating point values directly from `req.body.amount`. This is a severe financial correctness vulnerability that will lead to float-drift (e.g., `0.1 + 0.2 = 0.30000000000000004`). (Severity: **CRITICAL**).

### **Financial Immutability (FAIL)**
* **`Loan.transactions`**: Embedded directly in the `Loan` document via a loosely defined sub-document array. They are mutated via raw `push()`. They should be standalone, immutable ledger entries tied to the `LedgerEntry` system for cryptographic auditability. (Severity: **HIGH**).

---

## 3. Database Transactions & Concurrency

### **Transaction Boundary Escapes (FAIL)**
While Sprint 3.9 identified the lack of `withTransaction` in `recordPayment`, an exhaustive codebase search reveals the vulnerability is widespread across the Loan system:
* `BidService.placeBid` (Chit) uses `withTransaction`. [PASS]
* `chitFunds.declareWinner` uses `withTransaction`. [PASS]
* `loans._handleCustomTransaction` uses naked `save()`. [FAIL]
* `loans.createLoan` uses naked `save()`. [FAIL]
* `loans.verifyLoan` uses naked `save()`. [FAIL]

**Every operation in `controllers/loans.js` mutates financial state outside of the atomic MongoDB transactional boundary.** (Severity: **CRITICAL**).

---

## 4. Referential Integrity

* **Users Deletion**: The system uses `String` custom identifiers for users (e.g. `user_xyz`) rather than ObjectIds. Deleting a User document natively bypasses referential constraints in MongoDB. A soft-delete (`status: 'closed'`) state machine must be enforced to prevent orphaned `Loan` and `ChitSubscription` records. (Severity: **MEDIUM**).

---

## Action Plan
Before proceeding to **Sprint 4.3 (Disaster Recovery)**, the following remediation must occur:
1. Inject the missing compound and individual query indexes (`AuditLog`, `ChitFund`, `ChitSubscription`, `Loan`).
2. Implement true Paise (`Integer`) enforcement across the `Loan` schema and its respective controllers.
3. Wrap all `Loan` mutations inside `withTransaction(async (session) => {...})`.
4. Downscale `maxPoolSize` in `index.js` to 25 to prevent connection exhaustion under PM2 scaling.
