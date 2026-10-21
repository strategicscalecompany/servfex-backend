import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';

// Lazy-initialized Nodemailer SMTP transporter
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    const smtpPass = env.SMTP_PASS || env.SMTP_PASSWORD || '';
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE, // true for port 465 (SSL/TLS)
      auth: {
        user: env.SMTP_USER,
        pass: smtpPass,
      },
      tls: {
        rejectUnauthorized: false, // Prevents self-signed or cert bundle issues
      },
    });
  }
  return transporter;
}

/**
 * Sends a clean, responsive HTML verification email with the 6-digit OTP.
 */
export async function sendOtpEmail(toEmail: string, otp: string): Promise<boolean> {
  const smtpPass = env.SMTP_PASS || env.SMTP_PASSWORD;

  // Always log OTP in server logs for seamless verification & debugging
  logger.info({ to: toEmail, otp }, 'ServFex Mail OTP Generated');

  // If password is not yet configured, provide development fallback
  if (!smtpPass || smtpPass === 'YOUR_HOSTINGER_EMAIL_PASSWORD') {
    logger.warn(
      { to: toEmail },
      'SMTP_PASS is not configured in .env. OTP logged to console. Update SMTP_PASS in .env to deliver real emails.'
    );
    return true;
  }

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ServFex Verification Code</title>
</head>
<body style="margin:0;padding:24px 0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" style="max-width:640px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);border:1px solid #e4e4e7;" border="0" cellspacing="0" cellpadding="0">
          
          <!-- Brand Header -->
          <tr>
            <td style="background:#09090b;padding:28px 36px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" style="vertical-align:middle;">
                    <div style="font-size:32px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1;">
                      Serv<span style="color:#ffffff;">Fex</span>
                    </div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:3px;color:#a1a1aa;margin-top:6px;line-height:1;">
                      MAKING LIFE EASIER
                    </div>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="border-left:1px solid #3f3f46;padding-left:18px;text-align:right;">
                          <div style="font-size:11px;font-weight:600;letter-spacing:2px;color:#a1a1aa;line-height:1.4;">
                            EVERY SERVICE.<br>ONE PLATFORM.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Body Content -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#71717a;margin-bottom:10px;text-transform:uppercase;">
                HELLO,
              </div>
              <h1 style="font-size:28px;font-weight:800;color:#09090b;margin:0 0 14px;line-height:1.2;">
                Your Verification Code
              </h1>
              <p style="font-size:15px;line-height:1.6;color:#52525b;margin:0 0 28px;">
                Use the one-time verification code below to sign in to or verify your ServFex account.
              </p>

              <!-- Dynamic OTP Box -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:24px 0;">
                <tr>
                  <td align="center" style="background:#f4f4f5;border-radius:12px;padding:28px 20px;">
                    <div style="font-size:12px;font-weight:700;letter-spacing:3px;color:#71717a;text-transform:uppercase;">
                      YOUR VERIFICATION CODE
                    </div>
                    <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#09090b;margin-top:14px;font-family:'Courier New',Courier,monospace;">
                      ${otp}
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Validity Notice -->
              <p style="text-align:center;font-size:14px;color:#52525b;margin:0 0 28px;">
                ⏱ Valid for <strong>10 minutes</strong>.
              </p>

              <!-- Security Notice -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:12px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="vertical-align:top;padding-right:12px;font-size:18px;line-height:1;">
                          🛡️
                        </td>
                        <td style="font-size:13px;line-height:1.6;color:#475569;">
                          <strong style="color:#0f172a;">Security Notice:</strong> Never share this code with anyone. ServFex will never ask you to disclose your OTP. If you did not request this code, please ignore this email.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #e4e4e7;padding:28px 36px;background:#fafafa;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" style="vertical-align:middle;padding-bottom:16px;">
                    <div style="font-size:22px;font-weight:800;color:#09090b;line-height:1;">ServFex</div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:2px;color:#71717a;margin-top:4px;">MAKING LIFE EASIER</div>
                  </td>
                  <td align="left" style="vertical-align:middle;padding:0 20px 16px;border-left:1px solid #e4e4e7;">
                    <div style="font-size:13px;font-weight:700;color:#09090b;">Need Help?</div>
                    <div style="font-size:12px;color:#71717a;margin-top:2px;">Contact us at <a href="mailto:support@servfex.com" style="color:#2563eb;text-decoration:none;">support@servfex.com</a></div>
                  </td>
                  <td align="right" style="vertical-align:middle;padding-bottom:16px;">
                    <div style="font-size:12px;color:#71717a;letter-spacing:1px;">
                      <a href="https://instagram.com" style="color:#71717a;text-decoration:none;margin-left:8px;" target="_blank">IG</a>
                      <a href="https://facebook.com" style="color:#71717a;text-decoration:none;margin-left:8px;" target="_blank">FB</a>
                      <a href="https://linkedin.com" style="color:#71717a;text-decoration:none;margin-left:8px;" target="_blank">IN</a>
                      <a href="https://youtube.com" style="color:#71717a;text-decoration:none;margin-left:8px;" target="_blank">YT</a>
                    </div>
                  </td>
                </tr>
              </table>
              <div style="border-top:1px solid #f0f0f0;padding-top:16px;font-size:12px;color:#a1a1aa;line-height:1.5;">
                &copy; 2026 ServFex. All rights reserved.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  try {
    const mailClient = getTransporter();
    const info = await mailClient.sendMail({
      from: env.SMTP_FROM,
      to: toEmail,
      subject: `${otp} is your ServFex verification code`,
      text: `Your ServFex one-time verification code is: ${otp}. It is valid for 10 minutes. Please do not share this code with anyone.`,
      html: htmlContent,
    });

    logger.info({ messageId: info.messageId, to: toEmail }, 'Hostinger SMTP OTP email sent successfully');
    return true;
  } catch (error: any) {
    logger.error({ err: error.message, to: toEmail }, 'Failed to deliver OTP email via Hostinger SMTP');
    // Return true in non-production so dev flow is not blocked, but rethrow in production if critical
    if (env.NODE_ENV !== 'production') {
      logger.warn('Non-production mode: continuing flow despite SMTP delivery issue.');
      return true;
    }
    throw error;
  }
}

