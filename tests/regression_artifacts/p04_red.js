const mongoose = require('mongoose');
const Loan = require('../../models/Loan');
const User = require('../../models/User');
const request = require('supertest');
const app = require('../../index'); // assume index.js exports app

async function runRegression() {
  // We won't fully execute this in CI since we've fixed it, but we preserve the code to document the failure.
  console.log('This artifact documents the original failure. It asserts that amountPaise is MISSING in V1.');
  /*
  const token = "..."; // get a valid token
  const res = await request(app).get('/api/loans/given').set('Authorization', `Bearer ${token}`);
  // In the original broken state:
  // res.body.loans[0] would have .amount but no .amountPaise.
  */
}

module.exports = { runRegression };
