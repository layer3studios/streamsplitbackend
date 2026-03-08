const router = require('express').Router();
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Group = require('../models/Group');
const GroupMembership = require('../models/GroupMembership');
const GroupInvite = require('../models/GroupInvite');
const GroupTransaction = require('../models/GroupTransaction');
const EarningsAccount = require('../models/EarningsAccount');
const JoinIntent = require('../models/JoinIntent');
const BRAND = require('../../../brand.config');
const { authenticate, optionalAuth } = require('../middleware/auth');

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
} else {
    console.error('❌ RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing — paid joins will fail');
}

// ─── Helper: validate invite ──────────────────────────────────
async function resolveInviteByCode(code) {
    const normalized = (code || '').trim().toUpperCase();
    if (!normalized) return { error: 'MISSING_CODE', status: 400 };

    let invite = await GroupInvite.findOne({ code: new RegExp(`^${normalized}$`, 'i') });

    // Fallback: if no GroupInvite exists, check Group.invite_code (legacy groups)
    if (!invite) {
        const group = await Group.findOne({ invite_code: new RegExp(`^${normalized}$`, 'i') })
            .populate('brand_id', 'name slug logo_url')
            .populate('created_by', 'name');
        if (!group) return { error: 'NOT_FOUND', status: 404 };
        if (group.status === 'archived' || group.status === 'expired') {
            return { error: 'GROUP_CLOSED', status: 410 };
        }
        // Auto-create the missing GroupInvite for this legacy group
        invite = await GroupInvite.create({
            group_id: group._id,
            created_by: group.created_by._id || group.created_by,
            created_by_role: 'owner',
            code: group.invite_code,
            status: 'active',
            no_expiry: true,
        });
        return { invite, group };
    }
    if (invite.status !== 'active') return { error: 'DISABLED', status: 410 };
    if (invite.expires_at && new Date() > invite.expires_at) return { error: 'EXPIRED', status: 410 };
    if (invite.max_uses && invite.uses_count >= invite.max_uses) return { error: 'MAX_USES', status: 410 };

    const group = await Group.findById(invite.group_id)
        .populate('brand_id', 'name slug logo_url')
        .populate('created_by', 'name');
    if (!group) return { error: 'GROUP_NOT_FOUND', status: 404 };
    if (group.status === 'archived' || group.status === 'expired') {
        return { error: 'GROUP_CLOSED', status: 410 };
    }

    return { invite, group };
}

// ─── GET /invite/:code — Resolve invite (public) ─────────────
router.get('/:code', optionalAuth, async (req, res, next) => {
    try {
        const result = await resolveInviteByCode(req.params.code);
        if (result.error) {
            const msg = result.error === 'NOT_FOUND' ? 'Invalid invite code'
                : result.error === 'EXPIRED' ? 'Invite has expired — ask for a new link'
                    : result.error === 'MAX_USES' ? 'Invite has reached its usage limit'
                        : result.error === 'DISABLED' ? 'Invite is no longer active'
                            : 'Invalid invite';
            return res.status(result.status).json({ success: false, error: result.error, message: msg });
        }

        const { group, invite } = result;
        const seatsLeft = Math.max(0, (group.share_limit || 5) - (group.member_count || 0));

        res.json({
            success: true,
            data: {
                _id: group._id,
                name: group.name,
                description: group.description,
                brand_id: group.brand_id,
                share_price: group.share_price,
                share_limit: group.share_limit,
                member_count: group.member_count,
                max_members: group.share_limit,
                seats_left: seatsLeft,
                owner: group.created_by ? { name: group.created_by.name } : null,
                invite_code: invite.code,
                expires_at: invite.expires_at,
            },
        });
    } catch (err) { next(err); }
});

