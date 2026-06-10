'use strict';
// ─────────────────────────────────────────────────────────────────────────
// AI Assistant — generic, configurable conversational engine for any business.
//
// Four engines, tried in order so replies never break:
//   1. GEMINI (preferred, free)  — Google Gemini Flash.
//   2. GROQ (free)               — Llama 3.3 70B (separate quota).
//   3. ANTHROPIC / CLAUDE (paid) — used only if both free tiers fail.
//   4. RULE-BASED (final)        — deterministic, zero-cost, always works.
//
// The assistant is grounded in the business info you paste in Admin → Settings
// (ai_business_info) and an optional custom system prompt (ai_system_prompt).
// API keys never reach the browser.
// ─────────────────────────────────────────────────────────────────────────

const { db } = require('../db');

// ─── Provider config (key = admin setting → env var) ──────────────────────
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
function geminiKey() { return (setting('gemini_api_key', '') || process.env.GEMINI_API_KEY || '').trim(); }
function useGemini() { return !!geminiKey(); }

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
function claudeKey() { return (setting('anthropic_api_key', '') || process.env.ANTHROPIC_API_KEY || '').trim(); }
function useClaude() { return !!claudeKey(); }

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
function groqKey() { return (setting('groq_api_key', '') || process.env.GROQ_API_KEY || '').trim(); }
function useGroq() { return !!groqKey(); }

function enabled() { return true; }

// ─── Settings helper ──────────────────────────────────────────────────────
function setting(key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
    return row && row.value != null && row.value !== '' ? row.value : fallback;
  } catch { return fallback; }
}

// ─── Text utilities ───────────────────────────────────────────────────────
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function clipText(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function extractPhone(text) {
  if (!text) return null;
  const m = String(text).replace(/[^\d+]/g, ' ').match(/(?:\+?91[\s-]?|0)?([6-9]\d{9})\b/);
  return m ? m[1] : null;
}
function extractName(text) {
  if (!text) return null;
  const STOP = new Set(['and','my','number','phone','mobile','is','the','interested','in','call','me','on','at','hai','hu','hoon','ji','sir','please','pls','contact','no','num','i','am','a','to','for','this','want','looking','need']);
  function clean(raw) {
    if (!raw) return null;
    const words = raw.trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (const w of words) {
      const lw = w.toLowerCase().replace(/[^a-z]/g, '');
      if (STOP.has(lw)) break;
      const tok = w.replace(/[.,!?;:]+$/, '');
      if (!/^[A-Za-z][a-zA-Z]*$/.test(tok)) break;
      out.push(tok);
      if (/[,.!?;:]$/.test(w)) break;
      if (out.length >= 3) break;
    }
    return out.length ? out.join(' ') : null;
  }
  let m = String(text).match(/(?:my name is|mera naam|naam(?:\s+mera)?)\s+(.+)/i);
  if (m) { const n = clean(m[1]); if (n) return n; }
  m = String(text).match(/(?:i am|i'm|this is)\s+(.+)/i);
  if (m) { const n = clean(m[1]); if (n) return n; }
  return null;
}

function isHinglish(text) {
  const t = norm(text);
  if (/[ऀ-ॿ]/.test(text)) return true;
  const hints = ['dikhao','chahiye','kitna','kitne','konsa','kaunsa','batao','hai','kya','krna','karna','mujhe','sasta','mehnga','paas','wala','wali','rha','rhe','kar do','krdo','accha','achha','theek','thik','budget'];
  let n = 0; for (const h of hints) if (t.includes(h)) n++;
  return n >= 2;
}

// ─── Knowledge base (from admin settings, cached) ─────────────────────────
let kbCache = null, kbAt = 0;
const KB_TTL_MS = 60 * 1000;
function invalidateKb() { kbCache = null; kbAt = 0; }

function buildKnowledgeBase() {
  const now = Date.now();
  if (kbCache && now - kbAt < KB_TTL_MS) return kbCache;
  const businessName = setting('business_name', '') || setting('brand_name', 'our business');
  const phone = setting('phone_display', '');
  const email = setting('email', '');
  const info = setting('ai_business_info', '');
  const kb = {
    businessName, phone, email,
    text: [
      `BUSINESS: ${businessName}.`,
      phone ? `CONTACT PHONE: ${phone}.` : '',
      email ? `CONTACT EMAIL: ${email}.` : '',
      '',
      'BUSINESS INFORMATION (the only facts you may rely on):',
      info ? info : '(No business information has been added yet.)'
    ].filter(Boolean).join('\n')
  };
  kbCache = kb; kbAt = now;
  return kb;
}

function systemPrompt(kb) {
  const custom = setting('ai_system_prompt', '').trim();
  const base = custom || `You are the friendly AI assistant for ${kb.businessName}. You chat with customers on WhatsApp.

YOUR JOB
- Answer customer questions helpfully and warmly, using ONLY the business information provided below.
- Guide interested customers toward the next step and collect their name and phone number so the team can follow up.

GROUNDING RULES
- Only state facts that appear in the BUSINESS INFORMATION. Never invent prices, offers, policies, or details.
- If something is not covered, say you don't have that detail and offer to connect them with the team (collect name + phone).

LEAD CAPTURE
- When a customer shows interest, warmly offer to have someone follow up and ask for their name and phone number.
- Never demand contact details before helping. Help first, then offer.
- If they share a phone number, thank them and confirm the team will reach out shortly.

STYLE
- Warm, concise, human. Short paragraphs or tight bullet lists, never a wall of text.
- Language matching: if the customer writes in Hinglish (Hindi in Latin letters), reply in the same Hinglish (not Devanagari). If they write in English, reply in English.
- A tasteful emoji occasionally is fine.`;
  return `${base}\n\nBUSINESS INFORMATION\n${kb.text}`;
}

// ═══════════════════════ GEMINI ═══════════════════════
async function chatGemini(history) {
  const kb = buildKnowledgeBase();
  const msgs = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: clipText(m.content, 1500) }] }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('Last message must be from the user');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey() },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt(kb) }] },
      contents: msgs,
      generationConfig: { maxOutputTokens: 800, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } }
    })
  });
  if (!res.ok) { const body = await res.text(); const err = new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`); err.status = res.status; throw err; }
  const data = await res.json();
  const cand = (data.candidates && data.candidates[0]) || null;
  const reply = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.map(p => p.text || '').join('').trim() : '';
  if (!reply) throw new Error('Gemini returned no text');
  return reply;
}

// ═══════════════════════ CLAUDE ═══════════════════════
async function chatClaude(history) {
  const kb = buildKnowledgeBase();
  const msgs = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clipText(m.content, 1500) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('Last message must be from the user');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': claudeKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 800, system: systemPrompt(kb), messages: msgs })
  });
  if (!res.ok) { const body = await res.text(); const err = new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`); err.status = res.status; throw err; }
  const data = await res.json();
  const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!reply) throw new Error('Claude returned no text');
  return reply;
}

