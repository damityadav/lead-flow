'use strict';
// ─────────────────────────────────────────────────────────────────────────
// WhatsApp Cloud API helper.
//
// Talks DIRECTLY to Meta's Graph API (no third-party BSP). Credentials live in
// site_settings (admin-managed), never hardcoded:
//   whatsapp_enabled_bot   '1' | '0'   — master switch for the AI auto-reply
//   whatsapp_phone_id      <Phone Number ID from Meta>
//   whatsapp_token         <permanent / long-lived access token>
//   whatsapp_verify_token  <any random string; matches the value set in Meta>
//
// All messages (in + out) are persisted to whatsapp_messages so the admin
// inbox can render full conversation threads.
// ─────────────────────────────────────────────────────────────────────────
const { db } = require('../db');

const GRAPH_VER = 'v21.0';

function getCfg() {
  const rows = db.prepare(
    "SELECT key, value FROM site_settings WHERE key IN ('whatsapp_enabled_bot','whatsapp_phone_id','whatsapp_token','whatsapp_verify_token','whatsapp_waba_id','whatsapp_app_id')"
  ).all();
  const c = {};
  for (const r of rows) c[r.key] = r.value;
  return c;
}

function isConfigured() {
  const c = getCfg();
  return !!(c.whatsapp_phone_id && c.whatsapp_token);
}

function botEnabled() {
  // AI auto-reply defaults ON when configured, unless explicitly turned off.
  const c = getCfg();
  return isConfigured() && (c.whatsapp_enabled_bot ?? '1') !== '0';
}

