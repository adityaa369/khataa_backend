import re

with open('middleware/validate.js', 'r') as f:
    c = f.read()

c = c.replace("body('amount').notEmpty()", "body('amount').notEmpty().not().isArray().withMessage('Amount cannot be an array')")
c = c.replace("body('duration_months').notEmpty()", "body('duration_months').notEmpty().not().isArray()")

with open('middleware/validate.js', 'w') as f:
    f.write(c)
