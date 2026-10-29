import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface Msg91SendOtpResponse {
  type: string;
  message: string;
}

/**
 * Sends a 6-digit OTP SMS via MSG91 Flow API.
 * Uses template: "Your login OTP for SERVFEX is ##OTP##. Do not share with anyone."
 *
 * @param mobile Normalized recipient mobile number with country code (e.g., "919876543210")
 * @param otp 6-digit numeric OTP code
 */
export async function sendOtpSms(mobile: string, otp: string): Promise<Msg91SendOtpResponse> {
  const authKey = env.MSG91_AUTH_KEY;
  if (!authKey) {
    logger.error('MSG91_AUTH_KEY is not configured in environment variables');
    throw new Error('SMS service is temporarily unconfigured. Please contact support.');
  }

  const templateId = env.MSG91_OTP_TEMPLATE_ID;

  try {
    const response = await axios.post<Msg91SendOtpResponse>(
      'https://control.msg91.com/api/v5/flow',
      {
        template_id: templateId,
        short_url: '0',
        recipients: [
          {
            mobiles: mobile,
            OTP: String(otp),
          },
        ],
      },
      {
        headers: {
          accept: 'application/json',
          authkey: authKey,
          'content-type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const data = response.data;
    if (data.type === 'error' || (typeof data.type === 'string' && data.type.toLowerCase() === 'error')) {
      logger.warn({ mobileMasked: maskMobile(mobile), msg91Message: data.message }, 'MSG91 returned error response');
      throw new Error(data.message || 'Failed to dispatch SMS through SMS provider');
    }

    logger.info({ mobileMasked: maskMobile(mobile) }, 'OTP SMS successfully dispatched via MSG91');
    return data;
  } catch (error: any) {
    if (error.response) {
      logger.error(
        {
          status: error.response.status,
          data: error.response.data,
          mobileMasked: maskMobile(mobile),
        },
        'MSG91 API error response'
      );
      const providerMsg = error.response.data?.message || 'Failed to send OTP via SMS';
      throw new Error(providerMsg);
    }

    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      logger.error({ mobileMasked: maskMobile(mobile) }, 'MSG91 request timed out after 15s');
      throw new Error('SMS provider connection timed out. Please try again.');
    }

    logger.error({ err: error.message, mobileMasked: maskMobile(mobile) }, 'Unexpected MSG91 error');
    throw error;
  }
}

/**
 * Sanitizes phone numbers for logging (e.g., "919876543210" -> "+91 ******3210").
 */
export function maskMobile(mobile: string): string {
  if (!mobile || mobile.length < 4) return '******';
  const last4 = mobile.slice(-4);
  return `+91 ******${last4}`;
}
