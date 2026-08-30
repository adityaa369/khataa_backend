import re
with open('tests/Phase4E_RateLimit_Audit.js', 'r') as f:
    c = f.read()

c = c.replace('\\`', '`')
c = c.replace('\\$', '$')

with open('tests/Phase4E_RateLimit_Audit.js', 'w') as f:
    f.write(c)
