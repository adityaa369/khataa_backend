# Phase 4E - Suite 14: Dependency & Supply Chain Audit (Remediated)

## 1. Node.js Runtime Upgrade
- **Before:** `node:18-alpine` in `Dockerfile` and `18.16.0` in `render.yaml`. Node 18 has been EOL since April 2025.
- **After:** Upgraded to `node:22-alpine` in `Dockerfile` and `22.14.0` in `render.yaml`.
- **Verification:** The full Khataa API successfully booted and executed all financial workflows, confirming PM2/Node 22 compatibility.

## 2. Dependency Audit Trail (`npm ls`)

| Dependency | Before (Pre-Flight) | After (Post-Upgrade) | Change / Note |
| --- | --- | --- | --- |
| `express` | `4.22.1` | `4.22.2` | Bumped to address downstream vulnerabilities |
| `path-to-regexp` | `0.1.12` (High ReDoS) | `0.1.13` (Patched) | High vulnerability remediated via Express bump |
| `socket.io` | `4.8.3` | `4.8.3` | Stayed at 4.x compatible release |
| `socket.io-parser` | `4.2.6` (High DoS) | `4.2.7` (Patched) | High vulnerability remediated via lockfile update |
| `firebase-admin` | `13.7.0` | `14.3.0` | Upgraded to latest compatible version |
| `protobufjs` | `7.5.4` (Critical DoS) | `7.6.6` (Patched) | Critical vulnerability remediated via Firebase Admin bump |
| `websocket-driver` | `0.7.4` (Critical) | `0.7.5` (Patched) | Critical vulnerability remediated via Firebase Admin bump |
| `speakeasy` | `2.0.0` | `2.0.0` | Abandoned. Left intact; marked as tech debt |

## 3. Post-Upgrade Audit (`npm audit`)
- **Total Vulnerabilities Reduced:** Dropped from **31** to **7**.
- **Remaining Critical:** 0
- **Remaining High:** 1 (`nodemailer`)
- **Remaining Moderate:** 6 (all transitive via `uuid < 11.1.1`)

### Classification of Remaining Vulnerabilities

#### Nodemailer (High) - Residual Risk Assessment
The `npm audit` flagged `nodemailer <= 9.0.0` with multiple High-severity CVEs. Because upgrading to `9.0.6` is a breaking major upgrade, we evaluated the exact vulnerable paths.

| Vulnerability | Exploitable Condition | Is Reachable in Khataa? | Status |
| --- | --- | --- | --- |
| **GHSA-c7w3-x93f-qmm8** (SMTP Injection) | Depends on unsanitized `envelope.size` parameter. | **No.** Our wrapper (`utils/email.js`) does not construct or allow custom `envelope` attributes. | Unreachable |
| **GHSA-vvjj-xcjg-gr5g** (CRLF in HELO) | Requires attacker-controlled `name` option in the Transport configuration. | **No.** We statically configure the transport (`host`, `port`, `auth`); no user input defines the transport name. | Unreachable |
| **GHSA-268h-hp4c-crq3** (CRLF in List-*) | Requires attacker-controlled `List-*` headers. | **No.** We strictly pass `from`, `to`, `subject`, `text`, and `html`. | Unreachable |
| **GHSA-wqvq-jvpq-h66f** (jsonTransport bypass) | Depends on using `jsonTransport`. | **No.** We use standard SMTP transport (`createTransport`). | Unreachable |
| **GHSA-p6gq-j5cr-w38f** (Raw Message SSRF) | Depends on the `raw` message option. | **No.** The `raw` option is never exposed or used. | Unreachable |
| **GHSA-r7g4-qg5f-qqm2** (OAuth2 TLS bypass) | Depends on OAuth2 token fetch. | **No.** We use `user`/`pass` basic auth (`SMTP_USER`, `SMTP_PASS`). | Unreachable |
| **GHSA-mm7p-fcc7-pg87** (Interpretation Conflict) | Complex recipient string misinterpretation. | **No.** We only send to strongly-typed Mongoose `user.email` strings collected during KYC. | Unreachable |
| **GHSA-rcmh-qjqh-p98v** (addressparser DoS) | Malformed, deeply nested email addresses. | **Low Risk.** `user.email` is validated on registration via `express-validator` and regex, preventing malicious nesting. | Mitigated |

**Residual Risk Decision:** Because every single High-severity CVE vector in Nodemailer is structurally unexposed/unreachable by external input in our implementation, we explicitly **ACCEPT THE RISK** and bypass the breaking major upgrade for Phase 4E.

#### Transitive Vulnerabilities
| Package | Severity | Vector | Justification / Status |
| --- | --- | --- | --- |
| `uuid` | Moderate | Transitive (via `firebase-admin` -> `@google-cloud/firestore` -> `gaxios` / `teeny-request`) | **Unreachable / Risk Accepted.** The vulnerability applies to manually provided buffer arrays in UUID v3/v5/v6. Our application and GCP APIs do not execute these code paths with user-provided arrays. |