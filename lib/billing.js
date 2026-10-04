'use strict';
// Plans: everything is free until BILLING_START_DATE (default: 2 months after first start).
// After that, accounts without an active paid plan fall back to the Free plan limits.
const crypto = require('node:crypto');
const DAY = 86_400_000;
const num = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; };
const CURRENCY = () => process.env.BILLING_CURRENCY || 'USD';

const PLANS = () => [
  { id: 'freelancer_pro', role: 'freelancer', name: 'Freelancer Pro', price: num(process.env.FREELANCER_PLAN_PRICE, 5), currency: CURRENCY(), period: 'month',
    features: ['Unlimited proposals every month', 'Send files, photos, videos and folders in chat', 'Priority support'] },
  { id: 'hirer_business', role: 'employer', name: 'Hirer Business', price: num(process.env.HIRER_PLAN_PRICE, 15), currency: CURRENCY(), period: 'month',
    features: ['Unlimited active job posts', 'Message every applicant', 'Send files, photos, videos and folders in chat'] }
];
const FREE_LIMITS = () => ({ proposalsPerMonth: num(process.env.FREE_PROPOSALS_PER_MONTH, 5), activeJobs: num(process.env.FREE_ACTIVE_JOBS, 1) });

function ensureStart(database, saveDatabase) {
  database.settings ||= {};
  if (!database.settings.billingStartsAt) { database.settings.billingStartsAt = Date.now() + 60 * DAY; saveDatabase(); }
}
function billingStart(database) {
  const fromEnv = Date.parse(process.env.BILLING_START_DATE || '');
  return Number.isNaN(fromEnv) ? database.settings?.billingStartsAt || Date.now() + 60 * DAY : fromEnv;
}
function usageOf(database, user) {
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  return {
    activeJobs: database.jobs.filter(job => job.ownerId === user.id && job.status === 'published').length,
    proposalsThisMonth: database.applications.filter(item => item.applicantId === user.id && Date.parse(item.submittedAt) >= monthStart.getTime()).length
  };
}
function status(database, user) {
  const now = Date.now(), start = billingStart(database), usage = usageOf(database, user), limits = FREE_LIMITS();
  if (user.role === 'admin') return { state: 'exempt', usage, limits };
  const startIso = new Date(start).toISOString();
  if (now < start) return { state: 'trial', daysLeft: Math.ceil((start - now) / DAY), billingStartsAt: startIso, usage, limits };
  const sub = user.subscription;
  if (sub && sub.expiresAt > now) {
    const plan = PLANS().find(item => item.id === sub.planId);
    return { state: 'active', planId: sub.planId, planName: plan?.name || 'Paid plan', expiresAt: new Date(sub.expiresAt).toISOString(), daysLeft: Math.ceil((sub.expiresAt - now) / DAY), usage, limits };
  }
  return { state: 'free', expired: Boolean(sub), billingStartsAt: startIso, usage, limits };
}
function checkLimit(database, user, kind) {
  const s = status(database, user);
  if (s.state !== 'free') return null;
  if (kind === 'job' && user.role === 'employer' && s.usage.activeJobs >= s.limits.activeJobs)
    return `The Free plan allows ${s.limits.activeJobs} active job. Upgrade to Hirer Business to post more.`;
  if (kind === 'proposal' && user.role === 'freelancer' && s.usage.proposalsThisMonth >= s.limits.proposalsPerMonth)
    return `The Free plan allows ${s.limits.proposalsPerMonth} proposals per month. Upgrade to Freelancer Pro to send more.`;
  return null;
}

async function handle(ctx) {
  const { method, pathname, request, send, user, database, saveDatabase, readJson, requireRole } = ctx;
  if (method === 'GET' && pathname === '/api/billing/plans')
    return send(200, { plans: PLANS(), freeLimits: FREE_LIMITS(), billingStartsAt: new Date(billingStart(database)).toISOString() });

  if (method === 'GET' && pathname === '/api/billing') {
    if (!user) return send(401, { error: 'Sign in to see your plan.' });
    return send(200, {
      status: status(database, user), plans: PLANS().filter(plan => plan.role === user.role), freeLimits: FREE_LIMITS(),
      instructions: process.env.PAYMENT_INSTRUCTIONS || 'Pay the amount to the account the site owner gave you, then enter your transaction reference below.',
      payments: database.payments.filter(item => item.userId === user.id).slice(-10).reverse()
    });
  }

  if (method === 'POST' && pathname === '/api/billing/payments') {
    if (!user) return send(401, { error: 'Sign in to subscribe.' });
    if (user.role === 'admin') return send(400, { error: 'Admin accounts do not need a plan.' });
    const body = await readJson(request, 10_000);
    const plan = PLANS().find(item => item.id === body.planId && item.role === user.role);
    const months = [1, 3, 6, 12].includes(Number(body.months)) ? Number(body.months) : 1;
    const reference = String(body.reference || '').trim();
    if (!plan) return send(400, { error: 'Choose a plan that matches your account type.' });
    if (!/^[A-Za-z0-9 _-]{4,40}$/.test(reference)) return send(400, { error: 'Enter the payment reference or transaction code (4 to 40 letters or numbers).' });
    if (database.payments.some(item => item.reference.toLowerCase() === reference.toLowerCase() && item.status !== 'rejected')) return send(409, { error: 'That reference has already been submitted.' });
    if (database.payments.filter(item => item.userId === user.id && item.status === 'pending').length >= 3) return send(429, { error: 'You already have pending payments. Please wait for the admin to confirm them.' });
    const payment = { id: crypto.randomUUID(), userId: user.id, userName: user.name, email: user.email, planId: plan.id, planName: plan.name, months, amount: plan.price * months, currency: plan.currency, reference, status: 'pending', createdAt: new Date().toISOString() };
    database.payments.push(payment); saveDatabase();
    return send(201, payment);
  }

  if (method === 'GET' && pathname === '/api/admin/payments') {
    if (!requireRole('admin')) return;
    return send(200, [...database.payments].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt)));
  }

  const decision = method === 'POST' && pathname.match(/^\/api\/admin\/payments\/([^/]+)\/(approve|reject)$/);
  if (decision) {
    if (!requireRole('admin')) return;
    const payment = database.payments.find(item => item.id === decision[1]);
    if (!payment) return send(404, { error: 'Payment not found.' });
    if (payment.status !== 'pending') return send(409, { error: 'That payment was already reviewed.' });
    payment.status = decision[2] === 'approve' ? 'approved' : 'rejected';
    payment.decidedAt = new Date().toISOString();
    if (payment.status === 'approved') {
      const owner = database.users.find(item => item.id === payment.userId);
      if (owner) {
        const base = Math.max(Date.now(), billingStart(database), owner.subscription?.planId === payment.planId ? owner.subscription.expiresAt : 0);
        owner.subscription = { planId: payment.planId, expiresAt: base + payment.months * 30 * DAY };
      }
    }
    saveDatabase();
    return send(200, payment);
  }
  return false;
}
module.exports = { handle, ensureStart, status, checkLimit };
