const mongoose = require('mongoose');
const User = require('../models/User');

console.log("Has id path?", !!User.schema.path('id'));
console.log("Has id virtual?", !!User.schema.virtuals['id']);
console.log("Virtuals:", Object.keys(User.schema.virtuals));
console.log("Strict mode:", User.schema.options.strict);

const doc = new User({ _id: new mongoose.Types.ObjectId(), phone: '123' }); // legacy doc simulation
console.log("doc.id (getter):", doc.id);
console.log("doc.get('id'):", doc.get('id'));

doc.id = 'custom-uuid';
console.log("After setting, doc.id:", doc.id);
console.log("Modified paths:", doc.modifiedPaths());
