const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const pino = require('pino');

// Set development fallback for SMTP to avoid external network timeouts during unit testing
process.env.SMTP_PASS = 'YOUR_HOSTINGER_EMAIL_PASSWORD';

// Load compiled production modules from dist/
const { logger } = require(path.join(__dirname, '..', 'dist', 'src', 'config', 'logger.js'));
const { sendOtpEmail } = require(path.join(__dirname, '..', 'dist', 'src', 'services', 'email.service.js'));
const { generateAndSendEmailOtp, verifyEmailOtp } = require(path.join(__dirname, '..', 'dist', 'src', 'services', 'otp.service.js'));

// Helper to reliably capture logger serialized output via Pino's stream symbol
function captureLoggerOutput(fn) {
  const chunks = [];
  const origStream = logger[pino.symbols.streamSym];
  logger[pino.symbols.streamSym] = {
    write: (chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    },
  };

  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.finally(() => {
        logger[pino.symbols.streamSym] = origStream;
      }).then(val => ({ result: val, output: chunks.join('') }));
    }
    logger[pino.symbols.streamSym] = origStream;
    return { result: res, output: chunks.join('') };
  } catch (err) {
    logger[pino.symbols.streamSym] = origStream;
    throw err;
  }
}

function parseJsonLogs(rawOutput) {
  return rawOutput
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'))
    .map(JSON.parse);
}

test('Scenario 1: Calling sendOtpEmail logs safe metadata without exposing the raw OTP', async () => {
  const syntheticEmail = 'f05.scenario1@servfex.test';
  const syntheticOtp = '748291';

  const { result, output } = await captureLoggerOutput(async () => {
    return await sendOtpEmail(syntheticEmail, syntheticOtp);
  });

  // Verify email sending function executes cleanly
  assert.strictEqual(result, true, 'sendOtpEmail should return true');

  // Verify the raw OTP code is NOT present anywhere in the emitted log stream
  assert.strictEqual(
    output.includes(syntheticOtp),
    false,
    `Raw OTP ${syntheticOtp} must NEVER appear in logger output`
  );

  // Parse structured metadata
  const lines = parseJsonLogs(output);
  const otpLog = lines.find(l => l.msg === 'ServFex Mail OTP Generated');
  assert.ok(otpLog, 'Should emit "ServFex Mail OTP Generated" log entry');
  assert.strictEqual(otpLog.to, syntheticEmail, 'Should log recipient email');
  assert.strictEqual(otpLog.otpLength, 6, 'Should log length of OTP instead of value');
  assert.strictEqual(otpLog.otp, undefined, 'Property "otp" must not be present');
});

test('Scenario 2: Logger output does not contain any test OTP supplied to the email service', async () => {
  const testCodes = ['102938', '592014', '840192'];

  for (let i = 0; i < testCodes.length; i++) {
    const code = testCodes[i];
    const { output } = await captureLoggerOutput(async () => {
      await sendOtpEmail(`f05.account.${i}@servfex.test`, code);
    });

    assert.strictEqual(
      output.includes(code),
      false,
      `Code ${code} was found in emitted logger output`
    );
  }
});

test('Scenario 3: The central logger redacts top-level otp fields', () => {
  const sensitiveOtp = '839104';

  const { output } = captureLoggerOutput(() => {
    logger.info({ otp: sensitiveOtp, action: 'VERIFICATION_ATTEMPT' }, 'Testing top-level OTP logging');
  });

  assert.strictEqual(output.includes(sensitiveOtp), false, 'Top-level OTP must be redacted/removed');
  const lines = parseJsonLogs(output);
  const parsed = lines.find(l => l.msg === 'Testing top-level OTP logging');
  assert.ok(parsed, 'Log entry should be present in captured output');
  assert.strictEqual(parsed.otp, undefined, 'otp property must be removed by Pino redaction');
  assert.strictEqual(parsed.action, 'VERIFICATION_ATTEMPT', 'Non-sensitive field must be preserved');
});

test('Scenario 4: Nested and deeply nested otp fields are redacted by Pino configuration', () => {
  const nestedOtp1 = '519283';
  const nestedOtp2 = '930184';

  const { output } = captureLoggerOutput(() => {
    logger.info({
      auth: {
        method: 'EMAIL_OTP',
        otp: nestedOtp1,
      },
      audit: {
        deep: {
          otp: nestedOtp2,
          userId: 'usr_test_123',
        },
      },
    }, 'Testing nested OTP redaction');
  });

  assert.strictEqual(output.includes(nestedOtp1), false, 'Nested otp (depth 1) must be redacted');
  assert.strictEqual(output.includes(nestedOtp2), false, 'Deeply nested otp (depth 2) must be redacted');

  const lines = parseJsonLogs(output);
  const parsed = lines.find(l => l.msg === 'Testing nested OTP redaction');
  assert.ok(parsed, 'Log entry should be present in captured output');
  assert.strictEqual(parsed.auth.method, 'EMAIL_OTP');
  assert.strictEqual(parsed.auth.otp, undefined, 'auth.otp must be removed');
  assert.strictEqual(parsed.audit.deep.userId, 'usr_test_123');
  assert.strictEqual(parsed.audit.deep.otp, undefined, 'audit.deep.otp must be removed');
});