// ═══════════════════════ GROQ ═══════════════════════
async function chatGroq(history) {
  const kb = buildKnowledgeBase();
  const msgs = [{ role: 'system', content: systemPrompt(kb) }];
  (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .forEach(m => msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clipText(m.content, 1500) }));
  if (msgs.length < 2 || msgs[msgs.length - 1].role !== 'user') throw new Error('Last message must be from the user');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + groqKey() },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 800, temperature: 0.7, messages: msgs })
  });
  if (!res.ok) { const body = await res.text(); const err = new Error(`Groq API ${res.status}: ${body.slice(0, 300)}`); err.status = res.status; throw err; }
  const data = await res.json();
  const reply = data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim() : '';
  if (!reply) throw new Error('Groq returned no text');
  return reply;
}

// ═══════════════════════ RULE-BASED (fallback) ═══════════════════════
function buildReplyRuleBased(userText) {
  const h = isHinglish(userText);
  const businessName = setting('business_name', '') || setting('brand_name', 'us');
  const phone = extractPhone(userText);
  if (phone) {
    const name = extractName(userText);
    return h
      ? `Shukriya${name ? ' ' + name : ''}! 🙏 Aapka number mil gaya (${phone}). Hamari team jaldi aapse contact karegi.`
      : `Thank you${name ? ' ' + name : ''}! 🙏 We've got your number (${phone}). Our team will reach out to you shortly.`;
  }
  const t = norm(userText);
  const greeting = /^(hi|hello|hey|hii+|namaste|namaskar|hlo|yo)\b/.test(t) || t === 'hi' || t === 'hello';
  if (greeting) {
    return h
      ? `Namaste! 🙏 ${businessName} mein aapka swagat hai. Bataiye main aapki kaise madad kar sakta hoon? Apna naam aur number bhej dein to hamari team aapse jaldi baat karegi.`
      : `Hi there! 👋 Welcome to ${businessName}. How can I help you today? Share your name and number and our team will get in touch shortly.`;
  }
  return h
    ? `Aapke message ke liye shukriya! 🙏 Hamari team aapki madad karegi. Apna naam aur mobile number bhej dein — hum jaldi contact karenge.`
    : `Thanks for your message! 🙏 Our team will be happy to help. Share your name and mobile number and we'll get back to you shortly.`;
}

