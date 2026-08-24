const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

async function run() {
    await mongoose.connect(MONGODB_URI);
    const AdminSchema = new mongoose.Schema({ email: String, role: String });
    const Admin = mongoose.model('Admin', AdminSchema);
    const admin = await Admin.findOne({ email: 'operator@khatha.app' });
    const token = jwt.sign({ adminId: admin._id, role: admin.role, mfaVerified: true }, '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424', { expiresIn: '1h' });
    
    const res = await axios.get('https://khataa-backend.onrender.com/api/admin/security/events', { headers: { Authorization: `Bearer ${token}` } });
    console.log("Events from LIVE API:", res.data.data.length);
    if (res.data.data.length > 0) {
        console.log("First Event:", res.data.data[0]);
    }
    process.exit(0);
}
run();
