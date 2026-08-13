const mongoose = require('mongoose');
const { repairIndexes } = require('./indexRepair');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/gthink_erp');
    console.log('mongo uri: ', process.env.MONGO_URI || 'mongodb://localhost:27017/gthink_erp');
    console.log('✅ Connected to MongoDB');
    // Indexes an older release declared wrongly, which stop writes rather than
    // slow them. Silent when there is nothing to put right, and never a reason
    // to refuse to start — the database is up, which is what this function
    // promised.
    await repairIndexes().catch((e) => console.error('⚠️  Index check failed:', e.message));
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;