// =========================================================================
// WELCOME EMAILS: PROVIDER, MANAGER & EXPERT ONBOARDING
// =========================================================================

export interface ProviderWelcomeEmailParams {
  toEmail: string;
  name: string;
  companyName: string;
  location: string;
  warehouseName?: string | null;
  warehouseLocation?: string | null;
  warehousePhone?: string | null;
  phone?: string | null;
  password?: string | null;
}

/**
 * Sends a welcome email to a newly added Home Service Provider (Vendor/Partner)
 * with Hub Location details, login credentials, and instructions to onboard Experts.
 */
export async function sendProviderWelcomeEmail(params: ProviderWelcomeEmailParams): Promise<boolean> {
  const { toEmail, name, companyName, location, warehouseName, warehouseLocation, warehousePhone, phone, password } = params;
  const smtpPass = env.SMTP_PASS || env.SMTP_PASSWORD;

  logger.info({ to: toEmail, companyName }, 'Sending ServFex Provider Welcome Email');

  const displayPassword = password || 'Provided during onboarding (or use Google Sign-In)';
  const displayHub = warehouseName || `${companyName} Fulfillment Hub`;
  const displayLocation = warehouseLocation || location || 'Main Operational Hub';
  const displayPhone = warehousePhone || phone || 'Registered Mobile';

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to the ServFex Family!</title>
</head>
<body style="margin:0;padding:24px 0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" style="max-width:640px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);border:1px solid #e4e4e7;" border="0" cellspacing="0" cellpadding="0">
          
          <!-- Brand Header -->
          <tr>
            <td style="background:#09090b;padding:28px 36px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" style="vertical-align:middle;">
                    <div style="font-size:32px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1;">
                      Serv<span style="color:#ffffff;">Fex</span>
                    </div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:3px;color:#a1a1aa;margin-top:6px;line-height:1;">
                      MAKING LIFE EASIER
                    </div>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;background:#27272a;color:#fafafa;font-size:10px;font-weight:700;letter-spacing:1.5px;padding:6px 12px;border-radius:20px;text-transform:uppercase;">
                      PROVIDER ONBOARDED
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#0284c7;margin-bottom:8px;text-transform:uppercase;">
                WELCOME TO THE SERVFEX FAMILY
              </div>
              <h1 style="font-size:26px;font-weight:800;color:#09090b;margin:0 0 14px;line-height:1.25;">
                Welcome, ${name}!
              </h1>
              <p style="font-size:15px;line-height:1.6;color:#52525b;margin:0 0 24px;">
                We are thrilled to welcome <strong>${companyName}</strong> into the ServFex Partner Network! Your Home Service Provider account has been established and activated on our centralized service marketplace.
              </p>

              <!-- Hub & Partner Details Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#475569;text-transform:uppercase;margin-bottom:12px;">
                      📍 YOUR PARTNER HUB & OPERATIONAL DETAILS
                    </div>
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:40%;">Company Name:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${companyName}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Primary Service Hub:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${location}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Hub / Fulfillment Center:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayHub} (${displayLocation})</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Registered Phone:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayPhone}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Action Notice: Onboard Experts -->
              <div style="background:#f0fdf4;border-radius:12px;border:1px solid #bbf7d0;padding:18px 22px;margin-bottom:24px;">
                <div style="font-size:13px;font-weight:800;color:#166534;margin-bottom:6px;">
                  🚀 You Can Now Onboard Your Team of Experts!
                </div>
                <p style="font-size:13px;line-height:1.6;color:#15803d;margin:0;">
                  As an authorized Service Provider, you can now add and manage your field technicians directly from your partner portal. Each technician you onboard will receive their designated login access and can immediately start accepting dispatched orders in your hub territory.
                </p>
              </div>

              <!-- Login Credentials Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#09090b;border-radius:12px;margin-bottom:28px;">
                <tr>
                  <td style="padding:22px 26px;color:#ffffff;">
                    <div style="font-size:11px;font-weight:800;letter-spacing:2px;color:#a1a1aa;text-transform:uppercase;margin-bottom:12px;">
                      🔐 YOUR SERVFEX LOGIN CREDENTIALS
                    </div>
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;width:35%;">Designated Portal:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#ffffff;">Home Service Provider Portal</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;">Email ID:</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:800;color:#38bdf8;font-family:'Courier New',Courier,monospace;">${toEmail}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;">Temporary Password:</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:800;color:#facc15;font-family:'Courier New',Courier,monospace;">${displayPassword}</td>
                      </tr>
                    </table>
                    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #27272a;font-size:12px;color:#a1a1aa;">
                      💡 You can log in using the <strong>ServFex Partner & Tech App</strong> or the Super Admin Portal. For security, update your password after initial sign-in.
                    </div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #e4e4e7;padding:24px 36px;background:#fafafa;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left">
                    <div style="font-size:18px;font-weight:800;color:#09090b;">ServFex</div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:2px;color:#71717a;margin-top:2px;">MAKING LIFE EASIER</div>
                  </td>
                  <td align="right" style="font-size:12px;color:#71717a;">
                    Questions? Reach us at <a href="mailto:support@servfex.com" style="color:#0284c7;text-decoration:none;">support@servfex.com</a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:11px;color:#a1a1aa;text-align:center;">
                &copy; 2026 ServFex Platform. Confidential and intended solely for the recipient.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  if (!smtpPass || smtpPass === 'YOUR_HOSTINGER_EMAIL_PASSWORD') {
    logger.warn({ to: toEmail, password: displayPassword }, 'SMTP_PASS not configured. Provider welcome email logged to console.');
    return true;
  }

  try {
    const mailClient = getTransporter();
    const info = await mailClient.sendMail({
      from: env.SMTP_FROM,
      to: toEmail,
      subject: `Welcome to the ServFex Family! Hub Details & Partner Credentials`,
      text: `Welcome to the ServFex Family, ${name}! Your Home Service Provider profile for ${companyName} has been established at ${location}. Login Email: ${toEmail}, Password: ${displayPassword}. You can now onboard your team of experts.`,
      html: htmlContent,
    });
    logger.info({ messageId: info.messageId, to: toEmail }, 'Provider welcome email sent successfully');
    return true;
  } catch (error: any) {
    logger.error({ err: error.message, to: toEmail }, 'Failed to deliver provider welcome email');
    if (env.NODE_ENV !== 'production') return true;
    throw error;
  }
}

