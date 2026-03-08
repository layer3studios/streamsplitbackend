const router = require('express').Router();
const crypto = require('crypto');
const Group = require('../models/Group');
const GroupMembership = require('../models/GroupMembership');
const GroupTransaction = require('../models/GroupTransaction');
const GroupInvite = require('../models/GroupInvite');
const JoinIntent = require('../models/JoinIntent');
const EarningsAccount = require('../models/EarningsAccount');
const BRAND = require('../../../brand.config');

// ─── Helper: credit owner earnings respecting hold ────────────
async function creditOwnerEarnings(ownerId, net) {
    const holdHours = BRAND.money.withdrawalHoldHours || 0;
    const earningsInc = holdHours > 0
        ? { pending_balance: net, total_earned: net }
        : { withdrawable_balance: net, total_earned: net };
    const updated = await EarningsAccount.findOneAndUpdate(
        { user_id: ownerId },
        { $inc: earningsInc },
        { upsert: true, new: true }
    );
    return updated;
}

// ─── Helper: finalize join (membership + earnings + GroupTransaction) ──
async function finalizeJoin(intent) {
    const group = await Group.findById(intent.group_id);
    if (!group) throw new Error('Group not found for intent ' + intent._id);

    // Find owner
    const ownerMembership = await GroupMembership.findOne({ group_id: group._id, role: 'owner' });
    if (!ownerMembership) throw new Error('Group has no owner');

    // Add membership (idempotent)
    const existingMembership = await GroupMembership.findOne({
        group_id: group._id, user_id: intent.user_id, status: { $ne: 'left' },
    });
    let membershipCreated = false;
    if (!existingMembership) {
        await GroupMembership.create({
            group_id: group._id, user_id: intent.user_id, role: 'member', status: 'active',
        });
        membershipCreated = true;

        // Increment member count + activate if full
        const updated = await Group.findByIdAndUpdate(
            group._id, { $inc: { member_count: 1 } }, { new: true }
        );
        if (updated && updated.member_count >= updated.share_limit && updated.status === 'waiting') {
            updated.status = 'active';
            updated.start_date = new Date();
            updated.end_date = new Date(Date.now() + (updated.duration_days || 30) * 86400000);
            await updated.save();
        }
    }

    // Compute fee from config
    const gross = intent.amount;
    const feePercent = BRAND.money.platformCutPercent;
    const feeAmount = Math.round(gross * feePercent / 100);
    const net = gross - feeAmount;
    const holdHours = BRAND.money.withdrawalHoldHours || 0;
    const pendingReleaseAt = holdHours > 0 ? new Date(Date.now() + holdHours * 3600000) : null;

    // Create GroupTransaction (idempotent: check if already exists for this payment)
    let tx = await GroupTransaction.findOne({ razorpay_payment_id: intent.razorpay_payment_id });
    if (!tx) {
        tx = await GroupTransaction.create({
            group_id: group._id,
            owner_id: ownerMembership.user_id,
            buyer_id: intent.user_id,
            gross, fee_percent: feePercent, fee_amount: feeAmount, net,
            razorpay_order_id: intent.razorpay_order_id,
            razorpay_payment_id: intent.razorpay_payment_id,
            pending_release_at: pendingReleaseAt,
            status: 'paid',
        });

        // Credit owner earnings (only if we just created the GroupTransaction)
        const earningsAfter = await creditOwnerEarnings(ownerMembership.user_id, net);

        console.log(`💰 EARNINGS_CREDITED | ownerId=${ownerMembership.user_id} | gross=${gross} | fee=${feeAmount} (${feePercent}%) | net=${net} | withdrawable=${earningsAfter.withdrawable_balance} | pending=${earningsAfter.pending_balance || 0}`);
    } else {
        console.log(`⚠️ GroupTransaction already exists for payment ${intent.razorpay_payment_id} — skipping credit (idempotent)`);
    }

    // Increment invite uses (idempotent-ish: ok if counted twice)
    if (membershipCreated && intent.invite_code) {
        await GroupInvite.findOneAndUpdate(
            { code: new RegExp(`^${intent.invite_code}$`, 'i'), status: 'active' },
            { $inc: { uses_count: 1 } }
        );
    }

    return { tx, membershipCreated, gross, feeAmount, net };
}

