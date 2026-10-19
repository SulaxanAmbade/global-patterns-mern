# Global Patterns — MERN

A React + Express + Node + MongoDB conversion of the supplied four-page Streamlit application. The project has separate `frontend` and `backend` folders. There is no Streamlit or Python runtime dependency for the web app; the optional SQLite exporter uses standard Python once.

## Start locally

Requires Node.js 22 or newer and MongoDB 7 or newer. Existing data and credentials are not bundled.

1. Copy `backend/.env.example` to `backend/.env`.
2. Set `APP_USERS_JSON` to your real username/password map. Set `SESSION_SECRET` to a random secret of at least 32 characters. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Start MongoDB and set `MONGODB_URI` in `backend/.env`.
4. In one terminal:

   ```sh
   cd backend
   npm ci
   npm run dev
   ```

5. In another terminal:

   ```sh
   cd frontend
   npm ci
   npm run dev
   ```

6. Open http://localhost:5173 and sign in. Import a dataset in the Dashboard, inspect its preview, then click **Activate This Dataset**.

For a local Docker alternative, configure `backend/.env` and run `docker compose up --build` from the project root. Open http://localhost:4000. Docker Compose supplies MongoDB automatically. The Compose configuration is for local HTTP use, with private Mongo networking and persistent volumes. Do not expose this example directly to the internet.

## Production

Build the frontend (`cd frontend && npm ci && npm run build`), install the backend (`cd backend && npm ci --omit=dev`), and run `npm start` in `backend`. Express serves the compiled frontend and API on the same origin. Set `NODE_ENV=production`; put an HTTPS reverse proxy in front of it and set `TRUST_PROXY=true` only when one trusted proxy is present. Production authentication cookies require HTTPS. Mount `backend/storage` on a persistent volume. Use one API process: its serialized queue is designed for one instance. Multiple API replicas require a distributed job lease/queue before deployment.

For your stated 2-core / 2.7-GB maximum, start with one worker, `MAX_WORKER_MB=384`, the default 25-MB upload cap, and an external MongoDB service. The API uses a 192-MB JavaScript heap budget; the worker gets a separate 384-MB heap. These are heap limits, not total process memory guarantees. Excel decompression, native buffers, MongoDB and the OS also use RAM. The local Docker stack has combined container memory caps of 2.25 GiB and 2 CPUs and is **not** sized for the 690-MB minimum allocation. Run capacity tests on the actual host before replacing the Streamlit app.

## Page files

| Page | React file | Backend implementation |
| --- | --- | --- |
| Login | `frontend/src/pages/LoginPage.jsx` | `backend/src/services/auth.js` |
| Global Pattern Dashboard | `frontend/src/pages/DashboardPage.jsx` | `backend/src/routes/dataset.js`, `services/importDataset.js` |
| Coverage Report | `frontend/src/pages/CoveragePage.jsx` | `backend/src/services/coverage.js`, `services/matcher.js` |
| Concatenate Sheet | `frontend/src/pages/ConcatenatePage.jsx` | Browser-only pattern builder |
| Keyword Performance Check | `frontend/src/pages/PerformancePage.jsx` | `backend/src/services/performance.js`, `routes/jobs.js` |

Shared tables, pagination and background-job status are in `frontend/src/components`. Styling is in `frontend/src/styles.css`. The worker entry point is `backend/src/workers/run.js`. Database indexes are in `backend/src/db.js`.

## Capacity changes

- User interactions request only the required API data; no full-script rerun or per-session DataFrame copies.
- Exactly one background worker runs at a time. Ten queued/running jobs maximum, with a configurable timeout; the API remains separate from CPU-heavy processing.
- CSV/TSV input streams into MongoDB in batches. URL grouping and performance pair aggregation use disk-backed collections, not an in-memory list of every URL.
- Coverage uses a token trie and rare-fragment anchors; the catalog is built once per job rather than matching every pattern against every URL.
- Result tables fetch 100 rows per page. Exports stream from MongoDB with backpressure.
- Imports stage a separate revision. Activating changes one metadata document, so failed imports do not wipe the current dataset.
- Jobs, uploads, result rows and scratch data expire after 24 hours by default. Active dataset revisions remain. Previous inactive snapshots are removed after their import job expires and no retained job references them.

The basis catalog must still fit inside the worker memory budget. Legacy XLS/HTML-as-XLS parsing loads the workbook inside the isolated worker; XLSX shared strings also consume memory. Prefer CSV/TSV for large uploads. If a workbook exceeds the budget, the job fails without bringing down the API. MERN does not guarantee unlimited capacity.

## Preserved workflows

