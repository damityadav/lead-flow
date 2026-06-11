'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Facebook Lead Ads integration.
//
// Connects Pages via Facebook Login, stores never-expiring Page tokens, and
// subscribes each Page to the `leadgen` webhook. When someone submits an
// Instant Form on a Meta ad, the webhook fires; we fetch the lead and route it
// into wa_contacts (tagged with the campaign name) + the leads table.
//
// Credentials live in site_settings:
//   whatsapp_app_id      Meta App ID (shared with WhatsApp)
//   whatsapp_app_secret  Meta App Secret (needed for the OAuth token exchange)
// ─────────────────────────────────────────────────────────────────────────
const { db } = require('../db');

const GRAPH = 'https://graph.facebook.com/v21.0';
const SCOPES = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata'];
// One-click WhatsApp connect asks for everything in a single login:
// lead-ads scopes above + WhatsApp Business management/messaging.
const WA_SCOPES = SCOPES.concat(['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management']);

function getCfg() {
  const rows = db.prepare("SELECT key, value FROM site_settings WHERE key IN ('whatsapp_app_id','whatsapp_app_secret','fb_config_id')").all();
  const c = {}; for (const r of rows) c[r.key] = r.value;
  return c;
}
function isConfigured() {
  const c = getCfg();
  return !!(c.whatsapp_app_id && c.whatsapp_app_secret);
}

// Build the Facebook Login dialog URL the admin is redirected to.
// The OAuth *dialog* lives on www.facebook.com (NOT graph.facebook.com).
// New Business-type Meta apps reject the classic `scope` param ("Invalid
// Scopes") — they require a Facebook Login for Business *configuration*,
// passed as config_id. When fb_config_id is saved we use that; otherwise we
// fall back to plain scopes (works on older/Consumer apps).
function dialogUrl(redirectUri, state, scopes) {
  const c = getCfg();
  let url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(c.whatsapp_app_id)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state || '')}&response_type=code`;
  if (c.fb_config_id && String(c.fb_config_id).trim()) url += `&config_id=${encodeURIComponent(String(c.fb_config_id).trim())}`;
  else url += `&scope=${encodeURIComponent(scopes.join(','))}`;
  return url;
}
function loginUrl(redirectUri, state) { return dialogUrl(redirectUri, state, SCOPES); }
function waLoginUrl(redirectUri, state) { return dialogUrl(redirectUri, state, WA_SCOPES); }

async function exchangeCode(code, redirectUri) {
  const c = getCfg();
  const url = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(c.whatsapp_app_id)}`
    + `&client_secret=${encodeURIComponent(c.whatsapp_app_secret)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`;
  const r = await fetch(url); const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error((d.error && d.error.message) || 'Token exchange failed');
  return d.access_token;
}

