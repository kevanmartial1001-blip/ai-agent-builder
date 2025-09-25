# AI Agent Builder (Vercel)

POST `/api/compile` with JSON `{ "blueprint": "<yaml or json string>" }` to receive a ZIP of artifacts:
- `workflows/n8n.json`
- `prompts/*`
- `policies/*`
- `tests/uat.json`
- `data/synthetic/appointments.csv`
- `README.md`

Use the ZIP to import `n8n.json` into n8n and run a demo.
