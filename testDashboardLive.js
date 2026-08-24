const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

async function test() {
    await mongoose.connect('mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0');
    const AdminSchema = new mongoose.Schema({ email: String, role: String });
    const Admin = mongoose.model('Admin', AdminSchema);
    const admin = await Admin.findOne({ email: 'operator@khatha.app' });
    const token = jwt.sign({ adminId: admin._id, role: admin.role, mfaVerified: true }, '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424', { expiresIn: '1h' });
    
    const headers = { Authorization: `Bearer ${token}` };
    const apiBaseUrl = 'https://khataa-backend.onrender.com';
    
    try {
        const dashRes = await axios.get(`${apiBaseUrl}/api/admin/dashboard`, { headers });
        console.log("Dashboard OK:", dashRes.status);
    } catch(e) { console.error("Dashboard Failed:", e.response ? e.response.status : e.message); }
    
    try {
        const finRes = await axios.get(`${apiBaseUrl}/api/admin/financial/overview`, { headers });
        console.log("Fin OK:", finRes.status);
    } catch(e) { console.error("Fin Failed:", e.response ? e.response.status : e.message); }
    
    try {
        const reconRes = await axios.get(`${apiBaseUrl}/api/admin/reconciliation/overview`, { headers });
        console.log("Recon OK:", reconRes.status);
    } catch(e) { console.error("Recon Failed:", e.response ? e.response.status : e.message); }
    process.exit(0);
}
test();
