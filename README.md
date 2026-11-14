# লালমনিরহাট নিউজ (Lalmonirhat News)

**Tagline:** সত্যের সন্ধানে, মানুষের পাশে।

একটি পূর্ণাঙ্গ, আধুনিক, প্রোডাকশন-রেডি বাংলা ডিজিটাল সংবাদ পোর্টাল এবং এডিটোরিয়াল সিএমএস (CMS)।

---

## Key Features

- **Editorial Newspaper Homepage**: Breaking news ticker, Hero lead story + supporting grid, Latest news, Dedicated Lalmonirhat district & Upazila news (`সদর`, `হাতীবান্ধা`, `পাটগ্রাম`, `আদিতমারী`, `কালীগঞ্জ`), Category sections, Most Read, Editor's Choice, Photo Gallery, Video News, and Newsletter.
- **Article Reader Experience**: Rich formatted articles, image captions, font size controls (`A- / A / A+`), print stylesheet, copy link, and native Facebook, WhatsApp, Messenger & X share buttons.
- **Server-Side Open Graph & SEO**: Dynamic server-side `<meta property="og:*">`, Twitter Cards, Schema.org `NewsArticle` JSON-LD, `/sitemap.xml`, `/news-sitemap.xml`, and `/robots.txt` for accurate Facebook link image previews.
- **Full Admin Dashboard (`/admin`)**:
  - Role-based JWT + `bcryptjs` authentication (`Super Admin`, `Admin`, `Editor`, `Reporter`) + password reset flow.
  - Rich Text News Publisher (Draft, Publish, Schedule, Feature, Pin, SEO Meta, Live Preview).
  - Breaking News Ticker Manager (Priority, ordering, article linking, auto-expiry).
  - 12-Slot Adsterra & Banner Advertisement Manager (Header, Homepage Top/Middle, Between Cards, Article Top/Middle/Bottom, Sidebar, Footer, Mobile, Adsterra Social Bar, Adsterra Popunder).
  - Media Library with local image upload & reuse.
  - Category, Subcategory, Reporter, Menu, Homepage Section, Social Media, Website Settings, Analytics, Backup & Restore, and Deployment Management (including live ZIP export).

---

## Local Installation & Running

```bash
npm install
cp .env.example .env
npm run dev
```

The application starts on `http://localhost:3000`.
Admin Panel: `http://localhost:3000/admin`

Default seeded Super Admin account (change password immediately in Profile or User Management):
- **Email:** `ramjamsarker@gmail.com`
- **Password:** `ramjan@769`

---

## Database Setup (Supabase PostgreSQL for Cloud / Netlify)

1. Create a free Supabase project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** in Supabase and run `supabase/migrations/001_initial_schema.sql`.
3. Create a public Storage bucket named `news-media` for uploaded images.
4. Copy `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` into your environment variables.

---

## Netlify Deployment Guide

### Method A: Automatic GitHub Deployment (Recommended)
1. Push this repository to GitHub.
2. Log in to **Netlify** → **Add new site** → **Import an existing project**.
3. Select your GitHub repository. Netlify reads `netlify.toml` automatically:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
4. Add environment variables in **Site configuration → Environment variables**:
   - `APP_URL` (e.g. `https://lalmonirhatnews.com`)
   - `JWT_SECRET`
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. Click **Deploy site**. Every push to `main` triggers an automatic rebuild, while news published in `/admin` updates the database live immediately without rebuilding Netlify.

### Method B: Manual ZIP Deployment
1. Log in to `/admin` → **Deployment Management**.
2. Click **"ডাউনলোড নেটলিফাই রেডি ZIP (Download Netlify ZIP)"** to generate a complete deployable package, or run `npm run build` locally and upload the `dist/` + `netlify/` bundle via **Netlify Drop** or `netlify deploy --prod`.

---

## Adsterra Integration Guide

1. Log in to your Adsterra Publisher Dashboard and generate your ad zone scripts (728x90 Banner, 300x250 Native/Banner, Social Bar, Popunder).
2. Go to `/admin` → **Advertisement Management**.
3. Select the desired placement (e.g., `Social Bar`, `Popunder`, `Header Banner`, `Article Middle`).
4. Paste the official Adsterra script block, set device targeting & active dates, toggle **Enable**, and save.
