// LeadFlow — SQLite database (schema + seed)
// Uses Node's built-in node:sqlite (Node 22.5+ with --experimental-sqlite,
// stable in Node 24+). No native build, no node-gyp.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Persistent storage. Defaults to ./data/leadflow.sqlite. Override with DB_PATH.
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'leadflow.sqlite');
const DB_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ─────────────────── SCHEMA ───────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Leads inbox: website forms, Meta Lead Ads, and WhatsApp all land here.
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    email TEXT,
    message TEXT,
    interested_in TEXT,            -- campaign name / form name / topic
    property_slug TEXT,            -- optional reference id (kept for API compatibility)
    property_name TEXT,            -- optional cached label
    source TEXT NOT NULL,          -- 'whatsapp' | 'meta' | 'website' | 'api' | ...
    ip TEXT,
    user_agent TEXT,
    page_url TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_leads_read ON leads(is_read);
  CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

  -- WhatsApp conversation log. Inbound arrives via the Cloud API webhook;
  -- outbound is from the AI, an admin reply, a broadcast or a sequence.
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL,
    profile_name TEXT,
    direction TEXT NOT NULL,          -- 'in' | 'out'
    body TEXT,
    msg_type TEXT DEFAULT 'text',
    engine TEXT,
    wam_id TEXT,
    status TEXT,                      -- sent | delivered | read | failed
    media_url TEXT,
    media_type TEXT,                  -- image | document | ...
    broadcast_id INTEGER,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_wa_waid ON whatsapp_messages(wa_id);
  CREATE INDEX IF NOT EXISTS idx_wa_created ON whatsapp_messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_wa_read ON whatsapp_messages(is_read);
  CREATE INDEX IF NOT EXISTS idx_wa_msg_broadcast ON whatsapp_messages(broadcast_id);

  CREATE TABLE IF NOT EXISTS whatsapp_threads (
    wa_id TEXT PRIMARY KEY,
    ai_paused INTEGER DEFAULT 0,
    label TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS whatsapp_broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template TEXT NOT NULL,
    lang TEXT,
    preview TEXT,
    total INTEGER DEFAULT 0,
    sent INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',    -- running | done | error | scheduled
    scheduled_at DATETIME,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS wa_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT UNIQUE NOT NULL,
    name TEXT,
    tags TEXT,
    notes TEXT,
    opted_out INTEGER DEFAULT 0,
    source TEXT DEFAULT 'manual',     -- manual | import | inbound | meta
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_wa_contacts_tags ON wa_contacts(tags);

  CREATE TABLE IF NOT EXISTS wa_quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    media_url TEXT,
    media_type TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wa_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    trigger_tag TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS wa_sequence_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL,
    step_order INTEGER DEFAULT 0,
    delay_hours REAL DEFAULT 24,
    template TEXT NOT NULL,
    lang TEXT DEFAULT 'en_US',
    params TEXT,
    header_image_url TEXT
  );
  CREATE TABLE IF NOT EXISTS wa_sequence_enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL,
    wa_id TEXT NOT NULL,
    current_step INTEGER DEFAULT 0,
    next_run_at DATETIME,
    status TEXT DEFAULT 'active',     -- active | done | stopped
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sequence_id, wa_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wa_seq_enr_due ON wa_sequence_enrollments(status, next_run_at);

  -- Facebook Pages connected via Login (Lead Ads / Instant Form leads).
  CREATE TABLE IF NOT EXISTS fb_pages (
    page_id TEXT PRIMARY KEY,
    name TEXT,
    access_token TEXT,
    subscribed INTEGER DEFAULT 0,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─────────────── Default admin (first boot only) ───────────────
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get();
if (!userCount.n) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, 'admin');
  console.log(`✓ Created default admin: ${username} / ${password}  (change this!)`);
}

// ─────────────── Default settings (only if missing) ───────────────
const DEFAULT_SETTINGS = {
  brand_name: 'LeadFlow',
  business_name: 'Your Business',
  phone_display: '',
  email: '',

  // WhatsApp Cloud API config (set from admin → Settings, or .env)
  whatsapp_phone_id: process.env.WHATSAPP_PHONE_ID || '',
  whatsapp_token: process.env.WHATSAPP_TOKEN || '',
  whatsapp_verify_token: process.env.WHATSAPP_VERIFY_TOKEN || '',
  whatsapp_waba_id: '',
  whatsapp_app_id: process.env.WHATSAPP_APP_ID || '',
  whatsapp_app_secret: process.env.WHATSAPP_APP_SECRET || '',
  whatsapp_enabled_bot: '1',           // AI auto-reply on by default when configured

  // Estimated per-message cost (for the spend strip)
  wa_msg_rate: '0.8',

  // AI assistant — generic & configurable for any business
  ai_assistant_enabled: '1',
  ai_business_info: '',                 // paste your business info / FAQ / catalogue here
  ai_system_prompt: '',                 // optional custom system prompt (overrides default tone)
  gemini_api_key: process.env.GEMINI_API_KEY || '',
  groq_api_key: process.env.GROQ_API_KEY || '',
  anthropic_api_key: process.env.ANTHROPIC_API_KEY || ''
};
const insertSetting = db.prepare(
  'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

module.exports = { db };
