const fs = require('fs');
let userJs = fs.readFileSync('models/User.js', 'utf8');
if (!userJs.includes('profileImageId')) {
    userJs = userJs.replace(
        '    city: String,\n    address: String,\n',
        '    city: String,\n    address: String,\n    profileImageId: String,\n'
    );
    fs.writeFileSync('models/User.js', userJs);
    console.log("Fixed User.js");
}
