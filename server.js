// LeadFlow — self-hosted WhatsApp + Meta Lead Ads CRM
// Express + node:sqlite + session auth. Run with: npm start
'use strict';
const express = require('express');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
let sharp = null;
try { sharp = require('sharp'); }
catch (e) { console.warn('[UPLOAD] sharp not available — images saved un-optimized:', e.message); }

const { db } = require('./db');
const whatsapp = require('./lib/whatsapp');
const fbLeads = require('./lib/fb-leads');
const aiAssistant = require('./lib/ai-assistant');

const app = express();
const PORT = process.env.PORT || 3100;
const IS_PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Uploads ──
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf'];
const RASTER_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
function buildUploadName(original, forceExt) {
  const ext = forceExt || (path.extname(original || '') || '.bin').toLowerCase();
  const base = (path.basename(original || 'file', path.extname(original || '')) || 'file')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
  return `${base}-${Date.now()}-${Math.floor(Math.random() * 1e4)}${ext}`;
}
async function persistUpload(file) {
  // Optimize raster images to WebP when sharp is available; else save as-is.
  if (sharp && RASTER_MIMES.includes(file.mimetype)) {
    try {
      const outBuf = await sharp(file.buffer).rotate()
        .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer();
      const filename = buildUploadName(file.originalname, '.webp');
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), outBuf);
      return { filename, size: outBuf.length, mimetype: 'image/webp' };
    } catch (e) { /* fall through to raw save */ }
  }
  const filename = buildUploadName(file.originalname);
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
  return { filename, size: file.buffer.length, mimetype: file.mimetype };
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMES.includes(file.mimetype)) return cb(new Error('Only image / PDF files are allowed'));
    cb(null, true);
  }
});

// ── Sessions ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7, sameSite: 'lax', secure: IS_PROD }
}));

// ── Auth middleware (session-based) ──
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// ── Auth routes ──
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role || 'admin';
  res.json({ ok: true, username: user.username, role: req.session.role });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.userId) return res.json({ authenticated: true, username: req.session.username, role: req.session.role || 'admin' });
  res.json({ authenticated: false });
});
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be 6+ chars' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) return res.status(401).json({ error: 'Current password is wrong' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ ok: true });
});

// ════════════════ SECTION LOCKS (leads + whatsapp) ════════════════
function leadsPassword() {
  const r = db.prepare("SELECT value FROM site_settings WHERE key = 'leads_password'").get();
  return (r && r.value && r.value.trim()) || process.env.LEADS_PASSWORD || 'changeme';
}
function whatsappPassword() {
  const r = db.prepare("SELECT value FROM site_settings WHERE key = 'whatsapp_password'").get();
  return (r && r.value && r.value.trim()) || process.env.WHATSAPP_PASSWORD || 'changeme';
}
// Section lock removed — admin login is the only gate. Kept as a pass-through
// so the existing route signatures don't need to change.
function requireLeadsUnlock(req, res, next) { return next(); }
app.post('/api/admin/leads/unlock', requireAdmin, (req, res) => {
  if (((req.body && req.body.password) || '') !== leadsPassword()) return res.status(401).json({ error: 'Wrong password' });
  req.session.leads_unlocked = true; res.json({ ok: true });
});
app.post('/api/admin/leads/lock', requireAdmin, (req, res) => { if (req.session) req.session.leads_unlocked = false; res.json({ ok: true }); });
app.get('/api/admin/leads/status', requireAdmin, (req, res) => { res.json({ unlocked: true }); });

// Section lock removed — admin login is the only gate for WhatsApp routes.
app.use('/api/admin/whatsapp', requireAdmin, (req, res, next) => next());
function setSectionPassword(key, value) {
  db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(key, String(value));
}
app.post('/api/admin/leads/change-password', requireAdmin, (req, res) => {
  const cur = (req.body && req.body.current || '').toString();
  const next = (req.body && req.body.next || '').toString();
  if (cur !== leadsPassword()) return res.status(401).json({ error: 'Current password is wrong' });
  if (next.trim().length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  setSectionPassword('leads_password', next); res.json({ ok: true });
});
app.post('/api/admin/whatsapp/change-password', requireAdmin, (req, res) => {
  const cur = (req.body && req.body.current || '').toString();
  const next = (req.body && req.body.next || '').toString();
  if (cur !== whatsappPassword()) return res.status(401).json({ error: 'Current password is wrong' });
  if (next.trim().length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  setSectionPassword('whatsapp_password', next); res.json({ ok: true });
});
app.post('/api/admin/whatsapp/unlock', requireAdmin, (req, res) => {
  if (((req.body && req.body.password) || '') !== whatsappPassword()) return res.status(401).json({ error: 'Wrong password' });
  req.session.whatsapp_unlocked = true; res.json({ ok: true });
});
app.post('/api/admin/whatsapp/lock', requireAdmin, (req, res) => { if (req.session) req.session.whatsapp_unlocked = false; res.json({ ok: true }); });
app.get('/api/admin/whatsapp/lock-status', requireAdmin, (req, res) => { res.json({ unlocked: true }); });

// ════════════════ EMAIL NOTIFICATION (optional) ════════════════
function getEmailConfig() {
  const rows = db.prepare("SELECT key, value FROM site_settings WHERE key IN ('email_enabled','email_gmail','email_app_password','email_recipients','email_from_name')").all();
  const cfg = {}; for (const r of rows) cfg[r.key] = r.value; return cfg;
}
function sendLeadNotification(lead) {
  try {
    const cfg = getEmailConfig();
    if (cfg.email_enabled !== '1' || !cfg.email_gmail || !cfg.email_app_password) return;
    const recipients = (cfg.email_recipients || cfg.email_gmail).split(/[,;\s]+/).filter(Boolean);
    if (!recipients.length) return;
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.email_gmail, pass: cfg.email_app_password } });
    const lines = [
      `New lead via ${lead.source || 'website'}`, '',
      lead.name ? `Name: ${lead.name}` : '',
      lead.phone ? `Phone: ${lead.phone}` : '',
      lead.email ? `Email: ${lead.email}` : '',
      lead.interested_in ? `Interested in: ${lead.interested_in}` : '',
      lead.message ? `Message: ${lead.message}` : '',
      lead.page_url ? `Page: ${lead.page_url}` : ''
    ].filter(Boolean).join('\n');
    transporter.sendMail({
      from: `"${((cfg.email_from_name && cfg.email_from_name.trim()) || 'LeadFlow').replace(/"/g, '')}" <${cfg.email_gmail}>`,
      to: recipients.join(', '), replyTo: lead.email || undefined,
      subject: `New lead — ${lead.source || 'website'}${lead.name ? ' — ' + lead.name : ''}`, text: lines
    }).catch(err => console.error('[EMAIL] Failed:', err.message));
  } catch (e) { console.error('[EMAIL] Config error:', e.message); }
}

