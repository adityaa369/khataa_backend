const mongoose = require('mongoose');
const s = new mongoose.Schema({ id: String, name: String });
const M = mongoose.model('M', s);
const doc = new M({ _id: new mongoose.Types.ObjectId(), name: 'test' });
console.log('doc.id:', doc.id);
