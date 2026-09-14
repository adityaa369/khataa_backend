import re

with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace sendPushNotification(...) blocks with nothing.
# We'll use a regex that matches `sendPushNotification(...)` and any preceding `if (borrowerUser && borrowerUser.fcmToken) {` blocks.
# Actually, since the nesting varies, it's safer to just comment them out or remove them manually.
# Let's do a smart regex replacement for common patterns.

patterns_to_remove = [
    r"const \{ sendPushNotification \} = require\('\.\./utils/fcm'\);\s*",
    r"if \(borrowerUser && borrowerUser\.fcmToken\) \{\s*sendPushNotification\([^)]+\)\.catch\([^)]+\);\s*\}\s*",
    r"if \(borrower\.fcmToken\) \{\s*sendPushNotification\([^)]+\)\.catch\([^)]+\);\s*\}\s*",
    r"if \(req\.user && req\.user\.fcmToken\) \{\s*sendPushNotification\([^)]+\)\.catch\([^)]+\);\s*\}\s*",
    r"sendPushNotification\([^)]+\)\.catch\([^)]+\);\s*",
]

for pat in patterns_to_remove:
    content = re.sub(pat, '', content)

# Special case for 1136: sendPushNotification(borrower.fcmToken, title, body, { type: 'PAYMENT_NUDGE_SENT', loanId: loan._id.toString() })
content = re.sub(r"if \(borrower\.fcmToken\) \{\s*sendPushNotification\([^)]+\)\s*\}\s*", '', content)

# But wait, sendPaymentNudge should insert into outbox instead!
# If I just remove sendPushNotification, sendPaymentNudge will do nothing.

with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done stripping inline pushes.")
