/**
 * StreamSplit — Complete Seed Script
 * Seeds ALL collections the frontend needs.
 * Usage:  node scripts/seed.js --reset
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { encryptText } = require('../src/utils/encryption');

const User = require('../src/models/User');
const WalletAccount = require('../src/models/WalletAccount');
const EarningsAccount = require('../src/models/EarningsAccount');
const Category = require('../src/models/Category');
const Brand = require('../src/models/Brand');
const Plan = require('../src/models/Plan');
const Group = require('../src/models/Group');
const GroupMembership = require('../src/models/GroupMembership');
const GroupInvite = require('../src/models/GroupInvite');
const Listing = require('../src/models/Listing');
const Order = require('../src/models/Order');
const EscrowTransaction = require('../src/models/EscrowTransaction');
const Dispute = require('../src/models/Dispute');
const Withdrawal = require('../src/models/WithdrawalRequest');
const Session = require('../src/models/Session');
const OtpRequest = require('../src/models/OtpRequest');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/subspace';
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const hoursFromNow = (n) => { const d = new Date(); d.setHours(d.getHours() + n); return d; };

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  if (process.argv.includes('--reset')) {
    console.log('🗑️  Resetting...');
    const cols = [User,WalletAccount,EarningsAccount,Category,Brand,Plan,Group,GroupMembership,GroupInvite,Listing,Order,EscrowTransaction,Dispute,Withdrawal,Session,OtpRequest];
    await Promise.all(cols.map(m => m.deleteMany({})));

    // Drop stale indexes on sessions that cause duplicate key errors
    try {
      await mongoose.connection.collection('sessions').dropIndexes();
      console.log('   Dropped all session indexes (will be recreated by Mongoose)');
    } catch (e) { /* collection may not exist yet */ }

    console.log('   Done.\n');
  }


  // ══════════════════════════════════════════════════════════
  //  USERS
  // ══════════════════════════════════════════════════════════
  const users = await User.insertMany([
    { phone:'+919999999999', name:'Admin Ashish', email:'admin@streamsplit.in', role:'super_admin', walletBalance:50000, kycStatus:'verified', sellerPlan:'pro', sellerListingCount:0, isVerified:true, isBanned:false, referralCode:'SSADMIN01' },
    { phone:'+919900000001', name:'Rahul Sharma', email:'rahul@test.com', role:'both', walletBalance:1247.50, kycStatus:'verified', sellerPlan:'pro', sellerListingCount:3, isVerified:true, referralCode:'SSRAHUL01' },
    { phone:'+919900000002', name:'Priya Patel', email:'priya@test.com', role:'both', walletBalance:892, kycStatus:'verified', sellerPlan:'free', sellerListingCount:2, isVerified:true, referralCode:'SSPRIYA01' },
    { phone:'+919900000003', name:'Amit Kumar', email:'amit@test.com', role:'buyer', walletBalance:350, kycStatus:'none', sellerPlan:'free', sellerListingCount:0, isVerified:true, referralCode:'SSAMIT001' },
    { phone:'+919900000004', name:'Sneha Reddy', email:'sneha@test.com', role:'both', walletBalance:0, kycStatus:'pending', sellerPlan:'free', sellerListingCount:1, isVerified:true, referralCode:'SSSNEHA1' },
    { phone:'+919900000005', name:'Vikram Singh', email:'vikram@test.com', role:'both', walletBalance:3200, kycStatus:'verified', sellerPlan:'pro', sellerListingCount:2, isVerified:true, referralCode:'SSVIKRM1' },
  ]);
  const [admin, rahul, priya, amit, sneha, vikram] = users;
  console.log(`👤 ${users.length} users`);

  // ══════════════════════════════════════════════════════════
  //  WALLETS + EARNINGS
  // ══════════════════════════════════════════════════════════
  await WalletAccount.insertMany(users.map(u => ({ userId: u._id, balance: u.walletBalance })));
  await EarningsAccount.insertMany([
    { user_id: rahul._id, withdrawable_balance: 450, pending_balance: 132, total_earned: 1820 },
    { user_id: priya._id, withdrawable_balance: 200, pending_balance: 44, total_earned: 680 },
    { user_id: vikram._id, withdrawable_balance: 800, pending_balance: 62, total_earned: 2400 },
    { user_id: sneha._id, withdrawable_balance: 0, pending_balance: 0, total_earned: 0 },
  ]);
  console.log('💰 Wallets + Earnings');

  // ══════════════════════════════════════════════════════════
  //  CATEGORIES (what the frontend Browse Categories shows)
  // ══════════════════════════════════════════════════════════
  const categories = await Category.insertMany([
    { name:'Streaming', slug:'streaming', color:'#E50914', sort_order:1 },
    { name:'Music', slug:'music', color:'#1DB954', sort_order:2 },
    { name:'Cloud & Storage', slug:'cloud-storage', color:'#4285F4', sort_order:3 },
    { name:'Gaming', slug:'gaming', color:'#9146FF', sort_order:4 },
    { name:'Productivity', slug:'productivity', color:'#FF6F00', sort_order:5 },
    { name:'VPN & Security', slug:'vpn-security', color:'#00C853', sort_order:6 },
    { name:'Education', slug:'education', color:'#2196F3', sort_order:7 },
    { name:'Gift Cards', slug:'gift-cards', color:'#FF9800', sort_order:8 },
  ]);
  const [catStream,catMusic,catCloud,catGaming,catProd,catVPN,catEdu,catGift] = categories;
  console.log(`📂 ${categories.length} categories`);

  // ══════════════════════════════════════════════════════════
  //  BRANDS (what the Explore page renders as cards)
  // ══════════════════════════════════════════════════════════
  const brands = await Brand.insertMany([
    { category_id:catStream._id, name:'Netflix', slug:'netflix', brand_color:'#E50914', description:'Stream movies and TV shows in 4K HDR', is_featured:true, tags:['streaming','4k','movies'] },
    { category_id:catStream._id, name:'Disney+ Hotstar', slug:'disney-hotstar', brand_color:'#113CCF', description:'Disney, Marvel, Star Wars & Hotstar Specials', is_featured:true, tags:['streaming','sports','disney'] },
    { category_id:catStream._id, name:'Amazon Prime Video', slug:'amazon-prime', brand_color:'#00A8E1', description:'Prime Video, Free delivery & more', tags:['streaming','shopping'] },
    { category_id:catStream._id, name:'YouTube Premium', slug:'youtube-premium', brand_color:'#FF0000', description:'Ad-free YouTube + YouTube Music', is_featured:true, tags:['youtube','music','streaming'] },
    { category_id:catMusic._id, name:'Spotify', slug:'spotify', brand_color:'#1DB954', description:'Music for everyone — 100M+ songs', is_featured:true, tags:['music','podcast'] },
    { category_id:catMusic._id, name:'Apple Music', slug:'apple-music', brand_color:'#FC3C44', description:'Listen to 100 million songs ad-free', tags:['music','apple'] },
    { category_id:catCloud._id, name:'Google One', slug:'google-one', brand_color:'#4285F4', description:'Extra Google storage + family sharing', tags:['cloud','google','storage'] },
    { category_id:catCloud._id, name:'iCloud+', slug:'icloud-plus', brand_color:'#3693F5', description:'Apple iCloud storage & privacy features', tags:['cloud','apple'] },
    { category_id:catGaming._id, name:'Xbox Game Pass', slug:'xbox-gamepass', brand_color:'#107C10', description:'Hundreds of games for one monthly price', tags:['gaming','xbox'] },
    { category_id:catGaming._id, name:'PlayStation Plus', slug:'ps-plus', brand_color:'#003087', description:'Online multiplayer & free monthly games', tags:['gaming','playstation'] },
    { category_id:catProd._id, name:'Microsoft 365', slug:'microsoft-365', brand_color:'#D83B01', description:'Word, Excel, PowerPoint + 1TB OneDrive', tags:['office','productivity'] },
    { category_id:catProd._id, name:'Canva Pro', slug:'canva-pro', brand_color:'#00C4CC', description:'Design anything — presentations, social, video', tags:['design','productivity'] },
    { category_id:catVPN._id, name:'NordVPN', slug:'nordvpn', brand_color:'#4687FF', description:'Online security with blazing-fast VPN', tags:['vpn','privacy'] },
    { category_id:catEdu._id, name:'Coursera Plus', slug:'coursera-plus', brand_color:'#0056D2', description:'Unlimited access to 7,000+ courses', tags:['learning','courses'] },
    { category_id:catGift._id, name:'Amazon Gift Card', slug:'amazon-gift-card', brand_color:'#FF9900', description:'Amazon.in gift cards at discounted prices', is_featured:true, tags:['gift-card','shopping'] },
    { category_id:catGift._id, name:'Flipkart Gift Card', slug:'flipkart-gift-card', brand_color:'#2874F0', description:'Flipkart gift vouchers — shop anything', tags:['gift-card','shopping'] },
  ]);
  console.log(`🏷️  ${brands.length} brands`);

  // ══════════════════════════════════════════════════════════
  //  PLANS (pricing tiers per brand)
  // ══════════════════════════════════════════════════════════
  const netflix = brands[0], disney = brands[1], prime = brands[2], yt = brands[3];
  const spotify = brands[4], apple = brands[5], google = brands[6];
  const xbox = brands[8], ms365 = brands[10], canva = brands[11], nord = brands[12];

  const plans = await Plan.insertMany([
    { brand_id:netflix._id, name:'Mobile', price:149, original_price:149, validity_days:30 },
    { brand_id:netflix._id, name:'Basic', price:199, original_price:199, validity_days:30 },
    { brand_id:netflix._id, name:'Standard', price:499, original_price:499, validity_days:30 },
    { brand_id:netflix._id, name:'Premium 4K', price:649, original_price:649, validity_days:30 },
    { brand_id:disney._id, name:'Mobile', price:149, original_price:149, validity_days:30 },
    { brand_id:disney._id, name:'Super', price:299, original_price:299, validity_days:30 },
    { brand_id:disney._id, name:'Premium', price:499, original_price:499, validity_days:30 },
    { brand_id:prime._id, name:'Monthly', price:299, original_price:299, validity_days:30 },
    { brand_id:prime._id, name:'Yearly', price:1499, original_price:1499, validity_days:365 },
    { brand_id:yt._id, name:'Individual', price:129, original_price:129, validity_days:30 },
    { brand_id:yt._id, name:'Family', price:189, original_price:189, validity_days:30 },
    { brand_id:spotify._id, name:'Individual', price:119, original_price:119, validity_days:30 },
    { brand_id:spotify._id, name:'Family (6)', price:179, original_price:179, validity_days:30 },
    { brand_id:google._id, name:'100 GB', price:130, original_price:130, validity_days:30 },
    { brand_id:google._id, name:'2 TB', price:650, original_price:650, validity_days:30 },
    { brand_id:xbox._id, name:'Core', price:349, original_price:499, validity_days:30 },
    { brand_id:xbox._id, name:'Ultimate', price:549, original_price:699, validity_days:30 },
    { brand_id:ms365._id, name:'Family (6 users)', price:489, original_price:489, validity_days:30 },
    { brand_id:canva._id, name:'Pro Monthly', price:499, original_price:499, validity_days:30 },
    { brand_id:nord._id, name:'2 Year', price:269, original_price:459, validity_days:730 },
  ]);
  console.log(`💳 ${plans.length} plans`);

  // ══════════════════════════════════════════════════════════
  //  GROUPS (what the homepage "Shared Subscriptions" shows)
  // ══════════════════════════════════════════════════════════
  const groupDocs = [];
  const groupData = [
    { name:'Netflix 4K Family', brand_id:netflix._id, owner:rahul, price:162, limit:4, members:3, status:'active' },
    { name:'Spotify Family Plan', brand_id:spotify._id, owner:rahul, price:30, limit:6, members:4, status:'active' },
    { name:'YouTube Premium Family', brand_id:yt._id, owner:priya, price:38, limit:5, members:2, status:'active' },
    { name:'Disney+ Super Share', brand_id:disney._id, owner:vikram, price:75, limit:4, members:4, status:'active' },
    { name:'Microsoft 365 Family', brand_id:ms365._id, owner:vikram, price:82, limit:6, members:3, status:'waiting' },
    { name:'NordVPN Group', brand_id:nord._id, owner:priya, price:45, limit:6, members:1, status:'waiting' },
    { name:'Xbox Game Pass Split', brand_id:xbox._id, owner:rahul, price:92, limit:5, members:2, status:'active' },
    { name:'Google One 2TB Family', brand_id:google._id, owner:sneha, price:108, limit:6, members:1, status:'waiting' },
  ];

  for (const g of groupData) {
    const group = await Group.create({
      name: g.name, brand_id: g.brand_id, created_by: g.owner._id,
      is_public: true, share_price: g.price, share_limit: g.limit,
      member_count: g.members, status: g.status,
      duration_days: 30, start_date: daysAgo(10), end_date: daysFromNow(20),
    });
    groupDocs.push(group);

    // Owner membership
    await GroupMembership.create({ group_id: group._id, user_id: g.owner._id, role: 'owner', status: 'active' });

    // Add some member memberships
    const possibleMembers = [amit, sneha, vikram, priya, rahul].filter(u => u._id.toString() !== g.owner._id.toString());
    for (let i = 0; i < Math.min(g.members - 1, possibleMembers.length); i++) {
      await GroupMembership.create({ group_id: group._id, user_id: possibleMembers[i]._id, role: 'member', status: 'active' });
    }

    // Create invite for each group
    await GroupInvite.create({ group_id: group._id, created_by: g.owner._id, created_by_role: 'owner', no_expiry: true });
  }
  console.log(`👥 ${groupDocs.length} groups + memberships + invites`);

  // Link plans to groups
  const netflixPlan4k = plans[3]; // Premium 4K
  const spotifyPlanFam = plans[12];
  const ytPlanFam = plans[10];
  await Plan.findByIdAndUpdate(netflixPlan4k._id, { group_id: groupDocs[0]._id });
  await Plan.findByIdAndUpdate(spotifyPlanFam._id, { group_id: groupDocs[1]._id });
  await Plan.findByIdAndUpdate(ytPlanFam._id, { group_id: groupDocs[2]._id });

  // ══════════════════════════════════════════════════════════
  //  LISTINGS (subscription + marketplace)
  // ══════════════════════════════════════════════════════════
  const listings = await Listing.insertMany([
    { sellerId:rahul._id, type:'subscription', listingSubType:'typeA', platform:'Netflix', totalSlots:4, filledSlots:2, pricePerSlot:199, duration:1, credentialsType:'email_password', deliveryMethod:'instant', description:'Netflix 4K Ultra HD', status:'active' },
    { sellerId:rahul._id, type:'subscription', listingSubType:'typeB', platform:'Spotify', totalSlots:6, filledSlots:3, pricePerSlot:33, subscriptionCost:119, duration:1, credentialsType:'family_link', deliveryMethod:'manual', description:'Spotify Family Plan', status:'active' },
    { sellerId:priya._id, type:'subscription', listingSubType:'typeA', platform:'YouTube Premium', totalSlots:5, filledSlots:1, pricePerSlot:50, duration:3, credentialsType:'family_link', deliveryMethod:'instant', description:'YouTube Premium Family', status:'active' },
    { sellerId:vikram._id, type:'subscription', listingSubType:'typeA', platform:'Disney+ Hotstar', totalSlots:4, filledSlots:4, pricePerSlot:75, duration:6, credentialsType:'email_password', deliveryMethod:'instant', description:'Disney+ Super plan', status:'completed' },
    { sellerId:rahul._id, type:'marketplace', platform:'Amazon', category:'gift_card', brand:'Amazon', faceValue:500, sellingPrice:450, quantity:5, deliveryMethod:'instant', inventoryCodes:[encryptText('AMZN-1111'),encryptText('AMZN-2222'),encryptText('AMZN-3333'),encryptText('AMZN-4444'),encryptText('AMZN-5555')], description:'₹500 Amazon Gift Card', status:'active' },
    { sellerId:priya._id, type:'marketplace', platform:'Flipkart', category:'gift_card', brand:'Flipkart', faceValue:1000, sellingPrice:920, quantity:2, deliveryMethod:'manual', deliveryTime:2, inventoryCodes:[], description:'₹1000 Flipkart voucher', status:'active' },
    { sellerId:vikram._id, type:'marketplace', platform:'Steam', category:'game_key', brand:'Steam', faceValue:1499, sellingPrice:999, quantity:3, deliveryMethod:'instant', inventoryCodes:[encryptText('STEAM-GTA5'),encryptText('STEAM-ELDEN'),encryptText('STEAM-CS2')], description:'Steam game keys 33% off', status:'active' },
    { sellerId:sneha._id, type:'marketplace', platform:'PUBG', category:'gaming_currency', brand:'PUBG', faceValue:600, sellingPrice:500, quantity:10, deliveryMethod:'manual', deliveryTime:1, inventoryCodes:[], description:'600 UC PUBG Mobile', status:'active' },
  ]);
  console.log(`📋 ${listings.length} listings`);

  // ══════════════════════════════════════════════════════════
  //  ORDERS
  // ══════════════════════════════════════════════════════════
  const orders = await Order.insertMany([
    { type:'subscription', buyerId:amit._id, sellerId:rahul._id, listingId:listings[0]._id, platform:'Netflix', amount:199, status:'active', paymentId:'pay_nf_001', pgOrderId:'order_nf_001', duration:30, escrowAmount:199, escrowReleased:66.33, escrowPending:132.67, releaseStartDate:daysAgo(10), releaseEndDate:daysFromNow(20), credentials:{email:'nf@test.com',password:'NfP123',profileName:'P2'} },
    { type:'subscription', buyerId:sneha._id, sellerId:rahul._id, listingId:listings[0]._id, platform:'Netflix', amount:199, status:'active', paymentId:'pay_nf_002', pgOrderId:'order_nf_002', duration:30, escrowAmount:199, escrowReleased:33.17, escrowPending:165.83, releaseStartDate:daysAgo(5), releaseEndDate:daysFromNow(25) },
    { type:'subscription', buyerId:amit._id, sellerId:priya._id, listingId:listings[2]._id, platform:'YouTube Premium', amount:50, status:'active', paymentId:'pay_yt_001', pgOrderId:'order_yt_001', duration:90, escrowAmount:50, escrowReleased:5.56, escrowPending:44.44, releaseStartDate:daysAgo(10), releaseEndDate:daysFromNow(80) },
    { type:'subscription', buyerId:vikram._id, sellerId:rahul._id, listingId:listings[1]._id, platform:'Spotify', amount:33, status:'completed', paymentId:'pay_sp_001', pgOrderId:'order_sp_001', duration:30, escrowAmount:33, escrowReleased:33, escrowPending:0, releaseStartDate:daysAgo(35), releaseEndDate:daysAgo(5) },
    { type:'subscription', buyerId:priya._id, sellerId:vikram._id, listingId:listings[3]._id, platform:'Disney+ Hotstar', amount:75, status:'disputed', paymentId:'pay_ds_001', pgOrderId:'order_ds_001', duration:180, escrowAmount:75, escrowReleased:12.50, escrowPending:62.50, releaseStartDate:daysAgo(30), releaseEndDate:daysFromNow(150) },
    { type:'marketplace', buyerId:amit._id, sellerId:rahul._id, listingId:listings[4]._id, platform:'Amazon', amount:450, status:'completed', paymentId:'pay_az_001', pgOrderId:'order_az_001', category:'gift_card', faceValue:500, deliveryMethod:'instant', deliveredCode:'AMZN-1111', deliveredAt:daysAgo(3) },
    { type:'marketplace', buyerId:sneha._id, sellerId:rahul._id, listingId:listings[4]._id, platform:'Amazon', amount:450, status:'delivered', paymentId:'pay_az_002', pgOrderId:'order_az_002', category:'gift_card', faceValue:500, deliveryMethod:'instant', deliveredCode:'AMZN-2222', deliveredAt:new Date(), confirmDeadline:hoursFromNow(24), autoReleaseAt:hoursFromNow(24) },
    { type:'marketplace', buyerId:vikram._id, sellerId:priya._id, listingId:listings[5]._id, platform:'Flipkart', amount:920, status:'pending_delivery', paymentId:'pay_fk_001', pgOrderId:'order_fk_001', category:'gift_card', faceValue:1000, deliveryMethod:'manual' },
    { type:'marketplace', buyerId:amit._id, sellerId:vikram._id, listingId:listings[6]._id, platform:'Steam', amount:999, status:'delivered', paymentId:'pay_st_001', pgOrderId:'order_st_001', category:'game_key', faceValue:1499, deliveryMethod:'instant', deliveredCode:'STEAM-GTA5', deliveredAt:daysAgo(1), confirmDeadline:hoursFromNow(12), autoReleaseAt:hoursFromNow(12) },
    { type:'marketplace', buyerId:priya._id, sellerId:sneha._id, listingId:listings[7]._id, platform:'PUBG', amount:500, status:'refunded', paymentId:'pay_pb_001', pgOrderId:'order_pb_001', category:'gaming_currency', faceValue:600, deliveryMethod:'manual' },
  ]);
  console.log(`🛒 ${orders.length} orders`);

  // ══════════════════════════════════════════════════════════
  //  ESCROW + DISPUTES + WITHDRAWALS
  // ══════════════════════════════════════════════════════════
  const escrowTxns = [];
  for (let i = 0; i < 10; i++) {
    const rd = new Date(daysAgo(10)); rd.setDate(rd.getDate()+i); rd.setHours(0,0,0,0);
    escrowTxns.push({ orderId:orders[0]._id, amountReleased:6.63, releaseDate:rd, sellerWalletBefore:1180+(i*6.63), sellerWalletAfter:1180+((i+1)*6.63), type:'daily_release' });
  }
  await EscrowTransaction.insertMany(escrowTxns);

  await Dispute.insertMany([
    { orderId:orders[4]._id, raisedBy:priya._id, issueType:'access_not_working', description:'Disney+ credentials stopped working.', status:'open' },
    { orderId:orders[9]._id, raisedBy:priya._id, issueType:'invalid_code', description:'PUBG UC code already redeemed.', status:'resolved', resolution:'refunded', adminId:admin._id, adminNote:'Auto-refund: invalid code.', resolvedAt:daysAgo(1) },
    { orderId:orders[0]._id, raisedBy:amit._id, issueType:'seller_not_responding', description:'Changed profile name, seller not responding.', status:'seller_responded', sellerResponse:'Restored. I was on vacation.' },
  ]);

  await Withdrawal.insertMany([
    { sellerId:rahul._id, amount:500, method:'upi', upiId:'rahul@paytm', status:'pending' },
    { sellerId:vikram._id, amount:1000, method:'bank', bankAccount:'9876543210', ifsc:'SBIN0001234', status:'completed', processedAt:daysAgo(3), transactionRef:'UTR2026051200001', adminId:admin._id },
    { sellerId:priya._id, amount:200, method:'upi', upiId:'priya@ybl', status:'failed', adminId:admin._id },
  ]);
  console.log('💸 Escrow + Disputes + Withdrawals');

  // ══════════════════════════════════════════════════════════
  //  DONE
  // ══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(55));
  console.log('🎉 SEED COMPLETE!');
  console.log('═'.repeat(55));
  console.log(`  👤 ${users.length} Users`);
  console.log(`  📂 ${categories.length} Categories`);
  console.log(`  🏷️  ${brands.length} Brands`);
  console.log(`  💳 ${plans.length} Plans`);
  console.log(`  👥 ${groupDocs.length} Groups (with memberships + invites)`);
  console.log(`  📋 ${listings.length} Listings`);
  console.log(`  🛒 ${orders.length} Orders`);
  console.log(`  💸 ${escrowTxns.length} Escrow Txns, 3 Disputes, 3 Withdrawals`);
  console.log('═'.repeat(55));
  console.log('\n📱 Test Accounts:');
  console.log('  Admin:  +919999999999');
  console.log('  Seller: +919900000001 (Rahul)');
  console.log('  Seller: +919900000002 (Priya)');
  console.log('  Buyer:  +919900000003 (Amit)');
  console.log('  Mixed:  +919900000004 (Sneha)');
  console.log('  Mixed:  +919900000005 (Vikram)');
  console.log('═'.repeat(55) + '\n');

  await mongoose.disconnect();
}

seed().catch(e => { console.error('❌', e.message); process.exit(1); });
