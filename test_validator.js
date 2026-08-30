const express = require('express');
const { body, validationResult, matchedData } = require('express-validator');
const app = express();

app.use(express.json());

const validate = [
    body('amount').not().isArray().isInt(),
    (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(errors.array());
        res.json({ amount: matchedData(req).amount, typeofAmount: typeof matchedData(req).amount, isArray: Array.isArray(matchedData(req).amount) });
    }
];

app.post('/test', validate);

const request = require('supertest');
request(app).post('/test').send({ amount: [5000, 6000] }).then(res => console.log(res.status, res.body));
request(app).post('/test').send({ amount: [5000] }).then(res => console.log(res.status, res.body));