// Short-lived user token → long-lived (~60d). Page tokens derived from a
// long-lived user token do not expire.
async function longLived(userToken) {
  const c = getCfg();
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token`
    + `&client_id=${encodeURIComponent(c.whatsapp_app_id)}&client_secret=${encodeURIComponent(c.whatsapp_app_secret)}`
    + `&fb_exchange_token=${encodeURIComponent(userToken)}`;
  const r = await fetch(url); const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error((d.error && d.error.message) || 'Long-lived exchange failed');
  return d.access_token;
}

async function listPages(userToken) {
  let pages = [];
  let url = `${GRAPH}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`;
  while (url) {
    const r = await fetch(url); const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || 'Failed to list pages');
    pages = pages.concat(d.data || []);
    url = d.paging && d.paging.next ? d.paging.next : null;
  }
  return pages;
}

async function subscribePage(pageId, pageToken) {
  const url = `${GRAPH}/${pageId}/subscribed_apps`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribed_fields: ['leadgen'], access_token: pageToken })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'subscribe failed');
  return d;
}

// What the page is actually subscribed to on Meta's side (to verify leadgen).
async function getPageSubscriptions(pageId, pageToken) {
  const url = `${GRAPH}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`;
  const r = await fetch(url); const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'subscribed_apps fetch failed');
  return d.data || [];
}

// List a page's lead forms.
async function listForms(pageId, pageToken) {
  let forms = [];
  let url = `${GRAPH}/${pageId}/leadgen_forms?fields=id,name&limit=100&access_token=${encodeURIComponent(pageToken)}`;
  while (url) {
    const r = await fetch(url); const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || 'list forms failed');
    forms = forms.concat(d.data || []);
    url = d.paging && d.paging.next ? d.paging.next : null;
    if (forms.length >= 500) break;
  }
  return forms;
}

// List existing (historical) leads for a form, up to `max`. When `sinceEpoch`
// (unix seconds) is given, only leads created after that time are returned —
// used by the 5-minute auto-poll so each run is small and fast.
async function listFormLeads(formId, pageToken, max = 500, sinceEpoch = 0) {
  let leads = [];
  let url = `${GRAPH}/${formId}/leads?fields=created_time,field_data,campaign_name,ad_name,form_name&limit=100&access_token=${encodeURIComponent(pageToken)}`;
  if (sinceEpoch) {
    url += '&filtering=' + encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(sinceEpoch) }]));
  }
  while (url && leads.length < max) {
    const r = await fetch(url); const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || 'list leads failed');
    leads = leads.concat(d.data || []);
    url = d.paging && d.paging.next ? d.paging.next : null;
  }
  return leads;
}

async function fetchLead(leadgenId, pageToken) {
  const url = `${GRAPH}/${encodeURIComponent(leadgenId)}?fields=field_data,campaign_name,ad_name,form_name,created_time&access_token=${encodeURIComponent(pageToken)}`;
  const r = await fetch(url); const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'fetch lead failed');
  return d;
}

// ── One-click WhatsApp connect helpers ──
async function gget(url) {
  const r = await fetch(url); const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
  return d;
}

// Find every WABA the logged-in user can manage: via their Businesses first,
// then fall back to the token's granular scopes (covers direct WABA grants).
async function listWabas(userToken) {
  const found = new Map();
  try {
    const biz = await gget(`${GRAPH}/me/businesses?fields=id,name&limit=100&access_token=${encodeURIComponent(userToken)}`);
    for (const b of (biz.data || [])) {
      for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
        try {
          const d = await gget(`${GRAPH}/${b.id}/${edge}?fields=id,name&limit=100&access_token=${encodeURIComponent(userToken)}`);
          for (const w of (d.data || [])) found.set(w.id, { id: w.id, name: w.name || '' });
        } catch (_) {}
      }
    }
  } catch (_) {}
  if (!found.size) {
    try {
      const c = getCfg();
      const d = await gget(`${GRAPH}/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(c.whatsapp_app_id + '|' + c.whatsapp_app_secret)}`);
      for (const g of (((d.data || {}).granular_scopes) || [])) {
        if (g.scope === 'whatsapp_business_management') for (const id of (g.target_ids || [])) found.set(String(id), { id: String(id), name: '' });
      }
    } catch (_) {}
  }
  return [...found.values()];
}

async function listWabaPhones(wabaId, token) {
  const d = await gget(`${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`);
  return d.data || [];
}

// Subscribe this app to the WABA so message webhooks fire for it.
async function subscribeWaba(wabaId, token) {
  const r = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: token })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'WABA subscribe failed');
  return d;
}

// Point the Meta app's whatsapp_business_account webhook at our server.
// Meta verifies the callback with a GET ping, so the URL must be public HTTPS
// and the verify token must already be saved before calling this.
async function setAppWebhook(callbackUrl, verifyToken) {
  const c = getCfg();
  const r = await fetch(`${GRAPH}/${encodeURIComponent(c.whatsapp_app_id)}/subscriptions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account', callback_url: callbackUrl,
      verify_token: verifyToken, fields: 'messages',
      access_token: c.whatsapp_app_id + '|' + c.whatsapp_app_secret
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'webhook subscription failed');
  return d;
}

function savePages(pages) {
  const up = db.prepare(
    `INSERT INTO fb_pages (page_id, name, access_token, subscribed, connected_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(page_id) DO UPDATE SET name = excluded.name, access_token = excluded.access_token,
       subscribed = excluded.subscribed, connected_at = CURRENT_TIMESTAMP`
  );
  for (const p of pages) up.run(p.id, p.name || '', p.access_token || '', p._subscribed ? 1 : 0);
}
function pageToken(pageId) {
  const r = db.prepare('SELECT access_token FROM fb_pages WHERE page_id = ?').get(String(pageId));
  return r && r.access_token;
}
function connectedPages() {
  return db.prepare('SELECT page_id, name, subscribed, connected_at FROM fb_pages ORDER BY name').all();
}
function disconnectAll() {
  db.prepare('DELETE FROM fb_pages').run();
}

// Pull name / phone / email out of a lead's field_data array (field names vary).
function parseLeadFields(fieldData) {
  const out = { name: '', phone: '', email: '' };
  for (const f of (Array.isArray(fieldData) ? fieldData : [])) {
    const key = (f.name || '').toLowerCase();
    const val = (Array.isArray(f.values) ? f.values[0] : f.values) || '';
    if (!out.phone && /phone|mobile|whatsapp/.test(key)) out.phone = val;
    else if (!out.email && /email/.test(key)) out.email = val;
    else if (!out.name && /name/.test(key)) out.name = val;
  }
  return out;
}

module.exports = {
  GRAPH, SCOPES, getCfg, isConfigured, loginUrl, waLoginUrl, exchangeCode, longLived,
  listPages, subscribePage, getPageSubscriptions, fetchLead, listForms, listFormLeads, savePages, pageToken, connectedPages,
  disconnectAll, parseLeadFields,
  listWabas, listWabaPhones, subscribeWaba, setAppWebhook
};
