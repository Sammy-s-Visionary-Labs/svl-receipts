/** SVL Receipts — install while signed in as recisvl@gmail.com.
 * Script Properties: SVL_IMPORT_SECRET (provided by the app administrator).
 * Optional SVL_START_AT: ISO timestamp for explicitly requested historical mail.
 * Only Gmail read-only and external-request permissions are used.
 */
const SVL_MAILBOX = 'recisvl@gmail.com';
const SVL_URL = 'https://svl-receipts-web.vercel.app';

function setupReceiptImporter() {
  assertReceiptMailbox_();
  const properties = PropertiesService.getScriptProperties();
  if ((properties.getProperty('SVL_IMPORT_SECRET') || '').length < 32) throw new Error('Set SVL_IMPORT_SECRET in Script Properties first.');
  if (!properties.getProperty('SVL_CURSOR')) {
    const start = properties.getProperty('SVL_START_AT') || new Date().toISOString();
    if (!Number.isFinite(Date.parse(start))) throw new Error('SVL_START_AT must be a valid ISO date.');
    properties.setProperty('SVL_START_BOUND', String(Math.floor(Date.parse(start) / 1000)));
    properties.setProperty('SVL_CURSOR', String(Math.floor(Date.parse(start) / 1000)));
  }
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'importReceiptEmails') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('importReceiptEmails').timeBased().everyHours(8).create();
  console.log('Receipt importer installed for recisvl@gmail.com: every 8 hours.');
}

function assertReceiptMailbox_() {
  const profile = Gmail.Users.getProfile('me');
  if ((profile.emailAddress || '').toLowerCase() !== SVL_MAILBOX) throw new Error('Install this script under recisvl@gmail.com. No messages were read.');
}

function importReceiptEmails() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    assertReceiptMailbox_();
    const properties = PropertiesService.getScriptProperties();
    const cursor = properties.getProperty('SVL_CURSOR');
    if (!cursor) throw new Error('Run setupReceiptImporter first.');
    const started = Date.now();
    const until = properties.getProperty('SVL_WINDOW_END') || String(Math.floor(started / 1000));
    properties.setProperty('SVL_WINDOW_END', until);
    let pageToken = properties.getProperty('SVL_PAGE_TOKEN') || undefined;
    // Fix the time window while paginating; overlap the boundary to catch late
    // delivery. Server message IDs make repeated reads safe.
    do {
      const result = Gmail.Users.Messages.list('me', {
        q: 'after:' + Math.max(Number(properties.getProperty('SVL_START_BOUND') || 0), Number(cursor) - 86400) + ' before:' + until + ' -in:drafts',
        maxResults: 10,
        pageToken: pageToken,
        includeSpamTrash: false
      });
      const messages = result.messages || [];
      for (let i = 0; i < messages.length; i++) {
        if (Date.now() - started > 240000) return; // Replay this page next time.
        const message = Gmail.Users.Messages.get('me', messages[i].id, { format: 'raw' });
        const bytes = decodeGmailRaw_(message.raw);
        if (bytes.length > 40 * 1024 * 1024) throw new Error('Message exceeds 40 MB: ' + messages[i].id + '. Administrator attention required.');
        const checksum = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
          .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
        const item = svlRequest_('/api/email-imports', { messageId: message.id, checksum: checksum, byteSize: bytes.length });
        if (item.status === 'awaiting_upload') {
          if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/upload\/sign\/receipt-emails\//.test(item.uploadUrl)) throw new Error('Invalid private upload destination.');
          const upload = UrlFetchApp.fetch(item.uploadUrl, {
            method: 'put', contentType: 'message/rfc822', payload: bytes,
            muteHttpExceptions: true, followRedirects: false
          });
          // A lost acknowledgement can leave an existing immutable object.
          // Confirmation verifies its full checksum before accepting it.
          if (upload.getResponseCode() >= 500) throw new Error('Original upload temporarily unavailable.');
          svlRequest_('/api/email-imports/' + item.id + '/confirm', {});
        }
      }
      pageToken = result.nextPageToken;
      if (pageToken) properties.setProperty('SVL_PAGE_TOKEN', pageToken);
      else {
        properties.setProperty('SVL_CURSOR', until);
        properties.deleteProperty('SVL_PAGE_TOKEN');
        properties.deleteProperty('SVL_WINDOW_END');
      }
    } while (pageToken && Date.now() - started < 240000);
    // Recover previously queued imports/extraction, without any Housecall writes.
    if (Date.now() - started < 120000) svlRequest_('/api/email-imports/process', {});
  } finally {
    lock.releaseLock();
  }
}

function decodeGmailRaw_(raw) {
  // The advanced Gmail service decodes byte fields into Byte[] itself.
  // Preserve those original bytes instead of trying to base64-decode them again.
  if (Array.isArray(raw)) {
    if (!raw.length || !raw.every(function(b) { return Number.isInteger(b) && b >= -128 && b <= 255; })) throw new Error('Gmail returned invalid raw message encoding.');
    return raw.map(function(b) { return b > 127 ? b - 256 : b; });
  }
  // Also support encoded responses, normalizing the alphabet and padding.
  if (typeof raw !== 'string' || !raw.length || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(raw)) throw new Error('Gmail returned invalid raw message encoding.');
  const encoded = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (encoded.length % 4 === 1) throw new Error('Gmail returned truncated raw message encoding.');
  return Utilities.base64Decode(encoded + '='.repeat((4 - encoded.length % 4) % 4));
}

function svlRequest_(route, payload) {
  const secret = PropertiesService.getScriptProperties().getProperty('SVL_IMPORT_SECRET');
  if (!secret || secret.length < 32) throw new Error('Missing importer secret.');
  const response = UrlFetchApp.fetch(SVL_URL + route, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret }, payload: JSON.stringify(payload),
    muteHttpExceptions: true, followRedirects: false
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error('Receipt importer request failed (' + response.getResponseCode() + '). Retry is safe.');
  return JSON.parse(response.getContentText());
}
