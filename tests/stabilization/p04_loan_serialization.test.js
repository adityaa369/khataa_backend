const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { cacheInvalidate } = require('../../config/redis');
const mongoose = require('mongoose');

// This file would be run via a runner that handles DB setup/teardown and app initialization.
// We'll export a run function to be called by runner.js.

async function run(app, token, testUserId) {
  let assertions = 0;
  
  // 1. Clear Redis cache for the user
  await cacheInvalidate(testUserId);
  
  // 2. GET /api/loans/given (Cache MISS)
  const res1 = await request('http://localhost:5000')
    .get('/api/loans/given')
    .set('Authorization', `Bearer ${token}`);
    
  if (res1.status !== 200) throw new Error(`Expected 200, got ${res1.status}`);
  assertions++;
  
  const loans1 = res1.body.loans;
  if (!loans1 || loans1.length === 0) {
    throw new Error('No loans returned');
  }
  
  const loan1 = loans1[0];
  if (typeof loan1.amountPaise !== 'number' || loan1.amountPaise < 0) {
    throw new Error('amountPaise missing or invalid in MISS response');
  }
  assertions++;
  
  if (loan1.principalOutstandingPaise !== null && (typeof loan1.principalOutstandingPaise !== 'number' || loan1.principalOutstandingPaise < 0)) {
    throw new Error('principalOutstandingPaise invalid in MISS response');
  }
  assertions++;

  // 3. GET /api/loans/given (Cache HIT)
  const res2 = await request('http://localhost:5000')
    .get('/api/loans/given')
    .set('Authorization', `Bearer ${token}`);
    
  if (res2.status !== 200) throw new Error(`Expected 200, got ${res2.status}`);
  assertions++;
  
  const loan2 = res2.body.loans[0];
  
  // Deep equality check between MISS and HIT
  const assertDeepEqual = require('assert').deepStrictEqual;
  assertDeepEqual(loan1, loan2);
  assertions++;

  // Write fixture for Flutter
  const fixturePath = path.join(__dirname, '../../../test/fixtures/p04_given_response.json');
  fs.writeFileSync(fixturePath, JSON.stringify(res1.body, null, 2));

  return { pass: true, assertions };
}

module.exports = { run };
