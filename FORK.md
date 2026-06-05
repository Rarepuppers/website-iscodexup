# Forking this site to another product

This site is built to be cloned per product. Copy the whole folder, create a new
GitHub repository for the new site, then update the site copy, assets, third-party
accounts, and git remote before pushing.

Target time: 20-30 minutes once you have the new accounts ready.

## 0. Create A Separate Repo Before Pushing

Do this before the first push from a forked folder. Otherwise the fork may still
point at `Rarepuppers/isclaudeup.git` and you can overwrite the live Claude site.

1. Create a new empty GitHub repo, for example:

   ```text
   https://github.com/Rarepuppers/website-iscodexup
   ```

   Do not initialize it with a README, license, or `.gitignore` if your local
   folder already has commits.

2. In the copied folder, check the current remote:

   ```powershell
   git remote -v
   ```

3. Change `origin` to the new repo:

   ```powershell
   git remote set-url origin https://github.com/Rarepuppers/website-iscodexup.git
   git remote -v
   ```

4. Only then push:

   ```powershell
   git push -u origin main
   ```

If `git remote -v` still shows `Rarepuppers/isclaudeup.git`, stop. You are about
to push the fork to the Claude site repo.

## 1. Runtime Config

Edit `config.js` -> `window.SITE`:

- `product`: the product name used in verdict copy, for example `"Codex"`.
- `statusUrl`: the product's Statuspage `summary.json`.
  - Codex/OpenAI: `https://status.openai.com/api/v2/summary.json`
  - Verify CORS in a browser console:

    ```js
    fetch("https://status.openai.com/api/v2/summary.json").then(r => r.json()).then(console.log)
    ```

- `copy.up/degraded/down/unreachable`: product-specific verdict copy.
- `quotes[]`: panic-button one-liners in the new product's voice.
- `components`: optional service trimming. For OpenAI/Codex, use a component
  allowlist so unrelated OpenAI issues do not dominate the page.
- `robots` / `buttons`: keep the keys, replace the image files in `/assets`.

For OpenAI/Codex, the page verdict should be based on Codex-related components,
not OpenAI's global status indicator.

## 2. Static Swaps

Search and replace the product/vendor/domain copy in:

- `index.html`
- `privacy.html`
- `sponsor.html`
- `CNAME`
- `notifier/wrangler.toml`
- `notifier/src/worker.js`

Check these specific spots:

| Spot | What to change |
|---|---|
| `<title>` | Product-specific SEO title |
| `<meta name="description">` | Product-specific description |
| `og:title` / `og:description` | Social preview text |
| `og:url` + canonical link | New domain |
| favicon | New neutral favicon asset |
| preload image paths | Only if you rename art files |
| visible brand | New domain text |
| mascot alt text | New product status text |
| backup tools | Product-appropriate alternatives |
| Brevo form action | New Brevo list/form endpoint |
| witty email validation copy | New product name |
| FAQ | New product/vendor/status-page copy |
| Stripe link | New payment link, if using one |
| footer disclaimer | New vendor name |
| Cloudflare beacon token | New Web Analytics site token |

Keep the business entity consistent: `Snackpack Universe` and the ABN stay the
same unless the business changes.

## 3. New Third-Party Accounts

These are per-site and should not be copied from another site:

1. Brevo contact list and embed form.
2. Stripe payment link, if using donations.
3. Cloudflare Web Analytics site/token.
4. Domain and hosting configuration.
5. Cloudflare Worker KV namespace and secrets for the recovery notifier.

## 4. Recovery Notifier

Copy `notifier/`, then update `notifier/wrangler.toml`:

- `name`
- `STATUS_URL`
- `COMPONENT_INCLUDE`, if the vendor has a broad status page
- `BREVO_LIST_ID`
- `SENDER_EMAIL`
- `SENDER_NAME`
- `PRODUCT`
- `SITE_URL`
- KV namespace id

Then set secrets:

```powershell
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put ADMIN_KEY
```

Deploy from the notifier folder:

```powershell
cd notifier
npx wrangler deploy
```

Test with a list containing only your own address first:

```powershell
curl.exe "https://<worker>.<subdomain>.workers.dev/test-send?key=YOUR_ADMIN_KEY"
```

## 5. Sanity Check Before Launch

- `git remote -v` points to the new repo, not `Rarepuppers/isclaudeup.git`.
- `CNAME` matches the new domain.
- Page renders the correct product name.
- Verdict renders `YES`/`KINDA`/`NO`.
- Component list fills in.
- Mascot and button art swap correctly.
- Signup form posts into the new Brevo list.
- Cloudflare beacon token is not a placeholder.
- Worker `/state` returns JSON.
- Worker `/test-send` delivers from the authenticated sender.

## Gotchas

- Do not push a fork while `origin` still points at `isclaudeup.git`.
- Do not reuse another site's Brevo list unless you intentionally want mixed
  subscribers.
- Do not reuse another site's Cloudflare Analytics token.
- Do not upload placeholder Worker values like `REPLACE_WITH_*`.
- Keep official/third-party logos out of favicons and primary branding unless
  you have permission.