- Multi-user login from `APP_USERS_JSON`, “Signed in as”, logout, expiring server-side sessions, rate-limited login, CSRF protection.
- Shared dataset search by pattern, ID or basis, admin filtering, paginated browsing and CSV download. Normalized search matches normalized terms in order; exact mode matches an entire pattern, basis or ID, ignoring case.
- CSV/TSV (including UTF-16 LE), XLSX, XLS and HTML-as-XLS dataset input. Header detection for spreadsheets; named columns for delimited files. Duplicate rows are upserted. Missing IDs fall back to `total_count`; date-like shifted language values can fall back to `url_pattern_order`. File dates use DD-MM-YYYY and Asia/Kolkata today; a mismatch requires a checkbox. Misplaced numeric admin IDs are moved back; missing names use an unambiguous historical or workbook ID/name mapping and receive `(Lookup)`. Conflicting names remain unresolved for inspection.
- A `pattern_keywords` column is stored privately for existing-pair checking. Supported cells: JSON list or newline / semicolon / pipe / comma separated text. Malformed cells are counted in the preview and skipped. If the column is omitted, the previous keyword snapshot is retained; the checker still requires a matching live source pattern/admin.
- Coverage filters selected languages and uses the complete split basis: `*patternkeywords.global*facty.com*health*` becomes `facty.com*health`. It searches hostname, path, query and fragment. Bare outer domains do not count as a basis. Wildcards separate required fragments; words within a fragment stay adjacent; plural URL spellings and `~word~` exact locks are supported.
- Exactly one winning basis per URL: lower numeric priority first; ties prefer longer basis then basis/language text. Invalid priorities come last. The primary and second checks each produce **only a URL summary CSV**. The second check reuses the first upload, allows searchable exclusions and extra bases with priorities, and produces **Priority URL Summary**.
- Concatenate builds patterns from domains/URLs and bases; promote domain suffixes are stripped. TXT and CSV downloads.
- Performance filters existing database pairs by configurable minimum impressions and all/any metric rules, with fixed values, basis averages, or a percentage of basis average. Count and revenue duplicates sum; rates use weights; zero-weight groups use the arithmetic mean. RPC uses keyword-click weights when clicks are mapped, otherwise impression weights. Basis averages are unweighted means of eligible distinct pair values within input basis/language/domain groups before rules. Percentage values stay on the CSV scale (5% means 5).
- Review uses **one aggregated row per distinct pair**, rather than repeating each original CSV row. It includes the condition metrics, pair RPM and basis average RPM. Select pairs across result pages, download deletion mappings, fill blank manual replacement rows, edit domain/priority, select rows, and download the upload sheet. Promote exports resolve `setid: 123` from admin metadata; missing/conflicting setids block the export for correction.
- Keyword generation, models and automated mapping are absent. No OpenAI API key is needed.

## Migrate the existing SQLite data

Back up your current `url_patterns.db`. The web app never modifies it. On the machine with the old database:

```sh
python backend/scripts/export-sqlite.py /path/to/url_patterns.db /path/to/patterns.jsonl
```

Then either upload `patterns.jsonl` through the Dashboard, or run:

```sh
cd backend
npm run migrate -- /absolute/path/patterns.jsonl
```

The CLI stages and activates the imported revision immediately, bypassing web filename-date confirmation. Run it while the API is stopped. Streamlit `secrets.toml` accounts do not migrate automatically: copy the user/password map into `APP_USERS_JSON`. The private keyword table migrates when present. Without an existing database, upload your original export with `pattern_keywords` to enable the performance checker.

## Verify

```sh
cd backend
npm test
cd ../frontend
npm run build
```

`backend/test/logic.test.js` covers domain splitting, coverage priority, wildcard/phrase/plural/lock behavior, repeated fragments, promote handling, conditions, parsing and CSV escaping. See `backend/VALIDATION.md` for checks performed in the delivery environment and remaining deployment checks.

## Operational limits

- Upload limit and worker heap are intentionally bounded and configurable. Use CSV for large inputs.
- MongoDB is required; SQLite is an import source only. MongoDB disk usage can grow with input size until retention cleanup runs. Back up the active database.
- Accounts are configured in environment variables to preserve the current workflow; there is no registration or password-management page. Use your deployment secret manager.
- Only trusted signed-in users should import datasets or upload legacy workbooks. Review parser dependencies before public deployment.
- The supplied app contains no live database, hosting account or production configuration. Start and verify it before switching users over.

## Implementation references

- [MongoDB cursor batching](https://www.mongodb.com/docs/manual/reference/method/cursor.batchsize/)
- [SheetJS official Node installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) — the fixed 0.20.3 tarball is pinned directly, rather than the old npm-registry release.

