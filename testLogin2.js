const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config({ path: './.env' });
const MONGODB_URI = 'mongodb+srv://adityaamruthaluri369_db_user:KL9MXMTFO3Gg3tTh@cluster0.lmdcdic.mongodb.net/khatha?retryWrites=true&w=majority&appName=Cluster0';

const testLogin = async () => {
    try {
        await mongoose.connect(MONGODB_URI);
        const AdminSchema = new mongoose.Schema({
            email: { type: String, required: true, unique: true, index: true },
            passwordHash: { type: String, required: true },
            role: { 
                type: String, 
                enum: ['SUPER_ADMIN', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN', 'READ_ONLY_ADMIN'], 
                required: true 
            }
        });
        AdminSchema.methods.comparePassword = async function (enteredPassword) {
            return await bcrypt.compare(enteredPassword, this.passwordHash);
        };
        const Admin = mongoose.model('Admin', AdminSchema);
        
        const email = 'operator@khatha.app';
        const password = 'operator123';
        
        const admin = await Admin.findOne({ email });
        console.log('Admin found:', admin ? 'Yes' : 'No');
        
        if (!admin || !(await admin.comparePassword(password))) {
            throw new Error('Invalid credentials');
        }
        
        const token = jwt.sign(
            { adminId: admin._id, role: admin.role, mfaVerified: true }, 
            '1be3118c693f296ea3f5f1d57b878a88bd81b53f3a086f1e33823a96b4dc4424', 
            { expiresIn: '1h' }
        );
        
        console.log('SUCCESS:', token);
        process.exit(0);
    } catch(err) {
        console.error('[Admin Login Error]', err);
        process.exit(1);
    }
};
testLogin();
