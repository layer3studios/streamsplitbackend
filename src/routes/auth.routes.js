const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const validate = require('../middleware/validate');
const { otpLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');
const User = require('../models/User');
const OtpRequest = require('../models/OtpRequest');
const Session = require('../models/Session');
const WalletAccount = require('../models/WalletAccount');
const BRAND = require('../../../brand.config');

const phoneSchema = Joi.object({ phone: Joi.string().pattern(/^\+?\d{10,15}$/).required() });
const verifySchema = Joi.object({ phone: Joi.string().required(), otp: Joi.string().length(BRAND.auth.otpLength).required() });

// POST /auth/otp/request
router.post('/otp/request', otpLimiter, validate(phoneSchema), async (req, res, next) => {
  try {
    const { phone } = req.body;
    // Rate limiting is handled by otpLimiter middleware (express-rate-limit)
    // which tracks per phone/IP with configurable window via BRAND.auth.otpRateLimitPerHour

    const otp = String(Math.floor(10 ** (BRAND.auth.otpLength - 1) + Math.random() * 9 * 10 ** (BRAND.auth.otpLength - 1)));
    const hashedOtp = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + BRAND.auth.otpExpiryMinutes * 60 * 1000);

    await OtpRequest.findOneAndUpdate(
      { phone },
      { hashedOtp, attempts: 0, expiresAt },
      { upsert: true, new: true }
    );

    // In dev mode, log OTP to console
    if (process.env.OTP_PROVIDER === 'console') {
      console.log(`📱 OTP for ${phone}: ${otp}`);
    }
    // TODO: integrate WhatsApp/SMS provider for production

    // Build response
    const response = { success: true, message: 'OTP sent successfully', retry_after: 30 };

    // DEV OTP: include OTP in response ONLY in dev mode
    const isDevOtp =
      process.env.NODE_ENV !== 'production' &&
      process.env.OTP_PROVIDER === 'console' &&
      process.env.DEV_SHOW_OTP === 'true';

    if (isDevOtp) {
      response.dev_otp = otp;
      response.testAccounts = [
        { name: 'Admin', phone: '+919999999999', role: 'super_admin' },
        { name: 'Test A', phone: '+919900000001', role: 'buyer' },
        { name: 'Test B', phone: '+919900000002', role: 'seller' },
        { name: 'Test C', phone: '+919900000003', role: 'both' },
        { name: 'Test D', phone: '+919900000004', role: 'both' },
        { name: 'Test E', phone: '+919900000005', role: 'both' },
      ];
    }

    // PRODUCTION GUARD: assert devOtp is never in production
    if (process.env.NODE_ENV === 'production' && response.dev_otp) {
      delete response.dev_otp;
      delete response.testAccounts;
      console.error('🚨 CRITICAL: dev_otp was about to leak in production — blocked');
    }

    res.json(response);
  } catch (err) { next(err); }
});

// POST /auth/otp/verify
router.post('/otp/verify', validate(verifySchema), async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    const otpDoc = await OtpRequest.findOne({ phone });

    if (!otpDoc) return res.status(400).json({ success: false, message: 'No OTP request found. Request a new OTP.' });
    if (otpDoc.expiresAt < new Date()) return res.status(400).json({ success: false, message: 'OTP expired' });
    if (otpDoc.attempts >= BRAND.auth.maxOtpAttempts) {
      await OtpRequest.deleteOne({ phone });
      return res.status(400).json({ success: false, message: 'Max attempts reached. Request a new OTP.' });
    }

    const isValid = await bcrypt.compare(otp, otpDoc.hashedOtp);
    if (!isValid) {
      await OtpRequest.updateOne({ phone }, { $inc: { attempts: 1 } });
      return res.status(400).json({ success: false, message: 'Invalid OTP', attemptsLeft: BRAND.auth.maxOtpAttempts - otpDoc.attempts - 1 });
    }

    // Create or find user
    let user = await User.findOne({ phone });
    let isNew = false;
    if (!user) {
      isNew = true;
      const referralCode = BRAND.slug.toUpperCase() + uuidv4().slice(0, 6).toUpperCase();
      user = await User.create({ phone, referralCode });
      // Create wallet for new user
      await WalletAccount.create({ userId: user._id });
    }
    user.lastLoginAt = new Date();
    await user.save();

    // Generate tokens
    const accessToken = jwt.sign(
      { sub: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: `${BRAND.auth.accessTokenExpiryMinutes}m`, issuer: BRAND.auth.jwtIssuer }
    );
    const refreshToken = uuidv4();
    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

    await Session.create({
      userId: user._id,
      refreshTokenHash,
      deviceInfo: { ip: req.ip },
      expiresAt: new Date(Date.now() + BRAND.auth.refreshTokenExpiryDays * 24 * 60 * 60 * 1000),
    });

    await OtpRequest.deleteOne({ phone });

    res.json({
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: { _id: user._id, phone: user.phone, name: user.name, role: user.role, avatarUrl: user.avatarUrl },
        isNew,
      },
    });
  } catch (err) { next(err); }
});

// POST /auth/token/refresh
router.post('/token/refresh', async (req, res, next) => {
  try {
    const refreshToken = req.body.refresh_token || req.body.refreshToken;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

    const sessions = await Session.find({ isRevoked: false, expiresAt: { $gt: new Date() } });
    let matchedSession = null;
    for (const s of sessions) {
      if (await bcrypt.compare(refreshToken, s.refreshTokenHash)) { matchedSession = s; break; }
    }
    if (!matchedSession) return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });

    const user = await User.findById(matchedSession.userId);
    if (!user || user.status !== 'active') return res.status(401).json({ success: false, message: 'User inactive' });

    const accessToken = jwt.sign(
      { sub: user._id, role: user.role },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: `${BRAND.auth.accessTokenExpiryMinutes}m`, issuer: BRAND.auth.jwtIssuer }
    );

    res.json({ success: true, data: { access_token: accessToken } });
  } catch (err) { next(err); }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    await Session.updateMany({ userId: req.user._id }, { isRevoked: true });
    res.json({ success: true, message: 'Logged out' });
  } catch (err) { next(err); }
});

module.exports = router;
