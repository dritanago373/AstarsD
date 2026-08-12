const nodemailer = require('nodemailer');

// Create transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Send verification email
const sendVerificationEmail = async (to, code, businessName) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #007AFF; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f5f5f5; padding: 30px; border-radius: 0 0 10px 10px; }
        .code { font-size: 36px; font-weight: bold; color: #007AFF; text-align: center; padding: 20px; background: white; border-radius: 10px; margin: 20px 0; letter-spacing: 8px; }
        .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🌍 Balkan AI Reply</h1>
      </div>
      <div class="content">
        <h2>Hello ${businessName || 'there'}! 👋</h2>
        <p>Thank you for signing up! Please verify your email address.</p>
        <div class="code">${code}</div>
        <p>This code expires in <strong>5 minutes</strong>.</p>
        <p>If you didn't request this, please ignore this email.</p>
      </div>
      <div class="footer">
        <p>© 2024 Balkan AI Reply. All rights reserved.</p>
      </div>
    </body>
    </html>
  `;

  await transporter.sendMail({
    from: `"Balkan AI Reply" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Verify Your Email - Balkan AI Reply',
    html,
  });
};

module.exports = { sendVerificationEmail };