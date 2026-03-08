const cron = require('node-cron');
const Group = require('../models/Group');
const EarningsAccount = require('../models/EarningsAccount');
const GroupTransaction = require('../models/GroupTransaction');

// ─── Expire active groups past their end_date ────────────────
async function expireGroups() {
  try {
    const result = await Group.updateMany(
      { status: 'active', end_date: { $lte: new Date() } },
      { $set: { status: 'expired' } }
    );
    if (result.modifiedCount > 0) {
      console.log(`⏰ CRON: Expired ${result.modifiedCount} groups`);
    }
  } catch (err) {
    console.error('❌ CRON expireGroups error:', err.message);
  }
}

// ─── Mature pending earnings past release date ───────────────
async function maturePendingEarnings() {
  try {
    const readyTxs = await GroupTransaction.find({
      status: 'paid',
      pending_release_at: { $lte: new Date() },
      earnings_matured: { $ne: true },
    }).lean();

    let matured = 0;
    for (const tx of readyTxs) {
      await EarningsAccount.findOneAndUpdate(
        { user_id: tx.owner_id },
        {
          $inc: { pending_balance: -tx.net, withdrawable_balance: tx.net },
        }
      );
      await GroupTransaction.findByIdAndUpdate(tx._id, { $set: { earnings_matured: true } });
      matured++;
    }
    if (matured > 0) {
      console.log(`💰 CRON: Matured ${matured} earnings transactions`);
    }
  } catch (err) {
    console.error('❌ CRON maturePendingEarnings error:', err.message);
  }
}

function startScheduler() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', expireGroups);

  // Run every 15 minutes
  cron.schedule('*/15 * * * *', maturePendingEarnings);

  console.log('📅 Cron scheduler started');

  // Run once on startup after a short delay
  setTimeout(() => {
    expireGroups();
    maturePendingEarnings();
  }, 5000);
}

module.exports = { startScheduler, expireGroups, maturePendingEarnings };
