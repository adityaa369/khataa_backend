const he = require('he');

const brandGreen = '#059669';
const brandDark = '#064e3b';

function baseTemplate(content) {
    return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .wrapper { max-width: 560px; margin: 32px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .header { background: ${brandGreen}; padding: 24px 32px; text-align: center; }
  .header h1 { color: white; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header p { color: rgba(255,255,255,0.85); margin: 4px 0 0; font-size: 13px; }
  .body { padding: 32px; }
  .body p { color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
  .card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
  .card .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #d1fae5; }
  .card .row:last-child { border-bottom: none; }
  .card .label { color: #6b7280; font-size: 13px; }
  .card .value { color: #111827; font-size: 13px; font-weight: 600; }
  .btn { display: inline-block; background: ${brandGreen}; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600; margin: 8px 0; }
  .footer { background: #f9fafb; padding: 20px 32px; text-align: center; border-top: 1px solid #e5e7eb; }
  .footer p { color: #9ca3af; font-size: 12px; margin: 0; line-height: 1.5; }
  .amount-big { font-size: 28px; font-weight: 800; color: ${brandDark}; margin: 8px 0; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>Khatha</h1>
    <p>Your Trusted Credit Companion</p>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    <p>This is an automated notification from Khatha.<br>
    If you did not perform this action, contact support immediately.<br>
    &copy; ${new Date().getFullYear()} Khatha. All rights reserved.</p>
  </div>
</div>
</body>
</html>`;
}

function emailVerificationTemplate(name, verifyUrl) {
    const safeName = he.encode(name || 'there');
    return baseTemplate(`
        <p>Hello <strong>${safeName}</strong>,</p>
        <p>Welcome to Khatha! Please verify your email address to complete your registration and unlock all features.</p>
        <p style="text-align:center; margin: 24px 0;">
            <a href="${verifyUrl}" class="btn">Verify Email Address</a>
        </p>
        <p style="color:#6b7280; font-size:13px;">This link expires in <strong>24 hours</strong>. If you did not register on Khatha, you can ignore this email.</p>
    `);
}

function loanGivenTemplate({ lenderName, borrowerName, amount, loanType, duration, interestRate, startDate }) {
    const safe = (v) => he.encode(String(v || ''));
    const formattedAmount = Number(amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
    return baseTemplate(`
        <p>Hello <strong>${safe(borrowerName)}</strong>,</p>
        <p>A new credit agreement has been created and activated. Here are the details:</p>
        <div class="card">
          <div class="row"><span class="label">Lender</span><span class="value">${safe(lenderName)}</span></div>
          <div class="row"><span class="label">Credit Type</span><span class="value">${safe(loanType)}</span></div>
          <div class="row"><span class="label">Principal Amount</span><span class="value">${formattedAmount}</span></div>
          <div class="row"><span class="label">Interest Rate</span><span class="value">${safe(interestRate)}% p.m.</span></div>
          <div class="row"><span class="label">Duration</span><span class="value">${safe(duration)} months</span></div>
          <div class="row"><span class="label">Start Date</span><span class="value">${safe(startDate)}</span></div>
        </div>
        <p>This email serves as your official proof of credit agreement. Please keep it for your records.</p>
    `);
}

function paymentRecordedTemplate({ borrowerName, lenderName, amountPaid, remainingBalance, paymentDate, loanId }) {
    const safe = (v) => he.encode(String(v || ''));
    const fmtAmount = (n) => Number(n).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
    return baseTemplate(`
        <p>Hello <strong>${safe(borrowerName)}</strong>,</p>
        <p>A payment has been recorded on your credit agreement by your lender <strong>${safe(lenderName)}</strong>.</p>
        <div class="card">
          <div class="row"><span class="label">Amount Paid</span><span class="value" style="color:#059669">${fmtAmount(amountPaid)}</span></div>
          <div class="row"><span class="label">Remaining Balance</span><span class="value" style="color:#dc2626">${fmtAmount(remainingBalance)}</span></div>
          <div class="row"><span class="label">Payment Date</span><span class="value">${safe(paymentDate)}</span></div>
          <div class="row"><span class="label">Agreement ID</span><span class="value" style="font-size:11px">${safe(loanId)}</span></div>
        </div>
        <p>If you did not make this payment or believe this is incorrect, please contact your lender immediately.</p>
    `);
}

function loanClosedTemplate({ borrowerName, lenderName, amount, closedDate, loanId }) {
    const safe = (v) => he.encode(String(v || ''));
    const formattedAmount = Number(amount).toLocaleString('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
    return baseTemplate(`
        <p>Hello <strong>${safe(borrowerName)}</strong>,</p>
        <p>Your credit agreement with <strong>${safe(lenderName)}</strong> has been <strong style="color:#059669">successfully closed</strong>.</p>
        <div class="card">
          <div class="row"><span class="label">Original Amount</span><span class="value">${formattedAmount}</span></div>
          <div class="row"><span class="label">Closed On</span><span class="value">${safe(closedDate)}</span></div>
          <div class="row"><span class="label">Agreement ID</span><span class="value" style="font-size:11px">${safe(loanId)}</span></div>
          <div class="row"><span class="label">Status</span><span class="value" style="color:#059669">✓ Closed</span></div>
        </div>
        <p>Thank you for using Khatha. This email is your official proof of agreement closure. Please keep it for your records.</p>
    `);
}

module.exports = { emailVerificationTemplate, loanGivenTemplate, paymentRecordedTemplate, loanClosedTemplate };
