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

function getCfg() {
  const rows = db.prepare("SELECT key, value FROM site_settings WHERE key IN ('whatsapp_app_id','whatsapp_app_secret')").all();
  const c = {}; for (const r of rows) c[r.key] = r.value;
  return c;
}
function isConfigured() {
  const c = getCfg();
  return !!(c.whatsapp_app_id && c.whatsapp_app_secret);
}

// Build the Facebook Login dialog URL the admin is redirected to.
// The OAuth *dialog* lives on www.facebook.com (NOT graph.facebook.com).
function loginUrl(redirectUri, state) {
  const c = getCfg();
  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(c.whatsapp_app_id)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent(SCOPES.join(','))}`
    + `&state=${encodeURIComponent(state || '')}&response_type=code`;
}

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
  GRAPH, SCOPES, getCfg, isConfigured, loginUrl, exchangeCode, longLived,
  listPages, subscribePage, getPageSubscriptions, fetchLead, listForms, listFormLeads, savePages, pageToken, connectedPages,
  disconnectAll, parseLeadFields
};
