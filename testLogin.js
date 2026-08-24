const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
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
        
        console.log('Fetching admin...');
        const admin = await Admin.findOne({ email });
        console.log('Admin found:', admin ? 'Yes' : 'No');
        
        if (admin) {
            console.log('Hash in DB:', admin.passwordHash);
            const isValid = await admin.comparePassword(password);
            console.log('Password valid:', isValid);
        }
        process.exit(0);
    } catch(e) {
        console.error('ERROR:', e);
        process.exit(1);
    }
};
testLogin();
