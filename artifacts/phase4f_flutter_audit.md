# Phase 4F - Flutter Client Architecture & Risk Audit

## Executive Summary
This document provides a comprehensive structural audit of the Khataa Flutter application prior to Phase 4F implementation. The objective is to identify deviations between the hardened backend state (Phase 4E) and the current Flutter implementations, exposing potential security, UX, and financial inconsistencies. No behavioral code changes have been made yet.

---

## 1. AuthCubit & Authentication State Machine (`auth_state.dart` & `auth_cubit.dart`)

**Current Responsibility:** Manages session caching, Firebase phone authentication, backend `/auth/me` sync, and navigation states.
**Backend Dependency:** Firebase Auth (OTP), `/auth/me`, `/auth/refresh`.
**Known Issues & Risks:**
- **State Model Mismatch:** The backend expects `Unauthenticated`, `AuthenticatedEmailUnverified`, `AuthenticatedEmailVerifiedKycIncomplete`, and `AuthenticatedKycComplete`. Flutter uses 15 chaotic fragmented states (e.g. `OtpSent`, `PersonalDetailsSaved`, `AuthenticatedFull`).
- **Dangerous Optimistic Boot:** In `checkAuthStatus()`, the app instantly emits `AuthenticatedFull` if a token is in `SecureStorage`, allowing UI access. If `/auth/me` fails due to a network timeout, the app *silently swallows* the error instead of logging the user out, meaning banned or revoked users retain UI access.
- **FCM Token Override:** `_emitAuthenticatedState()` manually POSTs `fcmToken` in the request body. Phase 4E explicitly removed this in favor of implicit registration during `idToken` submission.

## 2. GoRouter & Navigation (`routes.dart`)

**Current Responsibility:** Defines app routes, parses deep links, and redirects unauthenticated users.
**Backend Dependency:** Deep link payloads (FCM).
**Known Issues & Risks:**
- **Deep Link Destruction:** If `AuthCubit` is `AuthInitial` (checking storage), GoRouter immediately redirects protected deep links to `/login`, losing the original `uri`. No `redirect_to` state is preserved.
- **Object-Coupled Routing:** Routes like `AppConstants.loanDetails` strictly require `state.extra as LoanModel`. This prevents FCM notifications (which only provide a string `loanId`) from directly routing to a loan screen.
- **Client-Side Authorization Assumption:** The redirect logic assumes that if the user has `AuthenticatedFull`, they have access to all financial routes, rather than trapping 403s dynamically from the API client.

## 3. API Client & Repository Layer (`api_client.dart`)

**Current Responsibility:** Executes HTTP requests, handles interceptors, JWT injection, and 401 token refreshes.
**Backend Dependency:** All Khataa backend routes.
**Known Issues & Risks:**
- **`dio_smart_retry` Blind Retries:** The client blindly retries failed requests (including timeouts). While `x-idempotency-key` is correctly injected, it must be rigorously verified that the retry loop does not create conflicting states if the backend processes the first request slowly.
- **Token Refresh Single-Flight:** The `_trySingleFlightRefresh()` mechanism is implemented, but if the refresh token is expired (419), it throws `AuthFailure` rather than routing the user cleanly to a session-expired screen.

## 4. LoanRepository & Firebase ID Tokens (`loan_repository.dart`)

**Current Responsibility:** Sends loan mutations (Create, Pay, Verify, Close, Add Credit) to the backend.
**Backend Dependency:** Financial Ledger (`/loans/*`).
**Known Issues & Risks:**
- **Criticial Vulnerability - Legacy OTP Payloads:** The backend's Suite 3 intent overhaul requires `idToken` to verify Firebase Identity. However, `loan_repository.dart` is *still sending* `{ 'otp': otp, 'verificationId': verificationId }` for `verifyLenderOtp`, `closeLoan`, `recordPayment`, and `recordInterest`. These endpoints will immediately fail 400 Bad Request against the hardened backend.
- **Amount Scaling Bug:** `createLoan` sends `amount: amountPaise`. The backend patch now assumes `amount` is in Rupees and applies `Math.round(amount * 100)`. Sending paise will multiply the requested loan by 100 again (e.g., a ₹10,000 loan becomes ₹1,000,000).

## 5. Document Flow & KYC Handling (`loan_model.dart` / `loan_repository.dart`)

**Current Responsibility:** Uploading and retrieving KYC/loan agreement documents.
**Backend Dependency:** Phase 4E GCP Storage (`/api/documents/:documentId`).
**Known Issues & Risks:**
- **Opaque URL Leak:** `uploadDocument` returns `data['url']` which is saved as `documentUrl` in the model.
- **Signed URL Bypass:** The UI likely uses `Image.network(loan.documentUrl)`. Because of the Phase 4E Least-Privilege storage lockdown, the raw bucket URL will yield a 403 Forbidden. Flutter must be refactored to fetch temporary Signed URLs dynamically.

## 6. Financial UI Calculations (`loan_model.dart`)

**Current Responsibility:** Displaying ledger balances, status, and progress.
**Source of Truth Conflict:**
- `LoanModel` correctly identifies `remainingAmount = totalPayablePaise - paidAmountPaise`.
- However, `loanStatus` evaluates strictly from `status` string matching.
- **Risk:** The app lacks a synchronized view of *Interest* models. `totalPayablePaise` does not dynamically reflect newly accrued daily interest unless the app forcibly polls `/loans` daily. The UI might show stale balances.

---

## Conclusion & Proposed Hardening Path
The Flutter client currently trusts its local state too much and uses deprecated DTO contracts (SMS OTPs instead of `idToken`).

To stabilize the Three-Credit Core (Hand, Business, Interest), Phase 4F implementation should proceed in this order:
1. **API & Auth Alignment:** Rewrite `AuthCubit` states, patch `loan_repository` to use `idToken`, fix the `amountPaise` multiplier bug.
2. **Routing & FCM:** Detach `LoanModel` from `GoRouter` (fetch by ID), preserve deep links across cold starts.
3. **Storage Security:** Implement dynamic Signed URL fetching for documents.
4. **Financial Sync:** Eliminate UI-side assumptions of accrued interest; force strict backend alignment.