// ─── POST /invite/:code/join/initiate — Start join payment ───
router.post('/:code/join/initiate', authenticate, async (req, res, next) => {
    try {
        const result = await resolveInviteByCode(req.params.code);
        if (result.error) {
            return res.status(result.status).json({ success: false, error: result.error, message: 'Invite is invalid or expired' });
        }

        const { group, invite } = result;

        // Check not already member
        const existing = await GroupMembership.findOne({
            group_id: group._id, user_id: req.user._id, status: { $ne: 'left' },
        });
        if (existing) return res.status(409).json({ success: false, error: 'ALREADY_MEMBER', message: 'You are already a member of this group' });

        // Check seats
        const seatsLeft = (group.share_limit || 5) - (group.member_count || 0);
        if (seatsLeft <= 0) return res.status(409).json({ success: false, error: 'GROUP_FULL', message: 'No seats available' });

        // Check no pending intent
        const pendingIntent = await JoinIntent.findOne({ user_id: req.user._id, group_id: group._id, status: 'initiated' });
        if (pendingIntent) {
            return res.json({
                success: true,
                data: {
                    joinIntentId: pendingIntent._id,
                    amount: pendingIntent.amount,
                    currency: pendingIntent.currency,
                    payment_method: pendingIntent.payment_method,
                    razorpay_order_id: pendingIntent.razorpay_order_id,
                    razorpay_key_id: process.env.RAZORPAY_KEY_ID || null,
                },
            });
        }

        const amount = group.share_price || 0;
        const paymentMethod = req.body.payment_method || 'razorpay';
        const intentData = {
            invite_code: invite.code,
            group_id: group._id,
            user_id: req.user._id,
            amount,
            currency: 'INR',
            payment_method: paymentMethod,
        };

        // Free group — join immediately
        if (amount === 0) {
            intentData.status = 'paid';
            const intent = await JoinIntent.create(intentData);
            await joinAndCreditEarnings(group, req.user._id, invite, intent);
            console.log(`📋 JOIN_INTENT_CREATED (free) | intentId=${intent._id} | groupId=${group._id} | amount=0`);
            return res.json({ success: true, data: { joinIntentId: intent._id, joined: true, group_id: group._id }, message: 'Joined successfully (free group)' });
        }

        // Wallet payment
        if (paymentMethod === 'wallet') {
            const WalletAccount = require('../models/WalletAccount');
            const WalletTransaction = require('../models/WalletTransaction');
            const wallet = await WalletAccount.findOne({ user_id: req.user._id });
            if (!wallet || wallet.balance < amount) {
                return res.status(402).json({ success: false, error: 'INSUFFICIENT_FUNDS', message: 'Not enough wallet balance' });
            }
            wallet.balance -= amount;
            await wallet.save();
            // Record wallet debit
            await WalletTransaction.create({
                wallet_id: wallet._id, type: 'debit', amount,
                balance_after: wallet.balance, source: 'purchase',
                description: `Seat purchase for group "${group.name}"`,
            });
            intentData.status = 'paid';
            intentData.razorpay_payment_id = `wallet_${Date.now()}`;
            const intent = await JoinIntent.create(intentData);
            await joinAndCreditEarnings(group, req.user._id, invite, intent);
            console.log(`📋 JOIN_INTENT_CREATED (wallet) | intentId=${intent._id} | groupId=${group._id} | amount=${amount}`);
            return res.json({ success: true, data: { joinIntentId: intent._id, joined: true, group_id: group._id }, message: 'Joined successfully (wallet)' });
        }

        // Razorpay
        if (!razorpay) {
            return res.status(500).json({ success: false, message: 'Payment gateway not configured' });
        }
        const order = await razorpay.orders.create({
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: `join_${group._id}_${req.user._id}`.substring(0, 40),
        });
        intentData.payment_method = 'razorpay';
        intentData.razorpay_order_id = order.id;
        const intent = await JoinIntent.create(intentData);

        console.log(`📋 JOIN_INTENT_CREATED (razorpay) | intentId=${intent._id} | orderId=${order.id} | gross=${amount}`);

        return res.json({
            success: true,
            data: {
                joinIntentId: intent._id,
                amount: order.amount,
                currency: order.currency,
                razorpay_order_id: order.id,
                razorpay_key_id: process.env.RAZORPAY_KEY_ID,
            },
        });
    } catch (err) { next(err); }
});

// ─── Helper: join group + credit owner earnings ───────────────
async function joinAndCreditEarnings(group, userId, invite, intent) {
    // Double check not already member
    const existing = await GroupMembership.findOne({ group_id: group._id, user_id: userId, status: { $ne: 'left' } });
    if (existing) return;

    await GroupMembership.create({
        group_id: group._id,
        user_id: userId,
        role: 'member',
        status: 'active',
    });

    const updated = await Group.findByIdAndUpdate(group._id, { $inc: { member_count: 1 } }, { new: true });

    // If group is now full, activate it
    if (updated && updated.member_count >= updated.share_limit && updated.status === 'waiting') {
        updated.status = 'active';
        updated.start_date = new Date();
        updated.end_date = new Date(Date.now() + (updated.duration_days || 30) * 24 * 60 * 60 * 1000);
        await updated.save();
    }

    // Increment invite uses
    await GroupInvite.findByIdAndUpdate(invite._id, { $inc: { uses_count: 1 } });

    // Credit owner earnings (skip if amount = 0)
    if (intent.amount > 0) {
        const ownerMembership = await GroupMembership.findOne({ group_id: group._id, role: 'owner' });
        if (!ownerMembership) {
            console.error(`❌ No owner found for group ${group._id} — cannot credit earnings`);
            return;
        }

        const gross = intent.amount;
        const feePercent = BRAND.money.platformCutPercent;
        const feeAmount = Math.round(gross * feePercent / 100);
        const net = gross - feeAmount;
        const holdHours = BRAND.money.withdrawalHoldHours || 0;
        const pendingReleaseAt = holdHours > 0 ? new Date(Date.now() + holdHours * 3600000) : null;

        // Idempotent: check if GroupTransaction already exists
        const existingTx = await GroupTransaction.findOne({ razorpay_payment_id: intent.razorpay_payment_id });
        if (!existingTx) {
            await GroupTransaction.create({
                group_id: group._id,
                owner_id: ownerMembership.user_id,
                buyer_id: userId,
                gross, fee_percent: feePercent, fee_amount: feeAmount, net,
                razorpay_order_id: intent.razorpay_order_id,
                razorpay_payment_id: intent.razorpay_payment_id,
                pending_release_at: pendingReleaseAt,
                status: 'paid',
            });

            const earningsInc = holdHours > 0
                ? { pending_balance: net, total_earned: net }
                : { withdrawable_balance: net, total_earned: net };
            const earningsAfter = await EarningsAccount.findOneAndUpdate(
                { user_id: ownerMembership.user_id },
                { $inc: earningsInc },
                { upsert: true, new: true }
            );

            console.log(`💰 EARNINGS_CREDITED | ownerId=${ownerMembership.user_id} | gross=${gross} | fee=${feeAmount} (${feePercent}%) | net=${net} | withdrawable=${earningsAfter.withdrawable_balance} | pending=${earningsAfter.pending_balance || 0}`);
        }
    }
}

module.exports = router;
