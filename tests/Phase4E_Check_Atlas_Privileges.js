const { MongoClient } = require('mongodb');
require('dotenv').config();

async function checkPrivileges() {
    console.log('Connecting to Atlas URI:', process.env.MONGODB_URI.replace(/:([^:@]{3,})@/, ':***@'));
    const client = new MongoClient(process.env.MONGODB_URI);
    
    try {
        await client.connect();
        const db = client.db('khatha');
        
        console.log('\n--- Checking user privileges ---');
        const connectionStatus = await db.command({ connectionStatus: 1, showPrivileges: 1 });
        console.log(JSON.stringify(connectionStatus.authInfo, null, 2));
        
        console.log('\n--- Attempting to create a test role ---');
        try {
            await db.command({
                createRole: 'test_role_check',
                privileges: [{ resource: { db: 'khatha', collection: '' }, actions: ['find'] }],
                roles: []
            });
            console.log('✅ Role creation succeeded. This credential has userAdmin rights.');
            await db.command({ dropRole: 'test_role_check' });
        } catch (e) {
            console.log('❌ Role creation failed:', e.message);
        }

    } catch (e) {
        console.error('Fatal:', e);
    } finally {
        await client.close();
    }
}
checkPrivileges();