// ═══════════════════════ PUBLIC API ═══════════════════════
async function chat(history) {
  const msgs = (Array.isArray(history) ? history : []).filter(m => m && m.content);
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  if (!lastUser) throw new Error('No user message provided');

  if (useGemini()) {
    try { return { reply: await chatGemini(msgs), engine: 'gemini' }; }
    catch (e) { console.error('[AI] Gemini failed, trying Groq:', e.message); }
  }
  if (useGroq()) {
    try { return { reply: await chatGroq(msgs), engine: 'groq' }; }
    catch (e) { console.error('[AI] Groq failed, trying Claude:', e.message); }
  }
  if (useClaude()) {
    try { return { reply: await chatClaude(msgs), engine: 'claude' }; }
    catch (e) { console.error('[AI] Claude failed, falling back to rules:', e.message); }
  }
  return { reply: buildReplyRuleBased(String(lastUser.content).slice(0, 1000)), engine: 'rules' };
}

// ─── Health check ─────────────────────────────────────────────────────────
async function pingGemini() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey() }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } } }) });
  if (!res.ok) { const b = await res.text(); const e = new Error(`HTTP ${res.status}: ${b.slice(0, 120)}`); e.status = res.status; throw e; }
  return true;
}
async function pingGroq() {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + groqKey() }, body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) });
  if (!res.ok) { const b = await res.text(); const e = new Error(`HTTP ${res.status}: ${b.slice(0, 120)}`); e.status = res.status; throw e; }
  return true;
}
async function pingClaude() {
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': claudeKey(), 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }) });
  if (!res.ok) { const b = await res.text(); const e = new Error(`HTTP ${res.status}: ${b.slice(0, 120)}`); e.status = res.status; throw e; }
  return true;
}
async function healthCheck() {
  const engines = [
    { id: 'gemini', label: 'Google Gemini', model: GEMINI_MODEL, configured: useGemini(), ping: pingGemini },
    { id: 'groq',   label: 'Groq (Llama)',  model: GROQ_MODEL,   configured: useGroq(),   ping: pingGroq },
    { id: 'claude', label: 'Anthropic Claude', model: CLAUDE_MODEL, configured: useClaude(), ping: pingClaude },
    { id: 'rules',  label: 'Built-in engine', model: 'rule-based', configured: true, ping: null }
  ];
  const results = []; let activeFound = false;
  for (const e of engines) {
    let status = 'not_configured', detail = '';
    if (e.id === 'rules') status = 'ok';
    else if (!e.configured) { status = 'not_configured'; detail = 'No API key saved'; }
    else { try { await e.ping(); status = 'ok'; } catch (err) { status = 'error'; detail = err.message; } }
    const working = status === 'ok';
    const active = working && !activeFound;
    if (active) activeFound = true;
    results.push({ id: e.id, label: e.label, model: e.model, configured: e.configured, status, active, detail });
  }
  return { engines: results, activeEngine: (results.find(r => r.active) || {}).id || 'rules' };
}

// ─── WhatsApp output formatter (markdown links → plain, **bold** → *bold*) ──
function formatForWhatsApp(text, origin) {
  if (!text) return text;
  let base = (origin || setting('site_url', '') || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  let out = String(text);
  if (base) {
    out = out.replace(/\[([^\]]+)\]\((\/[A-Za-z0-9\-_\/?=&%.]+)\)/g, (m, label, path) => `${label}: ${base}${path}`);
  }
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => `${label}: ${url}`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  return out;
}

module.exports = {
  enabled, useGemini, useGroq, useClaude, chat, buildReplyRuleBased, buildKnowledgeBase,
  invalidateKb, extractPhone, extractName, healthCheck, formatForWhatsApp
};