// ════════════════ PUBLIC LEAD INTAKE ════════════════
// POST /api/leads  { name, phone, email, message, interested_in, source, page_url }
app.post('/api/leads', (req, res) => {
  const b = req.body || {};
  const source = (b.source || '').toString().trim().slice(0, 64);
  if (!source) return res.status(400).json({ error: 'source is required' });
  if (!b.name && !b.phone && !b.email) return res.status(400).json({ error: 'Provide at least a name, phone, or email' });
  const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const pageUrl = clip(b.page_url || req.headers.referer || '', 500);
  try {
    const info = db.prepare(
      `INSERT INTO leads (name, phone, email, message, interested_in, property_slug, property_name, source, page_url, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(clip(b.name, 120), clip(b.phone, 40), clip(b.email, 200), clip(b.message, 2000),
      clip(b.interested_in, 200), clip(b.property_slug, 120), clip(b.property_name, 200), source, pageUrl,
      clip(ip, 64), clip(req.headers['user-agent'], 400));
    const leadId = info.lastInsertRowid;
    try {
      const waId = whatsapp.normalizePhone(b.phone);
      if (waId) {
        const tag = (clip(b.interested_in, 60) || '').trim() || 'Website Enquiry';
        db.prepare(
          `INSERT INTO wa_contacts (wa_id, name, tags, source) VALUES (?, ?, ?, 'website_enquiry')
           ON CONFLICT(wa_id) DO UPDATE SET
             name = CASE WHEN (wa_contacts.name IS NULL OR wa_contacts.name = '') THEN excluded.name ELSE wa_contacts.name END,
             tags = CASE WHEN wa_contacts.tags IS NULL OR wa_contacts.tags = '' THEN excluded.tags
                         WHEN (',' || lower(replace(wa_contacts.tags,' ','')) || ',') LIKE ('%,' || lower(replace(excluded.tags,' ','')) || ',%') THEN wa_contacts.tags
                         ELSE wa_contacts.tags || ', ' || excluded.tags END,
             updated_at = CURRENT_TIMESTAMP`
        ).run(waId, clip(b.name, 120) || '', tag);
      }
    } catch (_) {}
    sendLeadNotification({ id: leadId, name: clip(b.name, 120), phone: clip(b.phone, 40), email: clip(b.email, 200), message: clip(b.message, 2000), interested_in: clip(b.interested_in, 200), page_url: pageUrl, source });
    res.status(201).json({ ok: true, id: leadId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════ AI ASSISTANT (optional public chat API) ════════════════
const aiChatHits = new Map();
const AI_WINDOW_MS = 60 * 1000, AI_MAX_PER_WINDOW = 12;
function aiRateLimited(ip) {
  const now = Date.now();
  const arr = (aiChatHits.get(ip) || []).filter(t => now - t < AI_WINDOW_MS);
  arr.push(now); aiChatHits.set(ip, arr);
  if (aiChatHits.size > 5000) for (const [k, v] of aiChatHits) if (!v.length || now - v[v.length - 1] > AI_WINDOW_MS) aiChatHits.delete(k);
  return arr.length > AI_MAX_PER_WINDOW;
}
app.post('/api/assistant/chat', (req, res) => {
  let switchOff = false;
  try { const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get('ai_assistant_enabled'); switchOff = row && row.value === '0'; } catch {}
  if (switchOff) return res.status(503).json({ error: 'Assistant is currently unavailable.' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (aiRateLimited(ip)) return res.status(429).json({ error: 'Too many messages — please wait a moment.' });
  const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : null;
  if (!messages || !messages.length) return res.status(400).json({ error: 'messages array is required' });
  aiAssistant.chat(messages)
    .then(({ reply }) => res.json({ reply }))
    .catch(err => { console.error('[AI]', err.message); res.status(500).json({ error: 'The assistant had trouble responding.' }); });
});
app.get('/api/admin/assistant/status', requireAdmin, async (req, res) => {
  try { res.json(await aiAssistant.healthCheck()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════ WHATSAPP CLOUD API WEBHOOK ════════════════
app.get('/api/whatsapp/webhook', (req, res) => {
  const cfg = whatsapp.getCfg();
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === cfg.whatsapp_verify_token) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

const recentLeadgen = [];
function logLeadgen(rec) { recentLeadgen.unshift({ at: new Date().toISOString(), ...rec }); if (recentLeadgen.length > 25) recentLeadgen.length = 25; }

async function handleLeadgen(v) {
  const leadgenId = v.leadgen_id, pageId = v.page_id;
  if (!leadgenId || !pageId) { logLeadgen({ ok: false, note: 'missing leadgen_id/page_id', v }); return; }
  const token = fbLeads.pageToken(pageId);
  if (!token) { logLeadgen({ ok: false, page_id: pageId, leadgen_id: leadgenId, note: 'no stored token — reconnect Facebook' }); return; }
  let lead;
  try { lead = await fbLeads.fetchLead(leadgenId, token); }
  catch (e) { logLeadgen({ ok: false, page_id: pageId, leadgen_id: leadgenId, note: 'fetchLead failed: ' + e.message }); throw e; }
  const f = fbLeads.parseLeadFields(lead.field_data);
  const campaign = (lead.campaign_name || lead.ad_name || lead.form_name || 'Meta Lead').toString().slice(0, 60);
  const wa = whatsapp.normalizePhone(f.phone);
  logLeadgen({ ok: true, page_id: pageId, leadgen_id: leadgenId, name: f.name, phone: f.phone, normalized: wa, campaign });
  try { db.prepare(`INSERT INTO leads (name, phone, email, message, source, user_agent) VALUES (?, ?, ?, ?, 'meta_lead', 'meta-lead-ads')`).run(f.name || null, f.phone || (wa || null), f.email || null, 'Campaign: ' + campaign); } catch (_) {}
  if (wa) {
    try {
      db.prepare(
        `INSERT INTO wa_contacts (wa_id, name, tags, source) VALUES (?, ?, ?, 'meta_lead')
         ON CONFLICT(wa_id) DO UPDATE SET
           name = CASE WHEN (wa_contacts.name IS NULL OR wa_contacts.name = '') THEN excluded.name ELSE wa_contacts.name END,
           tags = CASE WHEN wa_contacts.tags IS NULL OR wa_contacts.tags = '' THEN excluded.tags
                       WHEN (',' || lower(replace(wa_contacts.tags,' ','')) || ',') LIKE ('%,' || lower(replace(excluded.tags,' ','')) || ',%') THEN wa_contacts.tags
                       ELSE wa_contacts.tags || ', ' || excluded.tags END,
           updated_at = CURRENT_TIMESTAMP`
      ).run(wa, f.name || '', campaign);
    } catch (e) { console.error('[FB LEADGEN] contact save failed:', e.message); }
  }
  console.log(`✓ Meta lead: ${f.name || '?'} ${wa || f.phone || ''} [${campaign}]`);
}

app.post('/api/whatsapp/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = (req.body && req.body.entry) || [];
    if (req.body && req.body.object && req.body.object !== 'whatsapp_business_account') {
      logLeadgen({ ok: null, note: 'webhook received (object=' + req.body.object + ')', fields: entry.flatMap(e => (e.changes || []).map(c => c.field)) });
    }
    for (const e of entry) {
      for (const change of (e.changes || [])) {
        const v = change.value || {};
        if (change.field === 'leadgen') { try { await handleLeadgen(v); } catch (err) { console.error('[FB LEADGEN]', err.message); } continue; }
        const contacts = v.contacts || [];
        const nameByWaId = {};
        contacts.forEach(c => { if (c.wa_id) nameByWaId[c.wa_id] = (c.profile && c.profile.name) || null; });
        for (const s of (v.statuses || [])) whatsapp.updateMessageStatus(s.id, s.status);
        for (const m of (v.messages || [])) {
          const waId = m.from;
          let body = '';
          if (m.type === 'text') body = (m.text && m.text.body) || '';
          else if (m.type === 'interactive') body = (m.interactive && (m.interactive.button_reply && m.interactive.button_reply.title || m.interactive.list_reply && m.interactive.list_reply.title)) || '';
          else if (m.type === 'button') body = (m.button && m.button.text) || '';
          else continue;
          const profileName = nameByWaId[waId] || null;
          whatsapp.saveMessage({ wa_id: waId, profile_name: profileName, direction: 'in', body, wam_id: m.id });
          const _lc = body.trim().toLowerCase();
          if (['stop', 'unsubscribe', 'stop promotions', 'opt out', 'optout'].includes(_lc)) {
            try { db.prepare('UPDATE wa_contacts SET opted_out = 1, updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?').run(waId); } catch (_) {}
            try { db.prepare("UPDATE wa_sequence_enrollments SET status = 'stopped' WHERE wa_id = ?").run(waId); } catch (_) {}
            try { if (whatsapp.isConfigured()) { const id = await whatsapp.sendText(waId, "You've been unsubscribed. Reply START to opt back in."); whatsapp.saveMessage({ wa_id: waId, direction: 'out', body: "You've been unsubscribed. Reply START to opt back in.", engine: 'system', wam_id: id }); } } catch (_) {}
            continue;
          }
          if (['start', 'unstop', 'subscribe', 'opt in', 'optin'].includes(_lc)) {
            try { db.prepare('UPDATE wa_contacts SET opted_out = 0, updated_at = CURRENT_TIMESTAMP WHERE wa_id = ?').run(waId); } catch (_) {}
            try { if (whatsapp.isConfigured()) { const id = await whatsapp.sendText(waId, "You're subscribed again. Welcome back!"); whatsapp.saveMessage({ wa_id: waId, direction: 'out', body: "You're subscribed again. Welcome back!", engine: 'system', wam_id: id }); } } catch (_) {}
            continue;
          }
          try {
            db.prepare(
              `INSERT INTO wa_contacts (wa_id, name, tags, source) VALUES (?, ?, 'WhatsApp Direct', 'inbound')
               ON CONFLICT(wa_id) DO UPDATE SET
                 name = CASE WHEN (wa_contacts.name IS NULL OR wa_contacts.name = '') THEN excluded.name ELSE wa_contacts.name END,
                 tags = CASE WHEN wa_contacts.tags IS NULL OR wa_contacts.tags = '' THEN 'WhatsApp Direct'
                             WHEN (',' || lower(replace(wa_contacts.tags,' ','')) || ',') LIKE '%,whatsappdirect,%' THEN wa_contacts.tags
                             ELSE wa_contacts.tags || ', WhatsApp Direct' END,
                 updated_at = CURRENT_TIMESTAMP`
            ).run(waId, profileName || '');
          } catch (_) {}
          try {
            const existingWaLead = db.prepare("SELECT 1 FROM leads WHERE phone = ? AND source = 'whatsapp' LIMIT 1").get(waId);
            if (!existingWaLead) db.prepare(`INSERT INTO leads (name, phone, message, source, ip, user_agent) VALUES (?, ?, ?, 'whatsapp', NULL, 'whatsapp-cloud')`).run(profileName || null, waId, body.slice(0, 2000));
          } catch (_) {}
          if (whatsapp.botEnabled() && !whatsapp.isAiPaused(waId)) {
            try {
              const hist = db.prepare('SELECT direction, body FROM whatsapp_messages WHERE wa_id = ? ORDER BY id DESC LIMIT 10').all(waId).reverse()
                .map(r => ({ role: r.direction === 'in' ? 'user' : 'assistant', content: r.body || '' }));
              const { reply, engine } = await aiAssistant.chat(hist);
              if (reply) {
                const origin = (req.protocol + '://' + req.get('host'));
                const waReply = aiAssistant.formatForWhatsApp(reply, origin);
                const wamId = await whatsapp.sendText(waId, waReply);
                whatsapp.saveMessage({ wa_id: waId, profile_name: profileName, direction: 'out', body: waReply, engine, wam_id: wamId });
              }
            } catch (err) { console.error('[WHATSAPP] auto-reply failed:', err.message); }
          }
        }
      }
    }
  } catch (e) { console.error('[WHATSAPP] webhook error:', e.message); }
});

// ════════════════ WHATSAPP ADMIN ════════════════
app.get('/api/admin/whatsapp/status', requireAdmin, (req, res) => { res.json({ configured: whatsapp.isConfigured(), botEnabled: whatsapp.botEnabled() }); });

app.get('/api/admin/whatsapp/unread-count', requireAdmin, (req, res) => {
  try { const r = db.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE direction = 'in' AND is_read = 0").get(); res.json({ totalUnread: (r && r.n) || 0 }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/whatsapp/conversations', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT m.wa_id, MAX(m.created_at) AS last_at,
             SUM(CASE WHEN m.direction = 'in' AND m.is_read = 0 THEN 1 ELSE 0 END) AS unread, COUNT(*) AS total
      FROM whatsapp_messages m GROUP BY m.wa_id ORDER BY last_at DESC LIMIT 200`).all();
    const out = rows.map(r => {
      const last = db.prepare('SELECT body, direction, profile_name FROM whatsapp_messages WHERE wa_id = ? ORDER BY id DESC LIMIT 1').get(r.wa_id);
      const nameRow = db.prepare("SELECT profile_name FROM whatsapp_messages WHERE wa_id = ? AND profile_name IS NOT NULL AND profile_name <> '' ORDER BY id DESC LIMIT 1").get(r.wa_id);
      const t = db.prepare('SELECT ai_paused, label FROM whatsapp_threads WHERE wa_id = ?').get(r.wa_id);
      const contact = db.prepare('SELECT name FROM wa_contacts WHERE wa_id = ?').get(r.wa_id);
      return { wa_id: r.wa_id, name: (nameRow && nameRow.profile_name) || (contact && contact.name) || null,
        last_message: last ? last.body : '', last_direction: last ? last.direction : '', last_at: r.last_at,
        unread: r.unread || 0, total: r.total || 0, ai_paused: !!(t && t.ai_paused), label: (t && t.label) || '' };
    });
    res.json({ conversations: out, totalUnread: out.reduce((n, c) => n + (c.unread || 0), 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/whatsapp/conversations/:waId', requireAdmin, (req, res) => {
  const waId = String(req.params.waId);
  try {
    const messages = db.prepare('SELECT id, direction, body, engine, status, media_url, media_type, created_at FROM whatsapp_messages WHERE wa_id = ? ORDER BY id ASC').all(waId);
    db.prepare("UPDATE whatsapp_messages SET is_read = 1 WHERE wa_id = ? AND direction = 'in'").run(waId);
    const nameRow = db.prepare("SELECT profile_name FROM whatsapp_messages WHERE wa_id = ? AND profile_name IS NOT NULL AND profile_name <> '' ORDER BY id DESC LIMIT 1").get(waId);
    const t = db.prepare('SELECT ai_paused, label FROM whatsapp_threads WHERE wa_id = ?').get(waId);
    const contact = db.prepare('SELECT name FROM wa_contacts WHERE wa_id = ?').get(waId);
    res.json({ wa_id: waId, name: (nameRow && nameRow.profile_name) || (contact && contact.name) || null, ai_paused: !!(t && t.ai_paused), label: (t && t.label) || '', messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/whatsapp/conversations/:waId/reply', requireAdmin, async (req, res) => {
  const waId = String(req.params.waId);
  const b = req.body || {};
  const body = (b.body || '').toString().trim();
  const mediaUrl = absoluteUrl(req, b.mediaUrl);
  const mediaType = (b.mediaType || 'document').toString();
  const buttons = Array.isArray(b.buttons) ? b.buttons.map(x => String(x).trim()).filter(Boolean).slice(0, 3) : [];
  if (!body && !mediaUrl && !buttons.length) return res.status(400).json({ error: 'Message body, media or buttons required' });
  try {
    let sent = true, sendError = null, wamId = null;
    if (whatsapp.isConfigured()) {
      try {
        if (mediaUrl) wamId = await whatsapp.sendMedia(waId, mediaType, mediaUrl, body);
        else if (buttons.length) wamId = await whatsapp.sendInteractiveButtons(waId, body || 'Please choose:', buttons);
        else wamId = await whatsapp.sendText(waId, body);
      } catch (e) { sent = false; sendError = e.message; }
    } else { sent = false; sendError = 'WhatsApp not configured (stored only)'; }
    const storedBody = body || (mediaUrl ? '[' + mediaType + ']' : (buttons.length ? 'Buttons: ' + buttons.join(' | ') : ''));
    whatsapp.saveMessage({ wa_id: waId, direction: 'out', body: storedBody, engine: 'admin', wam_id: wamId, media_url: mediaUrl || null, media_type: mediaUrl ? mediaType : null });
    res.json({ ok: true, sent, sendError });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/whatsapp/conversations/:waId/ai-pause', requireAdmin, (req, res) => {
  const waId = String(req.params.waId);
  const paused = req.body && req.body.paused ? 1 : 0;
  try {
    db.prepare(`INSERT INTO whatsapp_threads (wa_id, ai_paused, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(wa_id) DO UPDATE SET ai_paused = ?, updated_at = CURRENT_TIMESTAMP`).run(waId, paused, paused);
    res.json({ ok: true, ai_paused: !!paused });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/whatsapp/conversations/:waId/label', requireAdmin, (req, res) => {
  const waId = String(req.params.waId);
  const label = (req.body && req.body.label != null ? String(req.body.label) : '').trim().slice(0, 40);
  try {
    db.prepare(`INSERT INTO whatsapp_threads (wa_id, label, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(wa_id) DO UPDATE SET label = excluded.label, updated_at = CURRENT_TIMESTAMP`).run(waId, label);
    res.json({ ok: true, label });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Broadcast ──
const BROADCAST_DELAY_MS = 1200;
function absoluteUrl(req, u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const row = db.prepare("SELECT value FROM site_settings WHERE key = 'site_url'").get();
  const base = (row && row.value && row.value.trim()) ? row.value.trim().replace(/\/+$/, '') : (req.protocol + '://' + req.get('host'));
  return base + (u.startsWith('/') ? u : '/' + u);
}
function resolveBroadcastRecipients(b) {
  const audience = (b.audience || 'paste').toString();
  let tokens;
  if (audience === 'all') tokens = db.prepare('SELECT wa_id FROM wa_contacts WHERE opted_out = 0').all().map(r => r.wa_id);
  else if (audience === 'tag') {
    const tag = (b.tag || '').toString().trim().toLowerCase();
    if (!tag) return { error: 'Pick a tag/segment to broadcast to.' };
    tokens = db.prepare('SELECT wa_id, tags FROM wa_contacts WHERE opted_out = 0').all()
      .filter(r => (r.tags || '').split(',').map(t => t.trim().toLowerCase()).includes(tag)).map(r => r.wa_id);
  } else tokens = (b.numbers || '').toString().split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(); const recipients = []; let invalid = 0;
  for (const tok of tokens) { const n = whatsapp.normalizePhone(tok); if (!n) { invalid++; continue; } if (seen.has(n)) continue; seen.add(n); recipients.push(n); }
  return { recipients, invalid };
}
function executeBroadcast(broadcastId, recipients, opts) {
  const { template, lang, params, headerImageUrl, preview } = opts;
  try { db.prepare("UPDATE whatsapp_broadcasts SET status = 'running', total = ? WHERE id = ?").run(recipients.length, broadcastId); } catch (_) {}
  (async () => {
    let sent = 0, failed = 0;
    for (const to of recipients) {
      try {
        const contact = db.prepare('SELECT name FROM wa_contacts WHERE wa_id = ?').get(to);
        const firstName = (contact && contact.name && contact.name.trim()) ? contact.name.trim().split(/\s+/)[0] : 'there';
        const personalParams = (params || []).map(p => String(p).replace(/\{name\}/gi, firstName));
        const wamId = await whatsapp.sendTemplate(to, template, lang, personalParams, headerImageUrl);
        sent++;
        whatsapp.saveMessage({ wa_id: to, direction: 'out', body: '[Broadcast] ' + preview, engine: 'broadcast', wam_id: wamId, broadcast_id: broadcastId });
      } catch (e) { failed++; console.error('[BROADCAST] send failed to', to, '-', e.message); }
      try { db.prepare('UPDATE whatsapp_broadcasts SET sent = ?, failed = ? WHERE id = ?').run(sent, failed, broadcastId); } catch (_) {}
      await new Promise(r => setTimeout(r, BROADCAST_DELAY_MS));
    }
    try { db.prepare("UPDATE whatsapp_broadcasts SET status = 'done', sent = ?, failed = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(sent, failed, broadcastId); } catch (_) {}
    console.log(`✓ Broadcast #${broadcastId} done — sent ${sent}, failed ${failed} of ${recipients.length}`);
  })();
}
app.post('/api/admin/whatsapp/broadcast', requireAdmin, (req, res) => {
  if (!whatsapp.isConfigured()) return res.status(400).json({ error: 'WhatsApp is not connected. Add credentials in Settings first.' });
  const b = req.body || {};
  const template = (b.template || '').toString().trim();
  const lang = (b.lang || 'en').toString().trim() || 'en';
  const params = Array.isArray(b.params) ? b.params.filter(x => x != null && String(x).trim() !== '') : [];
  const headerImageUrl = absoluteUrl(req, b.headerImageUrl);
  if (!template) return res.status(400).json({ error: 'Template name is required' });
  const preview = (b.preview || '').toString().slice(0, 200) || `Template: ${template}`;
  const MAX = 5000;
  const scheduledAt = (b.scheduledAt || '').toString().trim();
  if (scheduledAt) {
    const ts = new Date(scheduledAt);
    if (isNaN(ts.getTime())) return res.status(400).json({ error: 'Invalid schedule date/time.' });
    if (ts.getTime() < Date.now() - 60000) return res.status(400).json({ error: 'Schedule time is in the past.' });
    if (b.audience === 'tag' && !(b.tag || '').toString().trim()) return res.status(400).json({ error: 'Pick a tag/segment to broadcast to.' });
    if (!b.audience || b.audience === 'paste') { const chk = resolveBroadcastRecipients(b); if (!chk.recipients.length) return res.status(400).json({ error: 'No valid phone numbers found in the list.' }); }
    const payload = JSON.stringify({ audience: b.audience || 'paste', numbers: b.numbers || '', tag: b.tag || '', template, lang, params, headerImageUrl, preview });
    const info = db.prepare(`INSERT INTO whatsapp_broadcasts (template, lang, preview, total, status, scheduled_at, payload) VALUES (?, ?, ?, 0, 'scheduled', ?, ?)`).run(template, lang, preview, ts.toISOString(), payload);
    return res.json({ ok: true, scheduled: true, broadcastId: info.lastInsertRowid, scheduledAt: ts.toISOString() });
  }
  const { recipients, invalid, error } = resolveBroadcastRecipients(b);
  if (error) return res.status(400).json({ error });
  if (!recipients.length) return res.status(400).json({ error: 'No valid phone numbers found in the list.' });
  if (recipients.length > MAX) return res.status(400).json({ error: `Too many numbers (${recipients.length}). Max ${MAX} per broadcast.` });
  const info = db.prepare(`INSERT INTO whatsapp_broadcasts (template, lang, preview, total, status) VALUES (?, ?, ?, ?, 'running')`).run(template, lang, preview, recipients.length);
  res.json({ ok: true, broadcastId: info.lastInsertRowid, total: recipients.length, invalid });
  executeBroadcast(info.lastInsertRowid, recipients, { template, lang, params, headerImageUrl, preview });
});
app.post('/api/admin/whatsapp/broadcasts/:id/cancel', requireAdmin, (req, res) => {
  try {
    const row = db.prepare('SELECT status FROM whatsapp_broadcasts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled broadcasts can be cancelled.' });
    db.prepare("UPDATE whatsapp_broadcasts SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
setInterval(() => {
  try {
    const due = db.prepare("SELECT id, payload FROM whatsapp_broadcasts WHERE status = 'scheduled' AND scheduled_at <= ?").all(new Date().toISOString());
    for (const row of due) {
      let payload; try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
      const { recipients } = resolveBroadcastRecipients(payload);
      if (!recipients || !recipients.length) { db.prepare("UPDATE whatsapp_broadcasts SET status = 'error', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id); continue; }
      executeBroadcast(row.id, recipients, { template: payload.template, lang: payload.lang, params: payload.params || [], headerImageUrl: payload.headerImageUrl || '', preview: payload.preview || '' });
    }
  } catch (e) { console.error('[SCHEDULER]', e.message); }
  try { processSequences(); } catch (e) { console.error('[SEQUENCES]', e.message); }
}, 60000);

function processSequences() {
  if (!whatsapp.isConfigured()) return;
  const nowIso = new Date().toISOString();
  const seqs = db.prepare("SELECT id, trigger_tag FROM wa_sequences WHERE is_active = 1 AND trigger_tag IS NOT NULL AND trigger_tag <> ''").all();
  for (const s of seqs) {
    const tag = s.trigger_tag.trim().toLowerCase();
    const step0 = db.prepare('SELECT delay_hours FROM wa_sequence_steps WHERE sequence_id = ? ORDER BY step_order, id LIMIT 1').get(s.id);
    if (!step0) continue;
    const contacts = db.prepare('SELECT wa_id, tags FROM wa_contacts WHERE opted_out = 0').all().filter(c => (c.tags || '').split(',').map(t => t.trim().toLowerCase()).includes(tag));
    const ins = db.prepare("INSERT OR IGNORE INTO wa_sequence_enrollments (sequence_id, wa_id, current_step, next_run_at, status) VALUES (?, ?, 0, ?, 'active')");
    for (const c of contacts) { const nextRun = new Date(Date.now() + (Number(step0.delay_hours) || 0) * 3600 * 1000).toISOString(); try { ins.run(s.id, c.wa_id, nextRun); } catch (_) {} }
  }
  const due = db.prepare("SELECT * FROM wa_sequence_enrollments WHERE status = 'active' AND next_run_at <= ?").all(nowIso);
  for (const e of due) {
    const steps = db.prepare('SELECT * FROM wa_sequence_steps WHERE sequence_id = ? ORDER BY step_order, id').all(e.sequence_id);
    const step = steps[e.current_step];
    if (!step) { db.prepare("UPDATE wa_sequence_enrollments SET status = 'done' WHERE id = ?").run(e.id); continue; }
    const contact = db.prepare('SELECT name, opted_out FROM wa_contacts WHERE wa_id = ?').get(e.wa_id);
    if (contact && contact.opted_out) { db.prepare("UPDATE wa_sequence_enrollments SET status = 'stopped' WHERE id = ?").run(e.id); continue; }
    const firstName = (contact && contact.name && contact.name.trim()) ? contact.name.trim().split(/\s+/)[0] : 'there';
    let params = []; try { params = JSON.parse(step.params || '[]'); } catch { params = []; }
    params = params.map(p => String(p).replace(/\{name\}/gi, firstName));
    (async () => {
      try { const wamId = await whatsapp.sendTemplate(e.wa_id, step.template, step.lang || 'en_US', params, step.header_image_url || ''); whatsapp.saveMessage({ wa_id: e.wa_id, direction: 'out', body: '[Sequence] ' + step.template, engine: 'sequence', wam_id: wamId }); }
      catch (err) { console.error('[SEQUENCES] send failed to', e.wa_id, '-', err.message); }
    })();
    const nextIdx = e.current_step + 1;
    if (nextIdx >= steps.length) db.prepare("UPDATE wa_sequence_enrollments SET current_step = ?, status = 'done' WHERE id = ?").run(nextIdx, e.id);
    else { const nextRun = new Date(Date.now() + (Number(steps[nextIdx].delay_hours) || 0) * 3600 * 1000).toISOString(); db.prepare('UPDATE wa_sequence_enrollments SET current_step = ?, next_run_at = ? WHERE id = ?').run(nextIdx, nextRun, e.id); }
  }
}

app.get('/api/admin/whatsapp/spend', requireAdmin, (req, res) => {
  try {
    const rateRow = db.prepare("SELECT value FROM site_settings WHERE key = 'wa_msg_rate'").get();
    const rate = parseFloat(rateRow && rateRow.value) || 0.8;
    const paidWhere = "direction = 'out' AND engine IN ('broadcast','sequence')";
    const total = db.prepare(`SELECT COUNT(*) n FROM whatsapp_messages WHERE ${paidWhere}`).get().n || 0;
    const month = db.prepare(`SELECT COUNT(*) n FROM whatsapp_messages WHERE ${paidWhere} AND created_at >= date('now','start of month')`).get().n || 0;
    const free = db.prepare("SELECT COUNT(*) n FROM whatsapp_messages WHERE direction = 'out' AND (engine IS NULL OR engine NOT IN ('broadcast','sequence'))").get().n || 0;
    res.json({ rate, paidTotal: total, paidMonth: month, freeTotal: free, estTotal: +(total * rate).toFixed(2), estMonth: +(month * rate).toFixed(2) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/whatsapp/analytics', requireAdmin, (req, res) => {
  try {
    const W = "direction = 'out' AND engine IN ('broadcast','sequence')";
    const cnt = (extra) => (db.prepare(`SELECT COUNT(*) n FROM whatsapp_messages WHERE ${W}${extra ? ' AND ' + extra : ''}`).get().n || 0);
    const sent = cnt(''), delivered = cnt("status IN ('delivered','read')"), read = cnt("status = 'read'"), failed = cnt("status = 'failed'");
    const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
    const overall = { sent, delivered, read, failed, deliveryRate: pct(delivered, sent), readRate: pct(read, sent), failRate: pct(failed, sent) };
    const rows = db.prepare(`SELECT date(created_at) d, COUNT(*) n FROM whatsapp_messages WHERE ${W} AND created_at >= date('now','-13 days') GROUP BY d`).all();
    const byDay = {}; rows.forEach(r => { byDay[r.d] = r.n; });
    const daily = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); daily.push({ date: d, count: byDay[d] || 0 }); }
    const bcs = db.prepare("SELECT id, template, preview, total, sent, failed, status, created_at FROM whatsapp_broadcasts ORDER BY id DESC LIMIT 20").all();
    const campaigns = bcs.map(b => {
      const sc = db.prepare('SELECT status, COUNT(*) n FROM whatsapp_messages WHERE broadcast_id = ? GROUP BY status').all(b.id);
      const m = {}; sc.forEach(r => { m[r.status || 'sent'] = r.n; });
      const d = (m.delivered || 0) + (m.read || 0);
      return { id: b.id, template: b.template, preview: b.preview, status: b.status, created_at: b.created_at, total: b.total, sent: b.sent, delivered: d, read: m.read || 0, failed: (m.failed || 0) || b.failed || 0 };
    });
    res.json({ overall, daily, campaigns });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/whatsapp/broadcasts', requireAdmin, (req, res) => {
  try { res.json({ broadcasts: db.prepare('SELECT id, template, lang, preview, total, sent, failed, status, scheduled_at, created_at, finished_at FROM whatsapp_broadcasts ORDER BY id DESC LIMIT 30').all() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Templates ──
app.get('/api/admin/whatsapp/templates', requireAdmin, async (req, res) => { try { res.json({ templates: await whatsapp.listTemplates() }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/admin/whatsapp/templates', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const result = await whatsapp.createTemplate({ name: b.name, category: b.category, language: b.language, bodyText: b.bodyText, footerText: b.footerText, headerImageUrl: absoluteUrl(req, b.headerImageUrl), examples: Array.isArray(b.examples) ? b.examples : [] });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/admin/whatsapp/templates/:name', requireAdmin, async (req, res) => { try { await whatsapp.deleteTemplate(req.params.name); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

// ── Contacts ──
app.get('/api/admin/whatsapp/contacts', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, wa_id, name, tags, notes, opted_out, source, created_at FROM wa_contacts ORDER BY id DESC').all();
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const tag = (req.query.tag || '').toString().trim().toLowerCase();
    let contacts = rows;
    if (q) contacts = contacts.filter(c => (c.name || '').toLowerCase().includes(q) || (c.wa_id || '').includes(q) || (c.tags || '').toLowerCase().includes(q));
    if (tag) contacts = contacts.filter(c => (c.tags || '').split(',').map(t => t.trim().toLowerCase()).includes(tag));
    const tagCounts = {};
    for (const c of rows) for (const t of (c.tags || '').split(',').map(s => s.trim()).filter(Boolean)) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const tags = Object.entries(tagCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    res.json({ contacts, tags, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/whatsapp/contacts', requireAdmin, (req, res) => {
  const b = req.body || {};
  const wa = whatsapp.normalizePhone(b.wa_id || b.phone || '');
  if (!wa) return res.status(400).json({ error: 'A valid phone number is required.' });
  const name = (b.name || '').toString().trim().slice(0, 120);
  const tags = (b.tags || '').toString().split(',').map(t => t.trim()).filter(Boolean).join(', ').slice(0, 300);
  const notes = (b.notes || '').toString().trim().slice(0, 500);
  const optedOut = b.opted_out ? 1 : 0;
  try {
    db.prepare(`INSERT INTO wa_contacts (wa_id, name, tags, notes, opted_out, source) VALUES (?, ?, ?, ?, ?, 'manual') ON CONFLICT(wa_id) DO UPDATE SET name = excluded.name, tags = excluded.tags, notes = excluded.notes, opted_out = excluded.opted_out, updated_at = CURRENT_TIMESTAMP`).run(wa, name, tags, notes, optedOut);
    res.json(db.prepare('SELECT * FROM wa_contacts WHERE wa_id = ?').get(wa));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/whatsapp/contacts/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Contact not found' });
  const name = (b.name ?? existing.name ?? '').toString().trim().slice(0, 120);
  const tags = (b.tags ?? existing.tags ?? '').toString().split(',').map(t => t.trim()).filter(Boolean).join(', ').slice(0, 300);
  const notes = (b.notes ?? existing.notes ?? '').toString().trim().slice(0, 500);
  const optedOut = (b.opted_out != null ? (b.opted_out ? 1 : 0) : existing.opted_out);
  try {
    db.prepare('UPDATE wa_contacts SET name = ?, tags = ?, notes = ?, opted_out = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, tags, notes, optedOut, req.params.id);
    res.json(db.prepare('SELECT * FROM wa_contacts WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/whatsapp/contacts/:id', requireAdmin, (req, res) => { try { db.prepare('DELETE FROM wa_contacts WHERE id = ?').run(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/whatsapp/contacts/import', requireAdmin, (req, res) => {
  const b = req.body || {};
  const tags = (b.tags || '').toString().split(',').map(t => t.trim()).filter(Boolean).join(', ').slice(0, 300);
  const tokens = (b.numbers || '').toString().split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  let added = 0, updated = 0, invalid = 0;
  const upsert = db.prepare(`INSERT INTO wa_contacts (wa_id, name, tags, source) VALUES (?, ?, ?, 'import') ON CONFLICT(wa_id) DO UPDATE SET tags = CASE WHEN excluded.tags = '' THEN wa_contacts.tags WHEN wa_contacts.tags = '' THEN excluded.tags ELSE wa_contacts.tags || ', ' || excluded.tags END, updated_at = CURRENT_TIMESTAMP`);
  const seen = new Set(); db.exec('BEGIN');
  try {
    for (const tok of tokens) { const wa = whatsapp.normalizePhone(tok); if (!wa) { invalid++; continue; } if (seen.has(wa)) continue; seen.add(wa); const before = db.prepare('SELECT 1 FROM wa_contacts WHERE wa_id = ?').get(wa); upsert.run(wa, '', tags); if (before) updated++; else added++; }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, added, updated, invalid });
});
app.get('/api/admin/whatsapp/contacts/export', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT name, wa_id, tags, opted_out FROM wa_contacts ORDER BY id DESC').all();
    const esc = v => { v = (v == null ? '' : String(v)); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = ['name,phone,tags,opted_out'];
    for (const r of rows) lines.push([esc(r.name), esc(r.wa_id), esc(r.tags), r.opted_out ? '1' : '0'].join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/whatsapp/contacts/import-csv', requireAdmin, (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No CSV file received' });
    const text = req.file.buffer.toString('utf8');
    const parseLine = (line) => { const out = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; } else { if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } } out.push(cur); return out; };
    const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let added = 0, updated = 0, invalid = 0;
    const upsert = db.prepare(`INSERT INTO wa_contacts (wa_id, name, tags, source) VALUES (?, ?, ?, 'import') ON CONFLICT(wa_id) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE wa_contacts.name END, tags = CASE WHEN excluded.tags = '' THEN wa_contacts.tags WHEN wa_contacts.tags = '' THEN excluded.tags ELSE wa_contacts.tags || ', ' || excluded.tags END, updated_at = CURRENT_TIMESTAMP`);
    db.exec('BEGIN');
    try {
      for (let i = 0; i < rows.length; i++) {
        const cols = parseLine(rows[i]);
        const name = (cols[0] || '').trim(), phoneRaw = (cols[1] || '').trim();
        const tags = (cols[2] || '').split(/[,;]/).map(t => t.trim()).filter(Boolean).join(', ');
        if (i === 0 && !/\d/.test(phoneRaw)) continue;
        const wa = whatsapp.normalizePhone(phoneRaw); if (!wa) { invalid++; continue; }
        const before = db.prepare('SELECT 1 FROM wa_contacts WHERE wa_id = ?').get(wa);
        upsert.run(wa, name.slice(0, 120), tags.slice(0, 300));
        if (before) updated++; else added++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, added, updated, invalid });
  });
});

// ── Quick replies ──
app.get('/api/admin/whatsapp/quick-replies', requireAdmin, (req, res) => { try { res.json({ quickReplies: db.prepare('SELECT id, title, body FROM wa_quick_replies ORDER BY sort_order, id').all() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/whatsapp/quick-replies', requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').toString().trim().slice(0, 60), body = (b.body || '').toString().trim().slice(0, 1000);
  if (!title || !body) return res.status(400).json({ error: 'Title and message are both required.' });
  try { const info = db.prepare('INSERT INTO wa_quick_replies (title, body) VALUES (?, ?)').run(title, body); res.json(db.prepare('SELECT id, title, body FROM wa_quick_replies WHERE id = ?').get(info.lastInsertRowid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/whatsapp/quick-replies/:id', requireAdmin, (req, res) => { try { db.prepare('DELETE FROM wa_quick_replies WHERE id = ?').run(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ── Sequences ──
function saveSequenceSteps(sequenceId, steps) {
  db.prepare('DELETE FROM wa_sequence_steps WHERE sequence_id = ?').run(sequenceId);
  const ins = db.prepare('INSERT INTO wa_sequence_steps (sequence_id, step_order, delay_hours, template, lang, params, header_image_url) VALUES (?, ?, ?, ?, ?, ?, ?)');
  (Array.isArray(steps) ? steps : []).forEach((s, i) => { const template = (s.template || '').toString().trim(); if (!template) return; ins.run(sequenceId, i, Number(s.delay_hours) || 0, template, (s.lang || 'en_US').toString(), JSON.stringify(Array.isArray(s.params) ? s.params : []), (s.header_image_url || '').toString()); });
}
app.get('/api/admin/whatsapp/sequences', requireAdmin, (req, res) => {
  try {
    const seqs = db.prepare('SELECT id, name, trigger_tag, is_active, created_at FROM wa_sequences ORDER BY id DESC').all();
    const out = seqs.map(s => ({ ...s, steps: db.prepare('SELECT step_order, delay_hours, template, lang, params, header_image_url FROM wa_sequence_steps WHERE sequence_id = ? ORDER BY step_order, id').all(s.id).map(st => ({ ...st, params: (() => { try { return JSON.parse(st.params || '[]'); } catch { return []; } })() })), enrolled: (db.prepare("SELECT COUNT(*) n FROM wa_sequence_enrollments WHERE sequence_id = ? AND status = 'active'").get(s.id) || {}).n || 0 }));
    res.json({ sequences: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/whatsapp/sequences', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').toString().trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Sequence name is required' });
  try { const info = db.prepare("INSERT INTO wa_sequences (name, trigger_tag, is_active) VALUES (?, ?, 1)").run(name, (b.trigger_tag || '').toString().trim().slice(0, 60)); saveSequenceSteps(info.lastInsertRowid, b.steps); res.json({ ok: true, id: info.lastInsertRowid }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/whatsapp/sequences/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM wa_sequences WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Sequence not found' });
  try {
    db.prepare('UPDATE wa_sequences SET name = ?, trigger_tag = ?, is_active = ? WHERE id = ?').run((b.name ?? existing.name).toString().trim().slice(0, 80), (b.trigger_tag ?? existing.trigger_tag ?? '').toString().trim().slice(0, 60), (b.is_active != null ? (b.is_active ? 1 : 0) : existing.is_active), req.params.id);
    if (Array.isArray(b.steps)) saveSequenceSteps(req.params.id, b.steps);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/whatsapp/sequences/:id', requireAdmin, (req, res) => {
  try { db.prepare('DELETE FROM wa_sequence_steps WHERE sequence_id = ?').run(req.params.id); db.prepare('DELETE FROM wa_sequence_enrollments WHERE sequence_id = ?').run(req.params.id); db.prepare('DELETE FROM wa_sequences WHERE id = ?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/whatsapp/sequences/:id/enroll', requireAdmin, (req, res) => {
  const seq = db.prepare('SELECT id FROM wa_sequences WHERE id = ?').get(req.params.id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  const step0 = db.prepare('SELECT delay_hours FROM wa_sequence_steps WHERE sequence_id = ? ORDER BY step_order, id LIMIT 1').get(req.params.id);
  if (!step0) return res.status(400).json({ error: 'Add at least one step before enrolling.' });
  const { recipients } = resolveBroadcastRecipients(req.body || {});
  if (!recipients || !recipients.length) return res.status(400).json({ error: 'No valid recipients to enroll.' });
  let enrolled = 0;
  const ins = db.prepare("INSERT OR IGNORE INTO wa_sequence_enrollments (sequence_id, wa_id, current_step, next_run_at, status) VALUES (?, ?, 0, ?, 'active')");
  for (const wa of recipients) { const nextRun = new Date(Date.now() + (Number(step0.delay_hours) || 0) * 3600 * 1000).toISOString(); const info = ins.run(req.params.id, wa, nextRun); if (info.changes) enrolled++; }
  res.json({ ok: true, enrolled });
});
app.get('/api/admin/whatsapp/backfill-inbound-tags', requireAdmin, (req, res) => {
  try { const info = db.prepare("UPDATE wa_contacts SET tags = 'WhatsApp Direct', updated_at = CURRENT_TIMESTAMP WHERE source = 'inbound' AND (tags IS NULL OR tags = '')").run(); res.json({ ok: true, tagged: info.changes }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/whatsapp/upload-image', requireAuth, (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      let outBuf, filename, mimetype = 'image/jpeg';
      if (sharp && RASTER_MIMES.includes(req.file.mimetype)) {
        outBuf = await sharp(req.file.buffer).rotate().resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
        filename = buildUploadName(req.file.originalname, '.jpg');
      } else if (req.file.mimetype === 'image/png' || req.file.mimetype === 'image/jpeg') {
        outBuf = req.file.buffer; filename = buildUploadName(req.file.originalname); mimetype = req.file.mimetype;
      } else return res.status(400).json({ error: 'Banner must be a JPG or PNG image.' });
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), outBuf);
      res.json({ url: `/uploads/${filename}`, filename, size: outBuf.length, mimetype });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// ════════════════ META / FACEBOOK LEAD ADS ════════════════
app.get('/api/admin/fb/connect', requireAdmin, (req, res) => {
  if (!fbLeads.isConfigured()) return res.status(400).send('Add your Meta App ID and App Secret in Settings first.');
  res.redirect(fbLeads.loginUrl(absoluteUrl(req, '/api/admin/fb/callback'), 'leadflow'));
});
app.get('/api/admin/fb/callback', requireAdmin, async (req, res) => {
  const code = (req.query.code || '').toString();
  if (!code) return res.redirect('/admin/?fb=error#whatsapp');
  try {
    const redirectUri = absoluteUrl(req, '/api/admin/fb/callback');
    const userToken = await fbLeads.exchangeCode(code, redirectUri);
    const longToken = await fbLeads.longLived(userToken);
    const pages = await fbLeads.listPages(longToken);
    for (const p of pages) { try { await fbLeads.subscribePage(p.id, p.access_token); p._subscribed = true; } catch (e) { p._subscribed = false; console.error('[FB] subscribe', p.name, '-', e.message); } }
    fbLeads.savePages(pages);
    res.redirect('/admin/?fb=connected&pages=' + pages.length + '#whatsapp');
  } catch (e) { console.error('[FB callback]', e.message); res.redirect('/admin/?fb=error&msg=' + encodeURIComponent(e.message) + '#whatsapp'); }
});
// ── One-click WhatsApp connect ──
// One Facebook login pulls the WABA ID, Phone Number ID and a long-lived
// token, auto-generates a verify token, subscribes the WABA + app webhook,
// and connects lead-ads Pages too. User only needs App ID + Secret saved.
app.get('/api/admin/wa/connect', requireAdmin, (req, res) => {
  if (!fbLeads.isConfigured()) return res.status(400).send('Add your Meta App ID and App Secret in Settings first, then retry.');
  res.redirect(fbLeads.waLoginUrl(absoluteUrl(req, '/api/admin/wa/callback'), 'waconnect'));
});
app.get('/api/admin/wa/callback', requireAdmin, async (req, res) => {
  const fail = (msg) => res.redirect('/admin/?waconnect=error&msg=' + encodeURIComponent(msg) + '#settings');
  const code = (req.query.code || '').toString();
  if (!code) return fail((req.query.error_description || 'Facebook login was cancelled.').toString());
  const saveSetting = (k, v) => db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(k, String(v));
  try {
    const redirectUri = absoluteUrl(req, '/api/admin/wa/callback');
    const userToken = await fbLeads.exchangeCode(code, redirectUri);
    const longToken = await fbLeads.longLived(userToken);

    const wabas = await fbLeads.listWabas(longToken);
    if (!wabas.length) return fail('No WhatsApp Business Account found for this Facebook user. Open your Meta app → WhatsApp → API Setup once (it creates the WABA), then retry.');
    const waba = wabas[0];
    const phones = await fbLeads.listWabaPhones(waba.id, longToken);
    if (!phones.length) return fail('Your WhatsApp Business Account has no phone numbers yet. Add one in Meta app → WhatsApp → API Setup, then retry.');
    const phone = phones[0];

    let verifyToken = ((db.prepare("SELECT value FROM site_settings WHERE key = 'whatsapp_verify_token'").get() || {}).value || '').trim();
    if (!verifyToken) { verifyToken = crypto.randomBytes(8).toString('hex'); saveSetting('whatsapp_verify_token', verifyToken); }

    saveSetting('whatsapp_token', longToken);
    saveSetting('whatsapp_waba_id', waba.id);
    saveSetting('whatsapp_phone_id', phone.id);

    try { await fbLeads.subscribeWaba(waba.id, longToken); } catch (e) { console.error('[WA CONNECT] WABA subscribe:', e.message); }
    let webhookOk = false;
    try { await fbLeads.setAppWebhook(absoluteUrl(req, '/api/whatsapp/webhook'), verifyToken); webhookOk = true; }
    catch (e) { console.error('[WA CONNECT] webhook auto-config:', e.message); }

    let pageCount = 0;
    try {
      const pages = await fbLeads.listPages(longToken);
      for (const p of pages) { try { await fbLeads.subscribePage(p.id, p.access_token); p._subscribed = true; } catch (_) { p._subscribed = false; } }
      fbLeads.savePages(pages); pageCount = pages.length;
    } catch (e) { console.error('[WA CONNECT] pages:', e.message); }

    console.log(`✓ One-click connect: WABA ${waba.id}, phone ${phone.display_phone_number || phone.id}, webhook ${webhookOk ? 'auto' : 'manual'}, ${pageCount} page(s)`);
    res.redirect('/admin/?waconnect=ok&phone=' + encodeURIComponent(phone.display_phone_number || '') + '&pages=' + pageCount + '&webhook=' + (webhookOk ? 'ok' : 'manual') + '#settings');
  } catch (e) { console.error('[WA CONNECT]', e.message); return fail(e.message); }
});

app.get('/api/admin/fb/status', requireAdmin, (req, res) => { try { const pages = fbLeads.connectedPages(); res.json({ configured: fbLeads.isConfigured(), count: pages.length, pages }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/fb/disconnect', requireAdmin, (req, res) => { try { fbLeads.disconnectAll(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/admin/fb/debug', requireAdmin, async (req, res) => {
  try {
    const pages = [];
    for (const p of fbLeads.connectedPages()) {
      const token = fbLeads.pageToken(p.page_id); let liveFields = null, liveError = null;
      if (token) { try { const subs = await fbLeads.getPageSubscriptions(p.page_id, token); liveFields = subs.flatMap(s => s.subscribed_fields || []); } catch (e) { liveError = e.message; } }
      pages.push({ page_id: p.page_id, name: p.name, subscribed_in_db: p.subscribed, has_token: !!token, live_subscribed_fields: liveFields, live_error: liveError });
    }
    res.json({ configured: fbLeads.isConfigured(), pages, recentWebhooks: recentLeadgen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
async function importFbLeads(sinceEpoch = 0, perForm = 1000) {
  const result = { pages: 0, forms: 0, leadsSeen: 0, contactsAdded: 0, leadsAdded: 0, errors: [] };
  const upsertContact = db.prepare(`INSERT INTO wa_contacts (wa_id, name, tags, source) VALUES (?, ?, ?, 'meta_lead') ON CONFLICT(wa_id) DO UPDATE SET name = CASE WHEN (wa_contacts.name IS NULL OR wa_contacts.name = '') THEN excluded.name ELSE wa_contacts.name END, tags = CASE WHEN wa_contacts.tags IS NULL OR wa_contacts.tags = '' THEN excluded.tags WHEN (',' || lower(replace(wa_contacts.tags,' ','')) || ',') LIKE ('%,' || lower(replace(excluded.tags,' ','')) || ',%') THEN wa_contacts.tags ELSE wa_contacts.tags || ', ' || excluded.tags END, updated_at = CURRENT_TIMESTAMP`);
  const existsLead = db.prepare("SELECT 1 FROM leads WHERE phone = ? AND source = 'meta_lead' LIMIT 1");
  const insLead = db.prepare("INSERT INTO leads (name, phone, email, message, source, user_agent) VALUES (?, ?, ?, ?, 'meta_lead', 'meta-lead-ads')");
  for (const p of fbLeads.connectedPages()) {
    const token = fbLeads.pageToken(p.page_id); if (!token) continue; result.pages++;
    let forms; try { forms = await fbLeads.listForms(p.page_id, token); } catch (e) { result.errors.push('forms[' + p.name + ']: ' + e.message); continue; }
    for (const form of forms) {
      result.forms++; let leads;
      try { leads = await fbLeads.listFormLeads(form.id, token, perForm, sinceEpoch); } catch (e) { result.errors.push('leads[' + (form.name || form.id) + ']: ' + e.message); continue; }
      for (const lead of leads) {
        result.leadsSeen++;
        const f = fbLeads.parseLeadFields(lead.field_data);
        const campaign = (lead.campaign_name || lead.ad_name || form.name || 'Meta Lead').toString().slice(0, 60);
        const wa = whatsapp.normalizePhone(f.phone); const phoneVal = f.phone || (wa || '');
        try { if (phoneVal && !existsLead.get(phoneVal)) { insLead.run(f.name || null, phoneVal, f.email || null, 'Campaign: ' + campaign); result.leadsAdded++; } } catch (_) {}
        if (wa) { try { upsertContact.run(wa, f.name || '', campaign); result.contactsAdded++; } catch (_) {} }
      }
    }
  }
  return result;
}
app.get('/api/admin/fb/import-existing', requireAdmin, async (req, res) => { try { res.json(await importFbLeads(0, 1000)); } catch (e) { res.status(500).json({ error: e.message }); } });
function fbLastPoll() { const r = db.prepare("SELECT value FROM site_settings WHERE key = 'fb_leads_last_poll'").get(); const v = r && parseInt(r.value, 10); return v && !isNaN(v) ? v : Math.floor(Date.now() / 1000) - 3600; }
function setFbLastPoll(epoch) { db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('fb_leads_last_poll', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(String(epoch)); }
setInterval(async () => {
  try {
    if (!fbLeads.isConfigured() || !fbLeads.connectedPages().length) return;
    const since = fbLastPoll() - 120; const startedAt = Math.floor(Date.now() / 1000);
    const r = await importFbLeads(since, 200); setFbLastPoll(startedAt);
    if (r.contactsAdded || r.leadsAdded) console.log(`✓ Meta auto-poll: +${r.leadsAdded} leads, +${r.contactsAdded} contacts`);
  } catch (e) { console.error('[FB AUTO-POLL]', e.message); }
}, 5 * 60 * 1000);
app.get('/api/admin/fb/resubscribe', requireAdmin, async (req, res) => {
  const out = [];
  for (const p of fbLeads.connectedPages()) { const token = fbLeads.pageToken(p.page_id); if (!token) { out.push({ page: p.name, ok: false, error: 'no stored token' }); continue; } try { const r = await fbLeads.subscribePage(p.page_id, token); out.push({ page: p.name, ok: true, result: r }); } catch (e) { out.push({ page: p.name, ok: false, error: e.message }); } }
  res.json({ resubscribed: out });
});

// ════════════════ LEADS ADMIN ════════════════
app.get('/api/admin/leads', requireAdmin, requireLeadsUnlock, (req, res) => {
  const { source, unread } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500), offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = [], params = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (unread === '1') where.push('is_read = 0');
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare('SELECT * FROM leads' + whereSql + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
  const filtered = db.prepare('SELECT COUNT(*) AS c FROM leads' + whereSql).get(...params).c;
  const unread_count = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE is_read = 0').get().c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  res.json({ leads: rows, unread_count, total, filtered, limit, offset });
});
app.put('/api/admin/leads/:id/read', requireAdmin, requireLeadsUnlock, (req, res) => {
  const isRead = req.body && req.body.is_read === 0 ? 0 : 1;
  const result = db.prepare('UPDATE leads SET is_read = ? WHERE id = ?').run(isRead, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, is_read: isRead });
});
app.post('/api/admin/leads/mark-all-read', requireAdmin, requireLeadsUnlock, (req, res) => { const result = db.prepare('UPDATE leads SET is_read = 1 WHERE is_read = 0').run(); res.json({ ok: true, updated: result.changes }); });
function csvEscape(v) { if (v == null) return ''; const s = String(v); return (/[",\n\r]/.test(s) || s !== s.trim()) ? '"' + s.replace(/"/g, '""') + '"' : s; }
app.get('/api/admin/leads/export', requireAdmin, requireLeadsUnlock, (req, res) => {
  const { source, unread } = req.query;
  let sql = 'SELECT * FROM leads'; const where = [], params = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (unread === '1') where.push('is_read = 0');
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  const headers = ['ID', 'Received', 'Name', 'Phone', 'Email', 'Interested In', 'Source', 'Message', 'Read', 'IP'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push([r.id, r.created_at, r.name, r.phone, r.email, r.interested_in, r.source, r.message, r.is_read ? 'Yes' : 'No', r.ip].map(csvEscape).join(','));
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${stamp}.csv"`);
  res.send(csv);
});
app.delete('/api/admin/leads/:id', requireAdmin, requireLeadsUnlock, (req, res) => { const result = db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id); if (result.changes === 0) return res.status(404).json({ error: 'Not found' }); res.json({ ok: true }); });
app.get('/api/admin/leads/dedupe-whatsapp', requireAdmin, requireLeadsUnlock, (req, res) => {
  try { const info = db.prepare(`DELETE FROM leads WHERE source = 'whatsapp' AND id NOT IN (SELECT MAX(id) FROM leads WHERE source = 'whatsapp' GROUP BY phone)`).run(); res.json({ ok: true, removed: info.changes }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════ SETTINGS ════════════════
const SECRET_SETTING_KEYS = new Set(['gemini_api_key', 'groq_api_key', 'anthropic_api_key', 'email_app_password', 'whatsapp_token', 'whatsapp_app_secret', 'leads_password', 'whatsapp_password']);
app.get('/api/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const settings = {};
  for (const r of rows) { if (SECRET_SETTING_KEYS.has(r.key)) settings[r.key + '_set'] = !!(r.value && String(r.value).trim()); else settings[r.key] = r.value; }
  res.json(settings);
});
app.put('/api/settings', requireAdmin, (req, res) => {
  const updates = req.body || {};
  if (typeof updates !== 'object') return res.status(400).json({ error: 'Body must be an object' });
  const upsert = db.prepare('INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP');
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(updates)) {
      if (k === 'leads_password' || k === 'whatsapp_password') continue;
      if (SECRET_SETTING_KEYS.has(k) && (v == null || String(v).trim() === '')) continue;
      upsert.run(k, String(v ?? ''));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  try { aiAssistant.invalidateKb(); } catch (_) {}
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const settings = {};
  for (const r of rows) { if (SECRET_SETTING_KEYS.has(r.key)) settings[r.key + '_set'] = !!(r.value && String(r.value).trim()); else settings[r.key] = r.value; }
  res.json({ ok: true, settings });
});

// ════════════════ UPLOADS ════════════════
app.post('/api/admin/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try { const saved = await persistUpload(req.file); res.json({ url: `/uploads/${saved.filename}`, filename: saved.filename, size: saved.size, mimetype: saved.mimetype }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
});
app.get('/api/admin/uploads', requireAuth, (req, res) => {
  try {
    const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => { const stat = fs.statSync(path.join(UPLOAD_DIR, e.name)); return { filename: e.name, url: `/uploads/${e.name}`, size: stat.size, modified: stat.mtime }; })
      .sort((a, b) => b.modified - a.modified);
    res.json(entries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/uploads/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) return res.status(400).json({ error: 'Invalid filename' });
  try { fs.unlinkSync(filePath); res.json({ ok: true }); }
  catch (e) { if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' }); res.status(500).json({ error: e.message }); }
});

// ════════════════ STATIC + ADMIN UI ════════════════
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.listen(PORT, () => console.log(`✓ LeadFlow running on http://localhost:${PORT}  (admin: /admin)`));
