const express = require("express");
const app = express();
const intentRoutes = require("./routes/intents");
const loanRoutes = require("./routes/loans");
app.use("/api/loans", loanRoutes);
app.use("/api/intents", intentRoutes);
console.log("Mock boot succeeded.");
