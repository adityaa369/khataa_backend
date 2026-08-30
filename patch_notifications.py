import re

with open('controllers/loans.js', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Lender Setup Verification
c = re.sub(
    r"`A credit agreement setup for [^`]+initiated by \$\{lenderName\}\.`",
    "`A credit agreement setup has been initiated. Tap to view.`",
    c
)

# 2. Loan Progress Updated
c = re.sub(
    r"`Your lender has updated the repayment progress for your loan of [^`]+`",
    "`Your lender has updated the repayment progress for your loan. Tap to view.`",
    c
)

# 3. New Agreement Request
c = re.sub(
    r"`\$\{req\.user\.firstName \|\| 'Someone'\} has confirmed sending you a loan out for [^`]+\. Tap to review and accept via Digital Signature\.`",
    "`${req.user.firstName || 'Someone'} has sent you a new agreement request. Tap to review and accept via Digital Signature.`",
    c
)

# 4. Agreement Closed (Lender)
c = re.sub(
    r"`The loan agreement for [^`]+ has been successfully closed\.`",
    "`The loan agreement has been successfully closed. Tap to view.`",
    c
)

# 5. Agreement Closed (Borrower)
c = re.sub(
    r"`Your loan agreement for [^`]+ has been successfully closed\.`",
    "`Your loan agreement has been successfully closed. Tap to view.`",
    c
)

with open('controllers/loans.js', 'w', encoding='utf-8') as f:
    f.write(c)
