# J.N.R. Engineering website

Static HTML, CSS and a little JavaScript, hosted on Vercel, plus one serverless function for the quote form.

## Quote form

`quote.html` posts multipart form data to `/api/quote` (`api/quote.js`, Node). The function:

- validates every field on the server (name, company, phone, email, quantity, material, required by date, message)
- accepts up to 4 drawings, 4MB in total: PDF, DXF, DWG, STEP/STP, IGES/IGS, STL, JPG, PNG
- emails the request to the workshop with Resend, with the drawings attached, the customer's email as reply-to, and the subject `New quote request – {company}` (urgent jobs get `URGENT:` in front)
- emails the customer a short confirmation
- drops spam: a hidden honeypot field, forms sent faster than a person could fill them in, and a basic per-IP rate limit (5 requests in 10 minutes, kept in memory per warm instance, so use Vercel's firewall rate limiting if you need it stricter)

On success the browser goes to `/thanks`. On failure the form stays put with a message and nothing typed is lost.

### Environment variables

Set these in Vercel, Project Settings, Environment Variables (Production and Preview), then redeploy.

| Variable | Required | What it is |
|---|---|---|
| `RESEND_API_KEY` | yes | API key from resend.com |
| `QUOTE_TO` | yes | Where quote requests go, the owner's Outlook address. Comma separate for more than one |
| `QUOTE_FROM` | no | Sender address on a domain verified in Resend. Defaults to `info@jnrengineering.co.uk` |

The sending domain must be verified in Resend (DNS records) before emails will send. See `.env.example`.

### Testing locally

`npm install`, copy `.env.example` to `.env.local`, fill it in, then `npx vercel dev`.

## Pages

- `index`, `about`, `services`, `quote`, `privacy`, `thanks`, `404`. `work` and `team` are "coming soon" placeholders: noindex, out of the navigation, and `/work` redirects to `/projects/`
- `capabilities/`: `cnc-milling`, `cnc-turning`, `prototypes`, `batch-production`, `materials`
- `projects/`: the index. The write-up template is `docs/project-template.html` (kept out of the deployed site by `.vercelignore`), copy it to `projects/<short-name>.html` for each project. The projects index is set to `noindex` until two real write-ups exist: remove `noindex` from its robots meta tag, add it to `sitemap.xml`, and link each write-up from it

`sitemap.xml`, `robots.txt` and `llms.txt` live in the root. `vercel.json` turns on clean URLs.
