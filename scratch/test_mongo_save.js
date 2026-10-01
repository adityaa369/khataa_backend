const mongoose = require('mongoose');

async function run() {
  await mongoose.connect('mongodb+srv://khatha-staging:staging123@khatha-staging.q409i.mongodb.net/khatha?retryWrites=true&w=majority', { useNewUrlParser: true, useUnifiedTopology: true });
  const s = new mongoose.Schema({ id: {type: String}, phone: String }, { timestamps: true });
  const M = mongoose.model('TestUser', s);
  
  await M.collection.insertOne({ phone: '9999999999' }); // Raw mongo insert (missing id)
  
  let user = await M.findOne({ phone: '9999999999' });
  console.log("From DB:", user.toObject());
  console.log("!user.id:", !user.id);
  
  if (!user.id) {
      user.id = 'real-uuid';
      await user.save();
  }
  
  let user2 = await M.findOne({ phone: '9999999999' });
  console.log("After save:", user2.toObject());
  
  await M.collection.deleteOne({ phone: '9999999999' });
  await mongoose.disconnect();
}
run().catch(console.error);
