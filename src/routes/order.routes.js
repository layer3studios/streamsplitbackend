const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Razorpay = require('razorpay');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Plan = require('../models/Plan');
const Group = require('../models/Group');
const GroupMembership = require('../models/GroupMembership');
const GroupTransaction = require('../models/GroupTransaction');
const EarningsAccount = require('../models/EarningsAccount');
const WalletAccount = require('../models/WalletAccount');
const WalletTransaction = require('../models/WalletTransaction');
const Coupon = require('../models/Coupon');
const BRAND = require('../../../brand.config');
const { authenticate } = require('../middleware/auth');

// ─── Razorpay Instance ──────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const generateOrderNumber = () => {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `ORD-${date}-${uuidv4().slice(0, 6).toUpperCase()}`;
};

// ─── fulfillOrderMemberships — auto-join groups for plans with group_id ──
async function fulfillOrderMemberships(order) {
  for (const item of order.items) {
    try {
      const plan = await Plan.findById(item.plan_id);
      if (!plan || !plan.group_id) continue;

      const group = await Group.findById(plan.group_id);
      if (!group || group.status === 'archived') continue;

      // Idempotency: skip if user is already a non-left member
      const existingMem = await GroupMembership.findOne({
        group_id: group._id, user_id: order.user_id, status: { $ne: 'left' },
      });
      if (existingMem) {
        console.log(`⚡ Already member of group ${group._id} — skipping`);
        continue;
      }

      // Skip if group is full
      if (group.member_count >= group.share_limit) {
        console.warn(`⚠️ Group ${group._id} is full (${group.member_count}/${group.share_limit}) — cannot add member`);
        continue;
      }

      // Create membership
      await GroupMembership.create({
        group_id: group._id, user_id: order.user_id, role: 'member',
        status: 'active', joined_at: new Date(),
        paid_until: new Date(Date.now() + (group.duration_days || 30) * 86400000),
      });

      // Increment member count + activate if full
      const updatedGroup = await Group.findByIdAndUpdate(
        group._id, { $inc: { member_count: 1 } }, { new: true }
      );
      if (updatedGroup.member_count >= updatedGroup.share_limit && updatedGroup.status === 'waiting') {
        updatedGroup.status = 'active';
        updatedGroup.start_date = new Date();
        updatedGroup.end_date = new Date(Date.now() + (updatedGroup.duration_days || 30) * 86400000);
        await updatedGroup.save();
        console.log(`✅ GROUP_ACTIVATED | groupId=${group._id} | name=${group.name}`);
      }

      // Find group owner for earnings credit
      const ownerMem = await GroupMembership.findOne({ group_id: group._id, role: 'owner' });
      if (!ownerMem) {
        console.error(`❌ No owner found for group ${group._id}`);
        continue;
      }

      // Compute fee split
      const gross = plan.price * (item.quantity || 1);
      const feePercent = BRAND.money.platformCutPercent;
      const feeAmount = Math.round(gross * feePercent / 100);
      const net = gross - feeAmount;
      const holdHours = BRAND.money.withdrawalHoldHours || 0;
      const pendingReleaseAt = holdHours > 0 ? new Date(Date.now() + holdHours * 3600000) : null;

      // Idempotent: skip if GroupTransaction already exists for this order+group+user
      const idempotencyKey = `order_${order._id}_group_${group._id}_user_${order.user_id}`;
      const existingTx = await GroupTransaction.findOne({
        group_id: group._id, buyer_id: order.user_id,
        razorpay_order_id: order.pg_order_id || idempotencyKey,
      });

      if (!existingTx) {
        await GroupTransaction.create({
          group_id: group._id, owner_id: ownerMem.user_id, buyer_id: order.user_id,
          gross, fee_percent: feePercent, fee_amount: feeAmount, net,
          razorpay_order_id: order.pg_order_id || idempotencyKey,
          razorpay_payment_id: order.pg_payment_id || `wallet_order_${order._id}`,
          pending_release_at: pendingReleaseAt, status: 'paid',
        });

        // Credit owner earnings
        const earningsInc = holdHours > 0
          ? { pending_balance: net, total_earned: net }
          : { withdrawable_balance: net, total_earned: net };
        await EarningsAccount.findOneAndUpdate(
          { user_id: ownerMem.user_id }, { $inc: earningsInc }, { upsert: true }
        );
        console.log(`💰 EARNINGS_CREDITED | ownerId=${ownerMem.user_id} | gross=${gross} | net=${net} | group=${group.name}`);
      }

      console.log(`✅ GROUP_JOIN_VIA_ORDER | userId=${order.user_id} | groupId=${group._id} | orderId=${order._id}`);
    } catch (err) {
      // Log but don't throw — don't fail the whole order if one group join fails
      console.error(`❌ fulfillOrderMemberships error for item ${item.plan_id}:`, err.message);
    }
  }
}

