const nodemailer = require('nodemailer');

/**
 * Send email using Nodemailer SMTP transport, with a fallback to console logging
 * if credentials are not configured.
 * 
 * @param {Object} options - Email sending options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Text body
 * @param {string} options.html - HTML body
 */
const sendEmail = async ({ to, subject, text, html }) => {
    const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
    const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp.gmail.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);

    console.log(`[Email] Preparing to send email to: ${to}`);
    console.log(`[Email] Subject: ${subject}`);
    console.log(`[Email] Configuration: host=${smtpHost}, port=${smtpPort}, user=${smtpUser ? 'SET' : 'NOT SET'}`);

    if (!smtpUser || !smtpPass) {
        console.warn('================================================================');
        console.warn('[Email Warning] SMTP credentials (SMTP_USER/EMAIL_USER and SMTP_PASS/EMAIL_PASS) are not set.');
        console.warn('[Email Warning] SIMULATED EMAIL CONTENT:');
        console.warn(`To: ${to}`);
        console.warn(`Subject: ${subject}`);
        console.warn(`Text:\n${text}`);
        if (html) {
            console.warn(`HTML:\n${html}`);
        }
        console.warn('================================================================');
        return { success: true, simulated: true };
    }

    try {
        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465, // true for 465, false for other ports
            auth: {
                user: smtpUser,
                pass: smtpPass,
            },
        });

        const mailOptions = {
            from: `"Khatha App" <${smtpUser}>`,
            to,
            subject,
            text,
            html,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Message sent successfully! MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('[Email Error] Failed to send email via SMTP:', error.message);
        // Fallback to logging so server doesn't crash
        console.warn('================================================================');
        console.warn('[Email Fallback] Email dispatch failed. Logging details below:');
        console.warn(`To: ${to}`);
        console.warn(`Subject: ${subject}`);
        console.warn(`Text:\n${text}`);
        console.warn('================================================================');
        return { success: false, error: error.message };
    }
};

module.exports = { sendEmail };
