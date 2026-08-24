const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const API_URL = 'https://khataa-backend.onrender.com';

async function generateEvents() {
    console.log("Generating controlled events...");

    // 1. Rate Limit (hitting an arbitrary endpoint 25 times quickly)
    console.log("Generating RATE_LIMIT_EXCEEDED...");
    for (let i = 0; i < 25; i++) {
        try {
            await axios.post(`${API_URL}/api/auth/send-otp`, { phone: '9999999999' });
        } catch(e) {}
    }

    // 2. Overpayment Attempt (we need a valid user and loan, let's just use the DB directly to trigger telemetry functions to ensure we don't have to navigate auth tokens for dummy users)
    console.log("Injecting direct telemetry to simulate OVERPAYMENT and OTP_REPLAY...");
    // Let's just require the backend telemetry directly if we connect to DB!
    // But since the user wants us to verify the LIVE API, we should try to do it via the API.
    
}
generateEvents();
