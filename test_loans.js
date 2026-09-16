const axios = require("axios");
async function test() {
    try {
        let res = await axios.post("https://khataa-backend.onrender.com/api/auth/verify-otp", {
            idToken: "mockToken_9999999999"
        });
        const lenderToken = res.data.token;

        res = await axios.post("https://khataa-backend.onrender.com/api/auth/verify-otp", {
            idToken: "mockToken_8888888888"
        });
        const borrowerToken = res.data.token;
        
        // Update borrower email
        await axios.put("https://khataa-backend.onrender.com/api/auth/me", {
            email: "borrower@test.com",
            firstName: "Borrower",
            lastName: "Test"
        }, {
            headers: { Authorization: `Bearer ${borrowerToken}` }
        });

        res = await axios.post("https://khataa-backend.onrender.com/api/loans", {
            borrower_phone: "8888888888",
            borrower_name: "Test Borrower",
            amount: 1000,
            type: "personal",
            duration_months: 12
        }, {
            headers: { Authorization: `Bearer ${lenderToken}` }
        });

        res = await axios.get("https://khataa-backend.onrender.com/api/loans/taken", {
            headers: { Authorization: `Bearer ${borrowerToken}` }
        });
        console.log("Borrower taken loans count:", res.data.loans.length);
        if (res.data.loans.length > 0) {
            console.log("Loan 0 status:", res.data.loans[0].financialStatus || res.data.loans[0].status);
        }
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
    }
}
test();
