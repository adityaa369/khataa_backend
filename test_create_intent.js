
const mongoose = require("mongoose");
const { createIntent } = require("./controllers/intents");
const Loan = require("./models/Loan");
const TransactionIntent = require("./models/TransactionIntent");

async function run() {
    await mongoose.connect("mongodb+srv://khatha_user:yP3fH9Xf8C@cluster0.b73r74l.mongodb.net/khatha?retryWrites=true&w=majority", { useNewUrlParser: true, useUnifiedTopology: true });
    
    // Find the pending loan
    const loan = await Loan.findOne({ status: "pending_approval" }).sort({ createdAt: -1 });
    if (!loan) {
        console.log("No pending loan found");
        process.exit(1);
    }
    
    console.log("Found Loan:", loan._id);
    
    const req = {
        body: {
            loanId: loan._id.toString(),
            action: "ACCEPT_LOAN"
        },
        user: {
            id: loan.borrower
        }
    };
    
    const res = {
        status: function(code) {
            this.statusCode = code;
            return this;
        },
        json: function(data) {
            console.log("STATUS:", this.statusCode);
            console.log("RESPONSE:", JSON.stringify(data, null, 2));
        }
    };
    
    await createIntent(req, res);
    
    process.exit(0);
}
run();

