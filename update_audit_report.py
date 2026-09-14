import sys
with open('artifacts/phase4e_supply_chain_audit.md', 'r', encoding='utf-8') as f:
    content = f.read()

replacement = """### Classification of Remaining Vulnerabilities

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
| `uuid` | Moderate | Transitive (via `firebase-admin` -> `@google-cloud/firestore` -> `gaxios` / `teeny-request`) | **Unreachable / Risk Accepted.** The vulnerability applies to manually provided buffer arrays in UUID v3/v5/v6. Our application and GCP APIs do not execute these code paths with user-provided arrays. |"""

import re
content = re.sub(r'### Classification of Remaining Vulnerabilities.*', replacement, content, flags=re.DOTALL)

with open('artifacts/phase4e_supply_chain_audit.md', 'w', encoding='utf-8') as f:
    f.write(content)