// ── Persistence helpers ──
function saveMessage({ wa_id, profile_name, direction, body, msg_type, engine, wam_id, status, media_url, media_type, broadcast_id }) {
  try {
    db.prepare(
      `INSERT INTO whatsapp_messages (wa_id, profile_name, direction, body, msg_type, engine, wam_id, is_read, status, media_url, media_type, broadcast_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(wa_id), profile_name || null, direction,
      body == null ? '' : String(body), msg_type || (media_type ? media_type : 'text'),
      engine || null, wam_id || null,
      direction === 'in' ? 0 : 1,
      status || (direction === 'out' ? 'sent' : null),
      media_url || null, media_type || null,
      broadcast_id || null
    );
    // Touch the thread row (so it exists for ai_paused flag lookups).
    db.prepare(
      `INSERT INTO whatsapp_threads (wa_id, updated_at) VALUES (?, CURRENT_TIMESTAMP)
       ON CONFLICT(wa_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`
    ).run(String(wa_id));
  } catch (e) {
    console.error('[WHATSAPP] saveMessage failed:', e.message);
  }
}

function isAiPaused(wa_id) {
  try {
    const row = db.prepare('SELECT ai_paused FROM whatsapp_threads WHERE wa_id = ?').get(String(wa_id));
    return !!(row && row.ai_paused);
  } catch { return false; }
}

// ── Send a text message via the Cloud API (Graph). Best-effort. ──
async function sendText(to, body) {
  const c = getCfg();
  if (!c.whatsapp_phone_id || !c.whatsapp_token) {
    throw new Error('WhatsApp not configured');
  }
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_phone_id}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + c.whatsapp_token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: String(to),
      type: 'text',
      text: { body: String(body).slice(0, 4000) }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  }
  return data && data.messages && data.messages[0] && data.messages[0].id;
}

// ── Send a media message (image / document / video / audio) by public URL. ──
async function sendMedia(to, mediaType, link, caption) {
  const c = getCfg();
  if (!c.whatsapp_phone_id || !c.whatsapp_token) throw new Error('WhatsApp not configured');
  const type = ['image', 'document', 'video', 'audio'].includes(mediaType) ? mediaType : 'document';
  const media = { link: String(link) };
  if (caption && type !== 'audio') media.caption = String(caption).slice(0, 1024);
  if (type === 'document') media.filename = ((String(link).split('?')[0].split('/').pop()) || 'file');
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_phone_id}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + c.whatsapp_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to), type, [type]: media })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  return data && data.messages && data.messages[0] && data.messages[0].id;
}

// ── Send an interactive message with up to 3 quick-reply buttons. ──
async function sendInteractiveButtons(to, bodyText, buttons) {
  const c = getCfg();
  if (!c.whatsapp_phone_id || !c.whatsapp_token) throw new Error('WhatsApp not configured');
  const btns = (Array.isArray(buttons) ? buttons : []).filter(Boolean).slice(0, 3)
    .map((b, i) => ({ type: 'reply', reply: { id: 'btn_' + (i + 1), title: String(b).slice(0, 20) } }));
  if (!btns.length) throw new Error('At least one button is required');
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_phone_id}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + c.whatsapp_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: String(to), type: 'interactive',
      interactive: { type: 'button', body: { text: String(bodyText).slice(0, 1024) }, action: { buttons: btns } }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  return data && data.messages && data.messages[0] && data.messages[0].id;
}

// Update an outbound message's delivery state from a status webhook (never
// downgrades, e.g. read -> delivered is ignored).
function updateMessageStatus(wamId, status) {
  if (!wamId || !status) return;
  const rank = { sent: 1, delivered: 2, read: 3, failed: 4 };
  try {
    const row = db.prepare('SELECT status FROM whatsapp_messages WHERE wam_id = ?').get(String(wamId));
    if (!row) return;
    if (status === 'failed' || (rank[status] || 0) >= (rank[row.status] || 0)) {
      db.prepare('UPDATE whatsapp_messages SET status = ? WHERE wam_id = ?').run(status, String(wamId));
    }
  } catch (_) {}
}

// Normalise a phone to WhatsApp's E.164 digits (no '+'). Indian-friendly:
// "9876543210" → "919876543210"; "+91 98765 43210" → "919876543210".
// Returns null when it can't be confidently normalised.
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return '91' + d;                               // bare 10-digit mobile
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1); // leading 0
  if (d.length === 12 && d.startsWith('91')) return d;                // already 91XXXXXXXXXX
  if (d.length >= 11 && d.length <= 15) return d;                     // other intl numbers
  return null;
}

// ── Send an approved TEMPLATE message (required for marketing/outside-24h). ──
// templateName + lang must match a template approved in Meta. bodyParams fill
// the body's {{1}}, {{2}}… placeholders (same for every recipient in a blast).
async function sendTemplate(to, templateName, lang, bodyParams, headerImageLink) {
  const c = getCfg();
  if (!c.whatsapp_phone_id || !c.whatsapp_token) {
    throw new Error('WhatsApp not configured');
  }
  const components = [];
  // Image header (when the template has an IMAGE header) — pass a public URL.
  if (headerImageLink && String(headerImageLink).trim()) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: String(headerImageLink).trim() } }]
    });
  }
  if (Array.isArray(bodyParams) && bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map(t => ({ type: 'text', text: String(t).slice(0, 600) }))
    });
  }
  const payload = {
    messaging_product: 'whatsapp',
    to: String(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang || 'en' },
      ...(components.length ? { components } : {})
    }
  };
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_phone_id}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + c.whatsapp_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  }
  return data && data.messages && data.messages[0] && data.messages[0].id;
}

// ── List message templates from the WhatsApp Business Account (WABA). ──
// Returns each template's name, status (APPROVED/PENDING/REJECTED), category,
// language and body text — so the admin can pick from a dropdown.
async function listTemplates() {
  const c = getCfg();
  if (!c.whatsapp_waba_id || !c.whatsapp_token) {
    throw new Error('Add your WhatsApp Business Account ID (WABA ID) and token in Settings first.');
  }
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_waba_id}/message_templates?limit=200&fields=name,status,category,language,components`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + c.whatsapp_token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  }
  const list = Array.isArray(data.data) ? data.data : [];
  return list.map(t => {
    const body = (t.components || []).find(x => x.type === 'BODY');
    const header = (t.components || []).find(x => x.type === 'HEADER');
    return {
      name: t.name,
      status: t.status,
      category: t.category,
      language: t.language,
      body: body ? body.text : '',
      headerFormat: header ? (header.format || 'TEXT') : '',
      // Count {{n}} placeholders so the broadcast UI can ask for that many params.
      varCount: body && body.text ? (body.text.match(/\{\{\s*\d+\s*\}\}/g) || []).length : 0
    };
  });
}

// ── Upload an image to Meta's resumable upload API → returns a "handle". ──
// The handle is required as the sample image when creating an IMAGE-header
// template. Needs the Meta App ID (whatsapp_app_id) + token. JPG/PNG only.
async function uploadHeaderHandle(imageUrl) {
  const c = getCfg();
  if (!c.whatsapp_app_id || !c.whatsapp_token) {
    throw new Error('To use an image header, add your Meta App ID (App ID) in Settings first.');
  }
  // 1) Fetch the image bytes server-side.
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error('Could not fetch the header image (HTTP ' + imgRes.status + ').');
  let mime = (imgRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpe?g|png)$/.test(mime)) {
    mime = /\.png(\?|$)/i.test(imageUrl) ? 'image/png' : 'image/jpeg';
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (!buf.length) throw new Error('The header image is empty.');
  if (buf.length > 5 * 1024 * 1024) throw new Error('Header image is too large (max 5 MB).');

  // 2) Start a resumable upload session.
  const startUrl = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_app_id}/uploads`
    + `?file_length=${buf.length}&file_type=${encodeURIComponent(mime)}`
    + `&access_token=${encodeURIComponent(c.whatsapp_token)}`;
  const startRes = await fetch(startUrl, { method: 'POST' });
  const startData = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startData.id) {
    throw new Error((startData.error && startData.error.message) || 'Could not start the image upload.');
  }

  // 3) Upload the bytes; Meta returns { h: "<handle>" }.
  const upUrl = `https://graph.facebook.com/${GRAPH_VER}/${startData.id}`;
  const upRes = await fetch(upUrl, {
    method: 'POST',
    headers: { 'Authorization': 'OAuth ' + c.whatsapp_token, 'file_offset': '0' },
    body: buf
  });
  const upData = await upRes.json().catch(() => ({}));
  if (!upRes.ok || !upData.h) {
    throw new Error((upData.error && upData.error.message) || 'The image upload failed.');
  }
  return upData.h;
}

// ── Create a new message template (goes to Meta for approval → PENDING). ──
// opts: { name, category('MARKETING'|'UTILITY'), language, bodyText, footerText, examples[] }
async function createTemplate(opts) {
  const c = getCfg();
  if (!c.whatsapp_waba_id || !c.whatsapp_token) {
    throw new Error('Add your WhatsApp Business Account ID (WABA ID) and token in Settings first.');
  }
  const name = String(opts.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 512);
  if (!name) throw new Error('Template name is required');
  const bodyText = String(opts.bodyText || '').trim();
  if (!bodyText) throw new Error('Body text is required');

  const components = [];

  // Optional IMAGE header — Meta needs a sample image "handle" from the
  // resumable-upload API. We fetch the image bytes server-side and upload them.
  if (opts.headerImageUrl && String(opts.headerImageUrl).trim()) {
    const handle = await uploadHeaderHandle(String(opts.headerImageUrl).trim());
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } });
  }

  const bodyComp = { type: 'BODY', text: bodyText };
  // Meta requires example values for every {{n}} placeholder in the body.
  const varCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
  if (varCount > 0) {
    const examples = Array.isArray(opts.examples) ? opts.examples : [];
    const filled = [];
    for (let i = 0; i < varCount; i++) filled.push(String(examples[i] || 'sample').slice(0, 60));
    bodyComp.example = { body_text: [filled] };
  }
  components.push(bodyComp);
  if (opts.footerText && String(opts.footerText).trim()) {
    components.push({ type: 'FOOTER', text: String(opts.footerText).trim().slice(0, 60) });
  }

  const payload = {
    name,
    category: (opts.category === 'UTILITY') ? 'UTILITY' : 'MARKETING',
    language: opts.language || 'en_US',
    components
  };
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_waba_id}/message_templates`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + c.whatsapp_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  }
  return { id: data.id, status: data.status || 'PENDING', name };
}

// ── Delete a template by name (removes ALL language versions of that name). ──
async function deleteTemplate(name) {
  const c = getCfg();
  if (!c.whatsapp_waba_id || !c.whatsapp_token) {
    throw new Error('Add your WhatsApp Business Account ID (WABA ID) and token in Settings first.');
  }
  const n = String(name || '').trim();
  if (!n) throw new Error('Template name required');
  const url = `https://graph.facebook.com/${GRAPH_VER}/${c.whatsapp_waba_id}/message_templates?name=${encodeURIComponent(n)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + c.whatsapp_token }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
  }
  return { ok: true };
}

module.exports = { GRAPH_VER, getCfg, isConfigured, botEnabled, saveMessage, isAiPaused, sendText, sendMedia, sendInteractiveButtons, updateMessageStatus, normalizePhone, sendTemplate, listTemplates, createTemplate, deleteTemplate, uploadHeaderHandle };
