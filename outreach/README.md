# Outreach tracking

`targets.csv` — one row per business. Columns that matter:

- `has_site` — only target `no` or a broken one
- `demo_built` — build for the best 5 only; ~25 min each
- `sent` / `followed_up` — dates. **One follow-up maximum.**
- `status` — `new`, `sent`, `replied`, `won`, `lost`, `do-not-contact`

`do-not-contact` is permanent. Anyone who asks to be left alone never gets
another email, from this or any later batch.

See `../OUTREACH.md` for the email copy and the reply templates.
