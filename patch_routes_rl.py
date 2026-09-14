import re

with open('routes/loans.js', 'r') as f:
    c = f.read()

# Make sure otpLimiter is imported
if 'otpLimiter' not in c:
    c = c.replace("const { protect } = require('../middleware/auth');", "const { protect } = require('../middleware/auth');\nconst { otpLimiter } = require('../middleware/rateLimiter');")

c = re.sub(r"router\.post\('/\:id/close-otp',\s*requestClosureOtp\);", "router.post('/:id/close-otp', otpLimiter, requestClosureOtp);", c)
c = re.sub(r"router\.post\('/\:id/resend-otp',\s*resendLoanOtp\);", "router.post('/:id/resend-otp', otpLimiter, resendLoanOtp);", c)

with open('routes/loans.js', 'w') as f:
    f.write(c)