// ─── POST /payments/razorpay/webhook ─────────────────────────
router.post('/razorpay/webhook', async (req, res) => {
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!secret) {
            console.warn('⚠️ RAZORPAY_WEBHOOK_SECRET not set — skipping webhook');
            return res.status(200).json({ status: 'ok' });
        }

        // Verify signature
        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        const signature = req.headers['x-razorpay-signature'];
        const expectedSig = crypto
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');

        if (signature !== expectedSig) {
            console.error('❌ WEBHOOK_SIGNATURE_MISMATCH');
            return res.status(400).json({ status: 'invalid_signature' });
        }

        const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : (typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
        const event = body.event;
        const payload = body.payload;

        console.log(`📩 WEBHOOK_RECEIVED | event=${event}`);

        if (event === 'payment.captured' || event === 'order.paid') {
            const payment = payload.payment?.entity;
            const orderId = payment?.order_id || payload.order?.entity?.id;
            const paymentId = payment?.id;

            if (!orderId || !paymentId) {
                console.warn('⚠️ Webhook missing order_id or payment_id');
                return res.status(200).json({ status: 'missing_ids' });
            }

            console.log(`🔍 WEBHOOK_VERIFIED | orderId=${orderId} | paymentId=${paymentId}`);

            // ─── Try JoinIntent first (invite-based join) ────────
            const intent = await JoinIntent.findOne({ razorpay_order_id: orderId });
            if (intent) {
                // Idempotency: already paid?
                if (intent.status === 'paid') {
                    console.log(`⚡ JoinIntent already paid for order ${orderId} — idempotent skip`);
                    return res.status(200).json({ status: 'already_processed' });
                }

                // Mark paid
                intent.status = 'paid';
                intent.razorpay_payment_id = paymentId;
                await intent.save();

                // Finalize: membership + GroupTransaction + earnings credit
                const result = await finalizeJoin(intent);
                console.log(`✅ JOIN_FINALIZED | intentId=${intent._id} | orderId=${orderId} | paymentId=${paymentId} | membership=${result.membershipCreated} | net=${result.net}`);

                return res.status(200).json({ status: 'ok' });
            }

            console.warn(`⚠️ No JoinIntent found for order ${orderId} — direct join flow is deprecated`);
            return res.status(200).json({ status: 'no_matching_record' });
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        console.error('❌ WEBHOOK_ERROR:', err.message, err.stack);
        res.status(200).json({ status: 'error' }); // Always 200 to prevent retries
    }
});

// ─── POST /payments/verify-join — Frontend-initiated verification ──
router.post('/verify-join', async (req, res, next) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Missing payment fields' });
        }

        // Verify signature
        const expectedSig = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');
        if (expectedSig !== razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Invalid payment signature' });
        }

        console.log(`🔐 VERIFY_JOIN | orderId=${razorpay_order_id} | paymentId=${razorpay_payment_id}`);

        // ─── Try JoinIntent first ────────────────────────────
        const intent = await JoinIntent.findOne({ razorpay_order_id });
        if (intent) {
            if (intent.status === 'paid') {
                // Already processed (probably by webhook)
                return res.json({ success: true, data: { group_id: intent.group_id, joinIntentId: intent._id, message: 'Already verified' } });
            }

            intent.status = 'paid';
            intent.razorpay_payment_id = razorpay_payment_id;
            await intent.save();

            const result = await finalizeJoin(intent);
            console.log(`✅ VERIFY_JOIN_FINALIZED | intentId=${intent._id} | net=${result.net}`);

            return res.json({
                success: true,
                data: { group_id: intent.group_id, joinIntentId: intent._id, message: 'Payment verified, membership created' },
            });
        }

        console.warn(`⚠️ No JoinIntent found for order ${razorpay_order_id} — direct join flow is deprecated`);
        return res.status(404).json({ success: false, message: 'No matching record found' });
    } catch (err) { next(err); }
});

module.exports = router;
