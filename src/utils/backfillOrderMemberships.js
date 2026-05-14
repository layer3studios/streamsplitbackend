/**
 * Backfill script: Creates group memberships for existing fulfilled orders
 * whose plans are linked to groups but the user never got a membership.
 *
 * Usage:  node src/utils/backfillOrderMemberships.js
 *
 * Idempotent — safe to run multiple times.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BRAND = require('../../brand.config');
const Order = require('../models/Order');
const Plan = require('../models/Plan');
const Group = require('../models/Group');
const GroupMembership = require('../models/GroupMembership');
const GroupTransaction = require('../models/GroupTransaction');
const EarningsAccount = require('../models/EarningsAccount');

async function backfill() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('🔗 Connected to MongoDB');

  const orders = await Order.find({ status: 'fulfilled' });
  console.log(`📦 Found ${orders.length} fulfilled orders`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const order of orders) {
    for (const item of order.items) {
      try {
        const plan = await Plan.findById(item.plan_id);
        if (!plan || !plan.group_id) continue;

        const group = await Group.findById(plan.group_id);
        if (!group || group.status === 'archived') continue;

        // Already a non-left member?
        const existing = await GroupMembership.findOne({
          group_id: group._id, user_id: order.user_id, status: { $ne: 'left' },
        });
        if (existing) { skipped++; continue; }

        // Skip if group is full
        if (group.member_count >= group.share_limit) {
          console.warn(`⚠️ Group ${group._id} full — cannot backfill user ${order.user_id}`);
          skipped++;
          continue;
        }

        // Create membership (backdate to order creation)
        await GroupMembership.create({
          group_id: group._id, user_id: order.user_id, role: 'member',
          status: 'active', joined_at: order.createdAt,
          paid_until: new Date(order.createdAt.getTime() + (group.duration_days || 30) * 86400000),
        });

        const updatedGroup = await Group.findByIdAndUpdate(
          group._id, { $inc: { member_count: 1 } }, { new: true }
        );
        if (updatedGroup.member_count >= updatedGroup.share_limit && updatedGroup.status === 'waiting') {
          updatedGroup.status = 'active';
          updatedGroup.start_date = new Date();
          updatedGroup.end_date = new Date(Date.now() + (updatedGroup.duration_days || 30) * 86400000);
          await updatedGroup.save();
          console.log(`✅ GROUP_ACTIVATED (backfill) | groupId=${group._id}`);
        }

        // Find owner via membership
        const ownerMem = await GroupMembership.findOne({ group_id: group._id, role: 'owner' });
        if (!ownerMem) {
          console.error(`❌ No owner for group ${group._id}`);
          continue;
        }

        // Earnings (idempotent)
        const idempotencyKey = `backfill_order_${order._id}_group_${group._id}_user_${order.user_id}`;
        const txExists = await GroupTransaction.findOne({
          group_id: group._id, buyer_id: order.user_id,
          razorpay_order_id: order.pg_order_id || idempotencyKey,
        });
        if (!txExists) {
          const gross = plan.price * (item.quantity || 1);
          const feePercent = BRAND.money.platformCutPercent;
          const feeAmount = Math.round(gross * feePercent / 100);
          const net = gross - feeAmount;

          await GroupTransaction.create({
            group_id: group._id, owner_id: ownerMem.user_id, buyer_id: order.user_id,
            gross, fee_percent: feePercent, fee_amount: feeAmount, net,
            razorpay_order_id: order.pg_order_id || idempotencyKey,
            razorpay_payment_id: order.pg_payment_id || `backfill_${order._id}`,
            status: 'paid',
          });

          await EarningsAccount.findOneAndUpdate(
            { user_id: ownerMem.user_id },
            { $inc: { withdrawable_balance: net, total_earned: net } },
            { upsert: true }
          );
        }

        created++;
        console.log(`✅ BACKFILLED | userId=${order.user_id} | groupId=${group._id} | orderId=${order._id}`);
      } catch (err) {
        errors++;
        console.error(`❌ Error backfilling item ${item.plan_id} in order ${order._id}:`, err.message);
      }
    }
  }

  console.log(`\n🏁 Backfill complete: ${created} created, ${skipped} skipped, ${errors} errors`);
  await mongoose.disconnect();
  process.exit(0);
}

backfill().catch((err) => {
  console.error('Fatal backfill error:', err);
  process.exit(1);
});