export interface ManagerWelcomeEmailParams {
  toEmail: string;
  name: string;
  zone?: string | null;
  city?: string | null;
  phone?: string | null;
  shiftHours?: string | null;
  password?: string | null;
}

/**
 * Sends a welcome email to a newly added Operations or Territory Manager
 * with territory oversight details and login credentials.
 */
export async function sendManagerWelcomeEmail(params: ManagerWelcomeEmailParams): Promise<boolean> {
  const { toEmail, name, zone, city, phone, shiftHours, password } = params;
  const smtpPass = env.SMTP_PASS || env.SMTP_PASSWORD;

  logger.info({ to: toEmail, name }, 'Sending ServFex Manager Welcome Email');

  const displayPassword = password || 'Designated by Super Admin';
  const displayZone = zone || 'City Fulfillment Zone';
  const displayCity = city || 'Hyderabad Central Hub';
  const displayShift = shiftHours || '09:00 AM - 06:00 PM';

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to the ServFex Family - Manager Access</title>
</head>
<body style="margin:0;padding:24px 0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" style="max-width:640px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);border:1px solid #e4e4e7;" border="0" cellspacing="0" cellpadding="0">
          
          <!-- Brand Header -->
          <tr>
            <td style="background:#09090b;padding:28px 36px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" style="vertical-align:middle;">
                    <div style="font-size:32px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1;">
                      Serv<span style="color:#ffffff;">Fex</span>
                    </div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:3px;color:#a1a1aa;margin-top:6px;line-height:1;">
                      MAKING LIFE EASIER
                    </div>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;background:#3b82f6;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1.5px;padding:6px 12px;border-radius:20px;text-transform:uppercase;">
                      OPERATIONS MANAGER
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#2563eb;margin-bottom:8px;text-transform:uppercase;">
                WELCOME TO THE SERVFEX FAMILY
              </div>
              <h1 style="font-size:26px;font-weight:800;color:#09090b;margin:0 0 14px;line-height:1.25;">
                Welcome, ${name}!
              </h1>
              <p style="font-size:15px;line-height:1.6;color:#52525b;margin:0 0 24px;">
                You have been officially welcomed into the ServFex family as an authorized <strong>Operations & Territory Manager</strong>. Your managerial account has been provisioned with elevated administrative oversight.
              </p>

              <!-- Territory Details Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#475569;text-transform:uppercase;margin-bottom:12px;">
                      🏢 YOUR MANAGERIAL JURISDICTION & DETAILS
                    </div>
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:40%;">Designated Manager:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${name}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Territory / Zone:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayZone}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Metro City Hub:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayCity}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Operational Shift:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayShift}</td>
                      </tr>
                      ${phone ? `
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Direct Contact:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${phone}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Login Credentials Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#09090b;border-radius:12px;margin-bottom:28px;">
                <tr>
                  <td style="padding:22px 26px;color:#ffffff;">
                    <div style="font-size:11px;font-weight:800;letter-spacing:2px;color:#a1a1aa;text-transform:uppercase;margin-bottom:12px;">
                      🔐 YOUR MANAGER LOGIN CREDENTIALS
                    </div>
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;width:35%;">Designated Portal:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#ffffff;">Manager Portal (App & Web)</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;">Login Email:</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:800;color:#38bdf8;font-family:'Courier New',Courier,monospace;">${toEmail}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;">Manager Password:</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:800;color:#facc15;font-family:'Courier New',Courier,monospace;">${displayPassword}</td>
                      </tr>
                    </table>
                    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #27272a;font-size:12px;color:#a1a1aa;">
                      💡 Sign in to the <strong>Manager Portal</strong> in the ServFex app or the Super Admin Control Center to supervise regional fulfillments and partners.
                    </div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #e4e4e7;padding:24px 36px;background:#fafafa;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left">
                    <div style="font-size:18px;font-weight:800;color:#09090b;">ServFex</div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:2px;color:#71717a;margin-top:2px;">MAKING LIFE EASIER</div>
                  </td>
                  <td align="right" style="font-size:12px;color:#71717a;">
                    Super Admin Desk: <a href="mailto:admin@servfex.com" style="color:#2563eb;text-decoration:none;">admin@servfex.com</a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:11px;color:#a1a1aa;text-align:center;">
                &copy; 2026 ServFex Platform. Administrative Communication.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  if (!smtpPass || smtpPass === 'YOUR_HOSTINGER_EMAIL_PASSWORD') {
    logger.warn({ to: toEmail, password: displayPassword }, 'SMTP_PASS not configured. Manager welcome email logged to console.');
    return true;
  }

  try {
    const mailClient = getTransporter();
    const info = await mailClient.sendMail({
      from: env.SMTP_FROM,
      to: toEmail,
      subject: `Welcome to the ServFex Family! Your Manager Account & Access Credentials`,
      text: `Welcome to the ServFex Family, ${name}! You have been appointed as an Operations Manager for ${displayZone}, ${displayCity}. Login Email: ${toEmail}, Password: ${displayPassword}.`,
      html: htmlContent,
    });
    logger.info({ messageId: info.messageId, to: toEmail }, 'Manager welcome email sent successfully');
    return true;
  } catch (error: any) {
    logger.error({ err: error.message, to: toEmail }, 'Failed to deliver manager welcome email');
    if (env.NODE_ENV !== 'production') return true;
    throw error;
  }
}

export interface ExpertWelcomeEmailParams {
  toEmail: string;
  name: string;
  providerName: string;
  providerCompany: string;
  location?: string | null;
  specialization: string;
  phone?: string | null;
  password?: string | null;
}

/**
 * Sends a welcome email to a newly added Expert (Technician/Employee)
 * informing them which Provider added them, their hub location, and login credentials.
 */
export async function sendExpertWelcomeEmail(params: ExpertWelcomeEmailParams): Promise<boolean> {
  const { toEmail, name, providerName, providerCompany, location, specialization, phone, password } = params;
  const smtpPass = env.SMTP_PASS || env.SMTP_PASSWORD;

  const displayProvider = providerCompany || providerName || 'Your Service Provider';
  const displayLocation = location || 'Designated Service Region';
  const displayPassword = password || 'Provided by your Service Partner';

  logger.info({ to: toEmail, name, provider: displayProvider }, 'Sending ServFex Expert Welcome Email');

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to the ServFex Family - Expert Access</title>
</head>
<body style="margin:0;padding:24px 0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" style="padding:0 16px;">
        <table role="presentation" style="max-width:640px;width:100%;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);border:1px solid #e4e4e7;" border="0" cellspacing="0" cellpadding="0">
          
          <!-- Brand Header -->
          <tr>
            <td style="background:#09090b;padding:28px 36px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" style="vertical-align:middle;">
                    <div style="font-size:32px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1;">
                      Serv<span style="color:#ffffff;">Fex</span>
                    </div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:3px;color:#a1a1aa;margin-top:6px;line-height:1;">
                      MAKING LIFE EASIER
                    </div>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;background:#10b981;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1.5px;padding:6px 12px;border-radius:20px;text-transform:uppercase;">
                      EXPERT CERTIFIED
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#10b981;margin-bottom:8px;text-transform:uppercase;">
                WELCOME TO THE SERVFEX FAMILY
              </div>
              <h1 style="font-size:26px;font-weight:800;color:#09090b;margin:0 0 14px;line-height:1.25;">
                Hey ${name}!
              </h1>
              <p style="font-size:15px;line-height:1.6;color:#52525b;margin:0 0 24px;">
                You have been officially added into the ServFex family by <strong>${displayProvider}</strong> as a verified <strong>Home Service Expert</strong>!
              </p>

              <!-- Assignment Details Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#475569;text-transform:uppercase;margin-bottom:12px;">
                      🛠️ YOUR ASSIGNMENT & HUB LOCATION
                    </div>
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:40%;">Service Partner / Employer:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayProvider}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Specialization / Skill:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${specialization}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Hub Territory Location:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${displayLocation}</td>
                      </tr>
                      ${phone ? `
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;">Technician Mobile:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0f172a;">${phone}</td>
                      </tr>` : ''}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Step-by-step How to Work -->
              <div style="background:#f0fdf4;border-radius:12px;border:1px solid #bbf7d0;padding:18px 22px;margin-bottom:24px;">
                <div style="font-size:13px;font-weight:800;color:#166534;margin-bottom:8px;">
                  📱 How to Start Receiving Jobs:
                </div>
                <ol style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;color:#15803d;">
                  <li style="margin-bottom:4px;">Open the <strong>ServFex Partner & Tech App</strong> and tap <strong>"Home Service Expert"</strong>.</li>
                  <li style="margin-bottom:4px;">Log in using your designated email and password provided below.</li>
                  <li style="margin-bottom:4px;">When assigned a service, tap <strong>"Accept Service"</strong> to view turn-by-turn navigation to the customer.</li>
                  <li>Ask the customer for the 4-digit start OTP in their app, enter it to start work, and swipe to complete when finished!</li>
                </ol>
              </div>

              <!-- Login Credentials Card -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#09090b;border-radius:12px;margin-bottom:28px;">
                <tr>
                  <td style="padding:22px 26px;color:#ffffff;">
                    <div style="font-size:11px;font-weight:800;letter-spacing:2px;color:#a1a1aa;text-transform:uppercase;margin-bottom:12px;">
                      🔐 YOUR EXPERT LOGIN CREDENTIALS
                    </div>
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;width:35%;">Designated Portal:</td>
                        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#10b981;">Home Service Expert Portal</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;">Login Email:</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:800;color:#38bdf8;font-family:'Courier New',Courier,monospace;">${toEmail}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#a1a1aa;">Login Password:</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:800;color:#facc15;font-family:'Courier New',Courier,monospace;">${displayPassword}</td>
                      </tr>
                    </table>
                    <div style="margin-top:14px;padding-top:12px;border-top:1px solid #27272a;font-size:12px;color:#a1a1aa;">
                      💡 You can update your password at any time in the app settings under your profile.
                    </div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #e4e4e7;padding:24px 36px;background:#fafafa;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left">
                    <div style="font-size:18px;font-weight:800;color:#09090b;">ServFex</div>
                    <div style="font-size:10px;font-weight:600;letter-spacing:2px;color:#71717a;margin-top:2px;">MAKING LIFE EASIER</div>
                  </td>
                  <td align="right" style="font-size:12px;color:#71717a;">
                    Partner Support: <a href="mailto:support@servfex.com" style="color:#10b981;text-decoration:none;">support@servfex.com</a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:14px;font-size:11px;color:#a1a1aa;text-align:center;">
                &copy; 2026 ServFex Platform. Welcome to our field technician network!
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  if (!smtpPass || smtpPass === 'YOUR_HOSTINGER_EMAIL_PASSWORD') {
    logger.warn({ to: toEmail, password: displayPassword }, 'SMTP_PASS not configured. Expert welcome email logged to console.');
    return true;
  }

  try {
    const mailClient = getTransporter();
    const info = await mailClient.sendMail({
      from: env.SMTP_FROM,
      to: toEmail,
      subject: `Hey ${name}, you have been added to the ServFex family by ${displayProvider}!`,
      text: `Hey ${name}, welcome to the ServFex family! You have been added as an Expert by ${displayProvider} for location: ${displayLocation}. Log in to the ServFex app under Home Service Expert with Email: ${toEmail}, Password: ${displayPassword}.`,
      html: htmlContent,
    });
    logger.info({ messageId: info.messageId, to: toEmail }, 'Expert welcome email sent successfully');
    return true;
  } catch (error: any) {
    logger.error({ err: error.message, to: toEmail }, 'Failed to deliver expert welcome email');
    if (env.NODE_ENV !== 'production') return true;
    throw error;
  }
}

