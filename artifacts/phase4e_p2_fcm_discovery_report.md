# P2 FCM Token Ownership - Discovery Report

## Executive Summary
A structural token leakage vulnerability (Stale Binding) exists in the FCM registration and notification routing architecture. 

Currently, device tokens are permanently bound to a user until explicitly overwritten, with no deduplication across accounts and no explicit unbinding during logout. This allows an attacker (or simply the next legitimate user of a device) to receive protected financial notifications intended for the previous logged-in user.

## Technical Findings

The `tests/Phase4E_P2_FCM_Discovery.js` script successfully proved the following four architectural flaws:

### 1. Token Data Model Analysis (FAIL)
**Finding:** `User.fcmToken` lacks a `unique` constraint.
**Impact:** Multiple users in the database can successfully register the same physical device token.

### 2. Token Ownership Attack (FAIL)
**Finding:** When User A registers `TOKEN_X` and User B subsequently logs in on the same device and registers `TOKEN_X`, the backend allows both users to hold `TOKEN_X` simultaneously. 
**Impact:** Financial events triggered for User A will still be pushed to `TOKEN_X`, resulting in severe cross-account information leakage to User B.

### 3. Logout Behavior (FAIL)
**Finding:** There is no backend endpoint (e.g., `POST /logout` or `DELETE /fcm-token`) to unbind a token.
**Impact:** When a user logs out of the Flutter app, their JWT is discarded locally, but the backend maintains a permanent association with their `fcmToken`. They will continue receiving push notifications for their account on that device.

### 4. Notification Routing Check (FAIL)
**Finding:** Financial controllers (`controllers/loans.js`) read `fcmToken` directly from the `User` model and dispatch pushes inline using `sendPushNotification`.
**Impact:** This bypasses the `DeviceToken` registry and the transactional outbox entirely, coupling the core financial transaction loop directly to external network calls (FCM) and the stale token data model.

## Proposed Remediation Plan (To be implemented)

1. **API Refactor (`routes/users.js`)**: 
   - Modify `POST /api/users/fcm-token` to upsert the token into the `DeviceToken` collection (setting `userId`, `platform`, `active=true`), and explicitly deactivate that specific token for any *other* user who might still hold it.
   - Introduce a new `DELETE /api/users/fcm-token` endpoint for explicit token unbinding during client-side logout.
   
2. **Schema Migration**:
   - Deprecate `User.fcmToken` to force the system to rely exclusively on the `DeviceToken` registry.

3. **Controller Decoupling (`controllers/loans.js`)**:
   - Strip all inline `sendPushNotification` calls from the financial controllers.
   - Replace them with direct insertions into the `NotificationOutbox`.
   
4. **Worker Restoration (`workers/NotificationWorker.js`)**:
   - Re-integrate the Notification Worker to reliably consume the outbox, dynamically resolve the active tokens from the `DeviceToken` collection at delivery time, and dispatch the pushes. This ensures notifications are sent to the correct active device regardless of when the outbox event was generated.
