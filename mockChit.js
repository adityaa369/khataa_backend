const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const ChitFund = require('./models/ChitFund');
const ChitSubscription = require('./models/ChitSubscription');

// Load env
dotenv.config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/khataa', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(async () => {
    console.log("Connected to DB.");
    
    try {
        let owner = await User.findOne({ phone: { $regex: '9908739556' } });
        
        if (!owner) {
            console.log("Owner not found, creating one.");
            owner = await User.create({
                id: 'mock_owner_id_9908739556',
                phone: '9908739556',
                firstName: 'Test',
                lastName: 'Owner',
                authStatus: 'Active'
            });
        }

        console.log("Owner found: " + owner.firstName);

        // Create 10 fake users
        let fakeUsers = [];
        for(let i = 1; i <= 10; i++) {
            let phoneNum = '99087300' + (i < 10 ? '0' + i : i);
            let user = await User.findOne({ phone: phoneNum });
            if (!user) {
                user = await User.create({
                    id: 'mock_firebase_id_' + phoneNum, // Since Firebase custom IDs are used
                    phone: phoneNum,
                    firstName: 'MockUser',
                    lastName: '' + i,
                    authStatus: 'Active'
                });
                console.log('Created MockUser ' + i);
            }
            fakeUsers.push(user);
        }

        // Create a 10-month Chit Fund
        const chitName = 'Test Mega Group - ' + Date.now();
        const chit = await ChitFund.create({
            name: chitName,
            totalValue: 100000,
            totalMonths: 10,
            monthlySubscription: 10000,
            owner: owner.id,
            status: 'active', // Set to active explicitly as 10 people joined
            currentSubscribersCount: 10,
            completedMonths: 0,
            startDate: new Date(),
            branchName: 'KPHB-CAO'
        });
        console.log('Created Chit Fund: ' + chitName);

        // Add 10 subscriptions (10 members)
        for(let i=0; i<10; i++) {
            await ChitSubscription.create({
                chitFund: chit._id,
                user: fakeUsers[i].id,
                installmentsPaid: 0,
                transactions: [],
                status: 'active'
            });
            console.log('Added ' + fakeUsers[i].firstName + ' ' + fakeUsers[i].lastName + ' to Chit Fund');
        }

        console.log("SUCCESS! The owner is " + ownerPhone + " and the group has 10 members. Now you can test the UI.");

    } catch (e) {
        console.error(e);
    } finally {
        mongoose.disconnect();
    }
}).catch(console.error);
