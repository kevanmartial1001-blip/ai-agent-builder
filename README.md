# AI Agent Builder (n8n JSON generator)

- Pick a scenario (from Google Sheets) and download an **import-ready n8n workflow**.
- 10 archetypes supported out of the box: Scheduling, Billing, Lead, Support, Status, Upsell, Onboarding, Internal, Survey, Knowledge.
- Email is prewired to **SMTP credential name:** `SMTP account` (set this in n8n).
- Twilio nodes are present but **disabled** and use credential name **`twilio-default`**.

## Environment variables (Vercel → Settings → Environment Variables)

- `GOOGLE_API_KEY` – a **public** Sheets API key is enough for public sheets.
- `SHEET_ID` – the Google Sheet id that contains the tabs.
- `SHEET_TAB` – tab for scenarios (default `Scenarios`).
- `INDUSTRIES_TAB` – tab for industries (default `industries`).
- **OPTIONAL**: `SCENARIOS_CSV_URL` – if you prefer a published CSV for scenarios (overrides Sheets API).

The Scenarios sheet columns:
scenario_id | name | triggers | best_reply_shapes | risk_notes | agent_name |how_it_works | tool_stack_dev | tool_stack_autonomous | tags (;) | roi_hypothesis

The Industries sheet must include at least:
industry_id | playbook_name | core_pains | kpi_examples | success_metrics
(other columns are OK; they’ll be returned if present)

## Deploy
1. Push this repo to GitHub.
2. Import the repo in Vercel.
3. Set the env vars above.
4. Open the Vercel URL → pick a scenario → **Download n8n JSON** → import in n8n.

