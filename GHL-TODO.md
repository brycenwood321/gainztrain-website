# Gainz Train — GHL Pre-Launch Checklist

## Before going live, Brycen needs to do these in GHL:

### 1. Change funnel publishing domain
- Go to GHL → Funnels → each checkout funnel
- Change publishing domain from `gainztrainprep.com` → `join.gainztrainprep.com`
- This frees up gainztrainprep.com for Cloudflare Pages

### 2. Get all 11 checkout URLs
- Once domain is changed, grab the URL for each meal count
- Format: `join.gainztrainprep.com/[N]-weekly-meals-checkout`
- Needed for: 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 meals/week
- Then paste each into subscribe/index.html (every button has a `<!-- SWAP -->` comment)

### 3. GHL contact form embed
- In GHL → Sites → Forms → grab the embed URL/iframe code
- Swap it into contact/index.html (there's a `<!-- GHL FORM EMBED -->` comment)

### 4. Weekly menu reminder automation
- Make sure GHL is sending a reminder email every week
- Remind members to submit picks at menu.gainztrainprep.com before Friday cutoff
- Should fire Thursday or Friday morning

### 5. DNS (Cloudflare)
- Add CNAME: `join` → GHL's servers (same target as current A record)
- Add `gainztrainprep.com` → Cloudflare Pages custom domain
- `menu.gainztrainprep.com` stays untouched

### 6. After DNS
- Submit gainztrainprep.com sitemap to Google Search Console
- Run Lighthouse audit (target 90+ performance, 100 SEO)

## Notes
- The weekly menu tool (menu.gainztrainprep.com) is a custom GHL funnel/form
  Brycen built it in Claude — may need UX improvements later
- Specialty protein upcharge ($1.50 for Braised Beef, Steak) is billed separately
  No changes needed to checkout for this
