// sprint2_verification_matrix.js
// Execute this test matrix against a live MongoDB replica set instance.

const checks = [
    "--- Atomic bidding ---",
    "[ ] 1 valid bid",
    "[ ] Higher/non-improving bid rejected",
    "[ ] Two simultaneous bids (Race condition check)",
    "[ ] 10 simultaneous bids",
    "[ ] 100 simultaneous bids",
    "[ ] Bid after auction close",
    "[ ] Non-member bid",
    "[ ] Unauthorized bid",
    "[ ] Duplicate idempotency key",
    "[ ] WebSocket reconnect",
    "",
    "--- Settlement ---",
    "[ ] Winner correctly determined",
    "[ ] One winner",
    "[ ] One ChitLedger",
    "[ ] One settlement",
    "[ ] Commission correct",
    "[ ] Dividend correct",
    "[ ] Prize amount correct",
    "[ ] Member balances correct",
    "[ ] Next cycle advances once",
    "[ ] Duplicate declare-winner safe",
    "[ ] Concurrent declare-winner safe",
    "[ ] Failure rolls everything back",
    "",
    "--- Financial invariants ---",
    "[ ] No fractional paise",
    "[ ] No money disappears",
    "[ ] No money appears from nowhere",
    "[ ] Debit = Credit",
    "[ ] Dividend allocation sums exactly",
    "[ ] Commission matches configured percentage",
    "[ ] Winner payout matches settlement rules",
    "",
    "--- Crash test ---",
    "[ ] Auction -> Bid accepted -> ?? Kill backend -> Verify auction/ChitBid/Ledger"
];

console.log("=== Sprint 2 Verification Checklist ===");
checks.forEach(c => console.log(c));
console.log("=======================================");