test('Scenario 5: FCM tokens, booking startOtp, and refreshTokens are redacted as intended', () => {
  const rawFcmToken = 'fcm_token_super_secret_abcdef123456';
  const rawStartOtp = '4829';
  const rawRefreshToken = 'rt_secret_token_value_99999';

  const { output } = captureLoggerOutput(() => {
    logger.info({
      fcmToken: rawFcmToken,
      refreshToken: rawRefreshToken,
      booking: {
        startOtp: rawStartOtp,
        bookingId: 'bk_98765',
      },
      device: {
        fcmToken: 'fcm_nested_token_xyz',
      },
      session: {
        refreshToken: 'nested_rt_value',
      },
    }, 'Testing FCM, startOtp, and refreshToken redaction');
  });

  assert.strictEqual(output.includes(rawFcmToken), false, 'fcmToken must be redacted');
  assert.strictEqual(output.includes(rawStartOtp), false, 'startOtp must be redacted');
  assert.strictEqual(output.includes(rawRefreshToken), false, 'refreshToken must be redacted');
  assert.strictEqual(output.includes('fcm_nested_token_xyz'), false, 'nested fcmToken must be redacted');
  assert.strictEqual(output.includes('nested_rt_value'), false, 'nested refreshToken must be redacted');

  const lines = parseJsonLogs(output);
  const parsed = lines.find(l => l.msg === 'Testing FCM, startOtp, and refreshToken redaction');
  assert.ok(parsed, 'Log entry should be present in captured output');
  assert.strictEqual(parsed.fcmToken, undefined);
  assert.strictEqual(parsed.refreshToken, undefined);
  assert.strictEqual(parsed.booking.startOtp, undefined);
  assert.strictEqual(parsed.booking.bookingId, 'bk_98765');
  assert.strictEqual(parsed.device.fcmToken, undefined);
  assert.strictEqual(parsed.session.refreshToken, undefined);
});

test('Scenario 6: End-to-end OTP generation and verification flow works without leaking OTP in logs', async () => {
  const testEmail = 'f05.e2e.flow@servfex.test';

  const { output } = await captureLoggerOutput(async () => {
    const genResult = await generateAndSendEmailOtp(testEmail);
    assert.strictEqual(genResult.success, true);
  });

  // Verify logger output during generation does NOT contain any generated 6-digit OTP
  const lines = parseJsonLogs(output);
  for (const entry of lines) {
    assert.strictEqual(entry.otp, undefined, 'No log entry should have an otp field');
    if (entry.msg === 'ServFex Mail OTP Generated') {
      assert.strictEqual(entry.to, testEmail);
      assert.strictEqual(entry.otpLength, 6);
    }
  }

  // Verify with an invalid OTP fails
  const failVerify = verifyEmailOtp(testEmail, '000000');
  assert.strictEqual(failVerify.valid, false, 'Invalid OTP must fail');

  // Verify development fallback code still works in non-production
  const devVerify = verifyEmailOtp(testEmail, '123456');
  assert.strictEqual(devVerify.valid, true, 'Dev fallback code 123456 should succeed in test environment');
});

test('Scenario 7: Normal non-sensitive logs remain intact', () => {
  const { output } = captureLoggerOutput(() => {
    logger.info({
      userId: 'usr_valid_456',
      role: 'CUSTOMER',
      action: 'BOOKING_VIEWED',
      metadata: {
        category: 'AC_REPAIR',
        itemsCount: 2,
      },
    }, 'Standard application event');
  });

  const lines = parseJsonLogs(output);
  const parsed = lines.find(l => l.msg === 'Standard application event');
  assert.ok(parsed, 'Log entry should be present in captured output');
  assert.strictEqual(parsed.userId, 'usr_valid_456');
  assert.strictEqual(parsed.role, 'CUSTOMER');
  assert.strictEqual(parsed.action, 'BOOKING_VIEWED');
  assert.strictEqual(parsed.metadata.category, 'AC_REPAIR');
  assert.strictEqual(parsed.metadata.itemsCount, 2);
  assert.strictEqual(parsed.msg, 'Standard application event');
});
