import re

with open('tests/Phase4E_Injection_Audit.js', 'r') as f:
    c = f.read()

c = c.replace('.get(\'/api/loans/invalid_id_format/repayment-timeline\');', '.get(\'/api/loans/invalid_id_format/repayment-timeline\')\n            .set(\'Authorization\', \'Bearer \' + token);')
c = c.replace('.send({ borrower_phone:', '.set(\'Authorization\', \'Bearer \' + token)\n            .send({ borrower_phone:')
c = c.replace('.send({ \n                intentId:', '.set(\'Authorization\', \'Bearer \' + token)\n            .send({ \n                intentId:')

with open('tests/Phase4E_Injection_Audit.js', 'w') as f:
    f.write(c)
