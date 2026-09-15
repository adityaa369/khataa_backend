const request = require('supertest');
const express = require('express');
const { validateCreateLoan } = require('./middleware/validate');

const app = express();
app.use(express.json());
app.post('/loans', validateCreateLoan, (req, res) => {
    res.status(200).json({ success: true, message: 'Passed validation', amountPaise: req.body.amountPaise });
});

request(app)
    .post('/loans')
    .send({
        amountPaise: 200000,
        borrower_phone: '9876543210',
        duration_months: 12,
        borrower_name: 'Test Borrower'
    })
    .expect(200)
    .end((err, res) => {
        if (err) {
            console.error('Validation failed:', res.body);
            process.exit(1);
        }
        console.log('Test 1 Passed: Valid amountPaise goes through validation successfully.');
        
        request(app)
            .post('/loans')
            .send({
                amount: 2000, // Legacy field
                borrower_phone: '9876543210',
                duration_months: 12,
                borrower_name: 'Test Borrower'
            })
            .expect(400)
            .end((err2, res2) => {
                if (err2) {
                    console.error('Expected 400 for legacy payload, got:', res2.status);
                    process.exit(1);
                }
                console.log('Test 2 Passed: Legacy amount field is strictly rejected as per V2 contract.');
                process.exit(0);
            });
    });
