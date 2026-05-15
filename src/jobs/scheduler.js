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

const Order = require('../models/Order');
const EscrowTransaction = require('../models/EscrowTransaction');
const User = require('../models/User');

// ─── Daily Escrow Release ──────────────────────────────────────
async function dailyEscrowRelease() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start of day for uniqueness

    const activeOrders = await Order.find({
      status: 'active',
      releaseStartDate: { $lte: new Date() }
    });

    let count = 0;
    for (const order of activeOrders) {
      const dailyAmount = Number((order.escrowAmount / order.duration).toFixed(2));

      // Check if already released today
      const alreadyReleasedToday = await EscrowTransaction.findOne({
        orderId: order._id,
        releaseDate: today
      });

      if (!alreadyReleasedToday && order.escrowPending > 0) {
        // Adjust final amount if pending is less than daily (last day)
        const amountToRelease = Math.min(dailyAmount, order.escrowPending);

        const seller = await User.findById(order.sellerId);
        if (!seller) continue;

        const walletBefore = seller.walletBalance || 0;
        const walletAfter = walletBefore + amountToRelease;

        await EscrowTransaction.create({
          orderId: order._id,
          amountReleased: amountToRelease,
          releaseDate: today,
          sellerWalletBefore: walletBefore,
          sellerWalletAfter: walletAfter,
          type: 'daily_release'
        });

        // Add to seller wallet
        seller.walletBalance = walletAfter;
        await seller.save();

        // Update order
        order.escrowReleased = Number((order.escrowReleased + amountToRelease).toFixed(2));
        order.escrowPending = Number((order.escrowPending - amountToRelease).toFixed(2));

        // Check if fully released
        if (order.escrowReleased >= order.escrowAmount || order.escrowPending <= 0) {
          order.status = 'completed';
          order.escrowPending = 0; // Fix floating point issues
        }
        await order.save();
        count++;
      }
    }
    if (count > 0) {
      console.log(`💰 CRON: Released escrow for ${count} orders today.`);
    }
  } catch (err) {
    console.error('❌ CRON dailyEscrowRelease error:', err.message);
  }
}

// ─── Auto-Confirm Marketplace Orders ──────────────────────────
async function autoConfirmMarketplaceOrders() {
  try {
    const now = new Date();
    const orders = await Order.find({
      type: 'marketplace',
      status: 'delivered',
      autoReleaseAt: { $lte: now }
    });

    let count = 0;
    for (const order of orders) {
      const seller = await User.findById(order.sellerId);
      if (seller) {
        seller.walletBalance = (seller.walletBalance || 0) + order.amount;
        await seller.save();
        
        order.status = 'completed';
        await order.save();
        count++;
      }
    }
    if (count > 0) {
      console.log(`🛒 CRON: Auto-confirmed ${count} marketplace orders.`);
    }
  } catch (err) {
    console.error('❌ CRON autoConfirmMarketplaceOrders error:', err.message);
  }
}

function startScheduler() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', () => {
    expireGroups();
    autoConfirmMarketplaceOrders();
  });

  // Run every 15 minutes
  cron.schedule('*/15 * * * *', maturePendingEarnings);

  // Run every night at 11:00 PM (23:00)
  cron.schedule('0 23 * * *', dailyEscrowRelease);

  console.log('📅 Cron scheduler started');

  // Run once on startup after a short delay
  setTimeout(() => {
    expireGroups();
    maturePendingEarnings();
    dailyEscrowRelease();
    autoConfirmMarketplaceOrders();
  }, 5000);
}

module.exports = { startScheduler, expireGroups, maturePendingEarnings, dailyEscrowRelease, autoConfirmMarketplaceOrders };
