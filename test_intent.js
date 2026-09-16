const express = require("express");
const app = express();
const intentRoutes = require("./routes/intents");
app.use("/api/intents", intentRoutes);
console.log("Router mounted successfully without crashing.");

