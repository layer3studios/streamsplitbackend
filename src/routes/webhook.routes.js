const router = require('express').Router();
const crypto = require('crypto');
const Order = require('../models/Order');
const Listing = require('../models/Listing');
const { decryptText } = require('../utils/encryption');

router.post('/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(200).json({ status: 'ok' });

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const signature = req.headers['x-razorpay-signature'];
    const expectedSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    if (signature !== expectedSig) return res.status(400).json({ status: 'invalid_signature' });

    const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
    const event = body.event;

    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = body.payload.payment?.entity;
      const orderId = payment?.order_id || body.payload.order?.entity?.id;
      const paymentId = payment?.id;

      const order = await Order.findOne({ pgOrderId: orderId });
      if (order && order.status === 'pending') {
        const listing = await Listing.findById(order.listingId);
        if (!listing) return res.status(200).json({ status: 'listing_not_found' });

        order.paymentId = paymentId;

        if (order.type === 'subscription') {
          order.status = 'active';
          order.releaseStartDate = new Date();
          const endDate = new Date();
          endDate.setDate(endDate.getDate() + order.duration);
          order.releaseEndDate = endDate;
          
          listing.filledSlots += 1;
          await listing.save();

          if (listing.deliveryMethod === 'manual') {
            setTimeout(async () => {
              try {
                const checkOrder = await Order.findById(order._id);
                if (checkOrder && checkOrder.status === 'active' && !checkOrder.credentials?.email && !checkOrder.credentials?.password) {
                  checkOrder.status = 'refunded';
                  await checkOrder.save();
                  // Restore slot on refund
                  await Listing.findByIdAndUpdate(order.listingId, { $inc: { filledSlots: -1 } });
                  console.log(`[Order ${order._id}] Seller didn't deliver subscription creds in 1hr. Auto-refunded, slot restored.`);
                }
              } catch (e) { console.error('Subscription timeout check error', e); }
            }, 60 * 60 * 1000); // 1 hr
          }
        } 
        else if (order.type === 'marketplace') {
          const now = new Date();
          
          if (listing.deliveryMethod === 'instant') {
            // Pop an encrypted code
            if (listing.inventoryCodes && listing.inventoryCodes.length > 0) {
              const encCode = listing.inventoryCodes.shift(); // take one
              listing.quantity -= 1;
              if (listing.quantity <= 0) listing.status = 'completed'; // Auto-mark sold out
              await listing.save();
              
              order.deliveredCode = decryptText(encCode);
              order.status = 'delivered';
              order.deliveredAt = now;
              
              const deadline = new Date(now);
              deadline.setHours(deadline.getHours() + 24);
              order.confirmDeadline = deadline;
              order.autoReleaseAt = deadline;
            } else {
              // Out of stock edge case even if checked at checkout
              order.status = 'refunded'; 
            }
          } else {
            // Manual delivery
            order.status = 'pending_delivery';
            listing.quantity -= 1;
            await listing.save();

            const timeLimitHours = listing.deliveryTime || 2;
            setTimeout(async () => {
              try {
                const checkOrder = await Order.findById(order._id);
                if (checkOrder && checkOrder.status === 'pending_delivery') {
                  checkOrder.status = 'refunded';
                  await checkOrder.save();
                  // Restore quantity on refund
                  await Listing.findByIdAndUpdate(order.listingId, { $inc: { quantity: 1 } });
                  console.log(`[Order ${order._id}] Seller didn't deliver marketplace item in ${timeLimitHours}hr. Auto-refunded, qty restored.`);
                }
              } catch (e) { console.error('Marketplace timeout check error', e); }
            }, timeLimitHours * 60 * 60 * 1000);
          }
        }
        await order.save();
      }
    }
    
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('❌ WEBHOOK ERROR:', err.message);
    res.status(200).json({ status: 'error' });
  }
});

// ─── Edge Case 1: Manual payment verify when webhook fails ───
router.post('/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment fields' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    const expectedSig = crypto.createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    const order = await Order.findOne({ pgOrderId: razorpay_order_id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    
    if (order.status !== 'pending') {
      return res.json({ success: true, message: 'Order already processed', data: { orderId: order._id, status: order.status } });
    }

    // Trigger the same logic as webhook by setting paymentId and re-saving
    order.paymentId = razorpay_payment_id;
    const listing = await Listing.findById(order.listingId);

    if (order.type === 'subscription') {
      order.status = 'active';
      order.releaseStartDate = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + order.duration);
      order.releaseEndDate = endDate;
      if (listing) {
        listing.filledSlots += 1;
        await listing.save();
      }
    } else if (order.type === 'marketplace') {
      const now = new Date();
      if (listing && listing.deliveryMethod === 'instant' && listing.inventoryCodes?.length > 0) {
        const encCode = listing.inventoryCodes.shift();
        listing.quantity -= 1;
        if (listing.quantity <= 0) listing.status = 'completed';
        await listing.save();
        order.deliveredCode = decryptText(encCode);
        order.status = 'delivered';
        order.deliveredAt = now;
        const deadline = new Date(now);
        deadline.setHours(deadline.getHours() + 24);
        order.confirmDeadline = deadline;
        order.autoReleaseAt = deadline;
      } else {
        order.status = 'pending_delivery';
        if (listing) {
          listing.quantity -= 1;
          await listing.save();
        }
      }
    }

    await order.save();
    res.json({ success: true, message: 'Payment verified and order activated', data: order });
  } catch (err) {
    console.error('❌ VERIFY-PAYMENT ERROR:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
