const mongoose = require('mongoose');

const s = new mongoose.Schema({ id: String }, { timestamps: true });
console.log("Has id path?", !!s.path('id'));
console.log("Has id virtual?", !!s.virtuals['id']);

const M = mongoose.model('M', s);
const doc = new M({ _id: new mongoose.Types.ObjectId() }); // Do not pass id
console.log("doc.id (getter):", doc.id);
console.log("doc.get('id'):", doc.get('id'));

// Test setting and saving (simulate)
doc.id = 'custom-uuid';
console.log("After setting, doc.id:", doc.id);
