# LeadFlow

A self-hosted **WhatsApp + Meta Lead Ads CRM** with AI auto-replies, broadcasts, templates and drip sequences. No monthly SaaS fees, and every lead and chat stays in your own database on your own server.

Tools like Wati and AiSensy charge ₹3,000–₹10,000 a month for this. LeadFlow gives you the same stack to run yourself.

## Features

- **Two-way WhatsApp inbox** — read and reply to every conversation from one admin panel (WhatsApp Cloud API).
- **AI auto-reply** — answers customer questions on its own, grounded in business info you paste in Settings. One-tap pause to take over a chat manually. Works with Google Gemini, Groq, or Anthropic (free tiers supported) with a built-in rule-based fallback.
- **Meta Lead Ads** — connect your Facebook/Instagram pages; lead-form submissions auto-import as contacts, tagged by campaign, with a 5-minute auto-poll.
- **Broadcasts** — send approved templates to a pasted list, all contacts, or a tag segment. Optional scheduling.
- **Templates** — list, create and delete WhatsApp message templates.
- **Drip sequences** — multi-step template follow-ups, auto-enrolled by tag.
- **Contacts** — tags, search, CSV import/export, opt-out (STOP/START) handling.
- **Live unread badge + sound** and a **24-hour customer-care window indicator**.
- **Analytics** — sent/delivered/read funnel, 14-day trend, per-campaign breakdown, spend estimate.
- **Leads inbox** — website forms, Meta and WhatsApp leads in one place, with CSV export.
- **Security** — admin login plus separate password locks on the WhatsApp and Leads sections.

## Tech

Node.js · Express · `node:sqlite` (built-in, no native build) · vanilla JS admin UI (Tailwind via CDN).

## Quick start

```bash
npm install
cp .env.example .env      # edit values
npm start                 # runs on http://localhost:3100
```

Open `http://localhost:3100/admin` and log in (default `admin` / `admin123` — change it).

> Requires **Node 22.5+** (the `--experimental-sqlite` flag is passed by `npm start`; on Node 24+ it is stable).

## Configuration

Everything can be set in **Admin → Settings** (stored in the database), or via `.env`:

| What | Where to get it |
|------|-----------------|
| WhatsApp Phone Number ID, Access Token, Verify Token | developers.facebook.com → your app → WhatsApp |
| Meta App ID + App Secret | developers.facebook.com → app settings |
| AI keys (Gemini / Groq / Claude) | each provider's console (Gemini & Groq have free tiers) |

**Webhook URL** (set in the Meta app): `https://YOUR_DOMAIN/api/whatsapp/webhook` with your Verify Token.

## Public API

- `POST /api/leads` — capture a lead from any external form:
  ```json
  { "source": "website", "name": "...", "phone": "...", "email": "...", "message": "...", "interested_in": "..." }
  ```
- `POST /api/assistant/chat` — `{ "messages": [{ "role": "user", "content": "..." }] }` → AI reply.

## License

MIT