// ─── GET /orders — user order history ────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const orders = await Order.find({ user_id: req.user._id })
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    const total = await Order.countDocuments({ user_id: req.user._id });
    res.json({ success: true, data: orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── POST /orders/checkout — Wallet or Razorpay ─────────────────
router.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ user_id: req.user._id, status: 'active' });
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty' });
    }

    const payment_method = req.body.payment_method || 'razorpay';
    const idempotency_key = req.body.idempotency_key || uuidv4();

    // Idempotency — prevent double-processing
    const existingOrder = await Order.findOne({ idempotency_key });
    if (existingOrder) {
      return res.json({ success: true, data: { order: existingOrder, message: 'Order already exists (idempotent)' } });
    }

    // Increment coupon usage
    if (cart.coupon_code) {
      await Coupon.updateOne({ code: cart.coupon_code }, { $inc: { used_count: 1 } });
    }

    const orderData = {
      order_number: generateOrderNumber(),
      user_id: req.user._id,
      items: cart.items.map(i => ({
        plan_id: i.plan_id,
        plan_snapshot: i.plan_snapshot,
        quantity: i.quantity,
        unit_price: i.plan_snapshot.price,
      })),
      coupon_code: cart.coupon_code,
      subtotal: cart.subtotal,
      discount: cart.discount,
      total: cart.total,
      payment_method,
      idempotency_key,
    };

    if (payment_method === 'wallet') {
      // ─── Wallet Checkout ───────────────────────────────
      const wallet = await WalletAccount.findOne({ user_id: req.user._id });
      if (!wallet) {
        return res.status(400).json({ success: false, message: 'Wallet not found' });
      }
      if (wallet.balance < cart.total) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. You have ${BRAND.formatPrice(wallet.balance)} but need ${BRAND.formatPrice(cart.total)}`,
        });
      }

      // Atomic debit with balance guard
      const updated = await WalletAccount.findOneAndUpdate(
        { _id: wallet._id, balance: { $gte: cart.total } },
        { $inc: { balance: -cart.total } },
        { new: true }
      );
      if (!updated) {
        return res.status(400).json({ success: false, message: 'Wallet debit failed — balance may have changed' });
      }

      await WalletTransaction.create({
        wallet_id: wallet._id, type: 'debit', amount: cart.total,
        balance_after: updated.balance, source: 'purchase',
        description: `Payment for order ${orderData.order_number}`,
        reference_type: 'Order', idempotency_key: `wal-${idempotency_key}`,
      });

      orderData.status = 'fulfilled';
      const order = await Order.create(orderData);

      // Auto-join groups for plans linked to groups
      await fulfillOrderMemberships(order);

      cart.status = 'checked_out';
      await cart.save();

      res.json({ success: true, data: { order, payment_status: 'completed' } });

    } else {
      // ─── Razorpay Checkout ─────────────────────────────
      // 1) Create our pending order first
      orderData.status = 'pending';
      const order = await Order.create(orderData);

      // 2) Create Razorpay order (amount in paise)
      const rpOrder = await razorpay.orders.create({
        amount: Math.round(cart.total * 100),
        currency: BRAND.currency.code,
        receipt: order.order_number,
        notes: {
          order_id: order._id.toString(),
          user_id: req.user._id.toString(),
        },
      });

      // 3) Store Razorpay order ID on our order
      order.pg_order_id = rpOrder.id;
      await order.save();

      // Don't mark cart as checked_out yet — wait for payment verification

      res.json({
        success: true,
        data: {
          order,
          payment_status: 'pending',
          razorpay: {
            order_id: rpOrder.id,
            amount: rpOrder.amount,
            currency: rpOrder.currency,
            key_id: process.env.RAZORPAY_KEY_ID,
          },
        },
      });
    }
  } catch (err) { next(err); }
});

// ─── POST /orders/verify-payment — Razorpay signature check ────
router.post('/verify-payment', authenticate, async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment verification fields' });
    }

    // 1) Verify signature using HMAC SHA256
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment verification failed — invalid signature' });
    }

    // 2) Find and update our order
    const order = await Order.findOne({ pg_order_id: razorpay_order_id, user_id: req.user._id });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.status === 'fulfilled') {
      return res.json({ success: true, data: { order, message: 'Already verified' } });
    }

    // 3) Mark order as fulfilled
    order.status = 'fulfilled';
    order.pg_payment_id = razorpay_payment_id;

    await order.save();

    // 4) Auto-join groups for plans linked to groups
    await fulfillOrderMemberships(order);

    // 5) Mark cart as checked out
    await Cart.findOneAndUpdate(
      { user_id: req.user._id, status: 'active' },
      { status: 'checked_out' }
    );

    res.json({ success: true, data: { order, payment_status: 'completed' } });
  } catch (err) { next(err); }
});

// ─── GET /orders/:id — single order detail ──────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user_id: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, data: order });
  } catch (err) { next(err); }
});

module.exports = router;
