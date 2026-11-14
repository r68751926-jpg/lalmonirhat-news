import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { db, initDatabase, logActivity } from './server/db.ts';
import { AuthRequest, rateLimit, requireAuth, requireRole, signToken } from './server/auth.ts';
import { createSlug } from './src/utils/bangla.ts';

initDatabase();

const app = express();
const PORT = 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Trust reverse proxy headers (Cloud Run / Netlify / Nginx)
app.set('trust proxy', 1);

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

// Basic security headers (XSS, clickjacking, MIME sniffing)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Ensure uploads directory exists and serve static media
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/src/assets/images', express.static(path.join(process.cwd(), 'src', 'assets', 'images')));

// Multer configuration for media library uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    cb(null, `${Date.now()}-${base || 'media'}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('শুধুমাত্র ছবি অথবা ভিডিও ফাইল আপলোড করা যাবে।'));
    }
  },
});

// Helper: Resolve public site base URL
function getBaseUrl(req: express.Request): string {
  if (process.env.APP_URL && !process.env.APP_URL.includes('MY_APP_URL')) {
    return process.env.APP_URL.replace(/\/$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function toAbsoluteUrl(req: express.Request, maybeRelative: string): string {
  if (!maybeRelative) return '';
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  return `${getBaseUrl(req)}${maybeRelative.startsWith('/') ? '' : '/'}${maybeRelative}`;
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSettingsMap(): Record<string, string> {
  const rows = db.prepare('SELECT setting_key, setting_value FROM website_settings').all() as Array<{
    setting_key: string;
    setting_value: string;
  }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.setting_key] = r.setting_value;
  return map;
}

function getSocialMap(): Record<string, string> {
  const rows = db.prepare('SELECT link_key, link_value FROM social_links').all() as Array<{
    link_key: string;
    link_value: string;
  }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.link_key] = r.link_value;
  return map;
}

function publishDueScheduledNews() {
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE news SET status = 'published', published_at = COALESCE(published_at, scheduled_at, ?), updated_at = ? WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`
  ).run(nowIso, nowIso, nowIso);
}

const NEWS_SELECT_SQL = `
  SELECT n.*,
         c.name as category_name, c.slug as category_slug,
         s.name as subcategory_name,
         r.name as reporter_name, r.designation as reporter_designation, r.avatar_url as reporter_avatar
  FROM news n
  LEFT JOIN categories c ON n.category_id = c.id
  LEFT JOIN subcategories s ON n.subcategory_id = s.id
  LEFT JOIN reporters r ON n.reporter_id = r.id
`;

// ============================================================================
// 1. PUBLIC API ROUTES
// ============================================================================

app.get('/api/public/bootstrap', (_req, res) => {
  publishDueScheduledNews();
  const nowIso = new Date().toISOString();

  const settings = getSettingsMap();
  const socialLinks = getSocialMap();
  const categories = db
    .prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY display_order ASC, id ASC')
    .all();
  const subcategories = db
    .prepare('SELECT * FROM subcategories WHERE is_active = 1 ORDER BY display_order ASC')
    .all();
  const menuItems = db
    .prepare('SELECT * FROM menu_items WHERE is_active = 1 ORDER BY display_order ASC, id ASC')
    .all();
  const homepageSections = db
    .prepare('SELECT * FROM homepage_sections WHERE is_active = 1 ORDER BY display_order ASC')
    .all();
  const breakingNews = db
    .prepare(
      `SELECT b.*, n.slug as article_slug
       FROM breaking_news b
       LEFT JOIN news n ON b.article_id = n.id
       WHERE b.is_active = 1
         AND (b.starts_at IS NULL OR b.starts_at = '' OR b.starts_at <= ?)
         AND (b.expires_at IS NULL OR b.expires_at = '' OR b.expires_at > ?)
       ORDER BY b.priority ASC, b.display_order ASC, b.id DESC`
    )
    .all(nowIso, nowIso);

  const ads = db
    .prepare(
      `SELECT * FROM advertisements
       WHERE is_active = 1
         AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
         AND (end_date IS NULL OR end_date = '' OR end_date >= ?)
       ORDER BY priority ASC`
    )
    .all(nowIso.slice(0, 10), nowIso.slice(0, 10));

  const publishedNews = db
    .prepare(`${NEWS_SELECT_SQL} WHERE n.status = 'published' ORDER BY n.is_pinned DESC, n.published_at DESC LIMIT 60`)
    .all();

  const mostRead = db
    .prepare(`${NEWS_SELECT_SQL} WHERE n.status = 'published' ORDER BY n.views DESC, n.published_at DESC LIMIT 8`)
    .all();

  const editorsChoice = db
    .prepare(`${NEWS_SELECT_SQL} WHERE n.status = 'published' AND n.is_editors_choice = 1 ORDER BY n.published_at DESC LIMIT 6`)
    .all();

  const photoGallery = db
    .prepare('SELECT * FROM photo_gallery WHERE is_active = 1 ORDER BY id DESC LIMIT 12')
    .all();

  const videoNews = db
    .prepare('SELECT * FROM video_news WHERE is_active = 1 ORDER BY id DESC LIMIT 8')
    .all();

  res.json({
    settings,
    socialLinks,
    categories,
    subcategories,
    menuItems,
    homepageSections,
    breakingNews,
    ads,
    news: publishedNews,
    mostRead,
    editorsChoice,
    photoGallery,
    videoNews,
  });
});

app.get('/api/public/news', (req, res) => {
  publishDueScheduledNews();
  const { category, subcategory, district, search, tag, limit = '24', offset = '0' } = req.query as Record<string, string>;

  const where: string[] = [`n.status = 'published'`];
  const params: unknown[] = [];

  if (category) {
    where.push(`c.slug = ?`);
    params.push(category);
  }
  if (subcategory) {
    where.push(`s.slug = ?`);
    params.push(subcategory);
  }
  if (district) {
    where.push(`n.district_area = ?`);
    params.push(district);
  }
  if (tag) {
    where.push(`n.tags LIKE ?`);
    params.push(`%${tag}%`);
  }
  if (search) {
    where.push(`(n.title LIKE ? OR n.subheadline LIKE ? OR n.summary LIKE ? OR n.tags LIKE ?)`);
    const q = `%${search.trim()}%`;
    params.push(q, q, q, q);
  }

  const lim = Math.min(100, Math.max(1, Number(limit) || 24));
  const off = Math.max(0, Number(offset) || 0);

  const items = db
    .prepare(`${NEWS_SELECT_SQL} WHERE ${where.join(' AND ')} ORDER BY n.is_pinned DESC, n.published_at DESC LIMIT ? OFFSET ?`)
    .all(...params, lim, off);

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as total FROM news n LEFT JOIN categories c ON n.category_id = c.id LEFT JOIN subcategories s ON n.subcategory_id = s.id WHERE ${where.join(' AND ')}`
    )
    .get(...params) as { total: number };

  res.json({ items, total: totalRow.total });
});

app.get('/api/public/news/:slug', (req, res) => {
  publishDueScheduledNews();
  const slug = decodeURIComponent(req.params.slug);
  const article = db
    .prepare(`${NEWS_SELECT_SQL} WHERE n.slug = ? AND n.status = 'published'`)
    .get(slug) as Record<string, unknown> | undefined;

  if (!article) {
    return res.status(404).json({ error: 'সংবাদটি পাওয়া যায়নি।' });
  }

  // Increment article views & daily analytics
  db.prepare('UPDATE news SET views = views + 1 WHERE id = ?').run(article.id);
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO analytics_daily (view_date, total_views) VALUES (?, 1) ON CONFLICT(view_date) DO UPDATE SET total_views = total_views + 1`
  ).run(today);

  article.views = Number(article.views || 0) + 1;

  const related = db
    .prepare(
      `${NEWS_SELECT_SQL} WHERE n.status = 'published' AND n.category_id = ? AND n.id != ? ORDER BY n.published_at DESC LIMIT 4`
    )
    .all(article.category_id, article.id);

  const popular = db
    .prepare(`${NEWS_SELECT_SQL} WHERE n.status = 'published' AND n.id != ? ORDER BY n.views DESC LIMIT 5`)
    .all(article.id);

  res.json({ article, related, popular });
});

app.post('/api/public/subscribe', rateLimit(10, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'অনুগ্রহ করে একটি সঠিক ইমেইল ঠিকানা লিখুন।' });
  }
  try {
    db.prepare('INSERT OR IGNORE INTO subscribers (email) VALUES (?)').run(email);
    res.json({ success: true, message: 'নিউজলেটারে সফলভাবে নিবন্ধিত হয়েছেন।' });
  } catch {
    res.status(500).json({ error: 'নিবন্ধন সম্পন্ন করা যায়নি।' });
  }
});

// ============================================================================
// 2. AUTHENTICATION ROUTES
// ============================================================================

app.post('/api/auth/login', rateLimit(15, 60_000), (req, res) => {
  const identifier = String(req.body?.identifier || req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!identifier || !password) {
    return res.status(400).json({ error: 'ইমেইল/ইউজারনেম এবং পাসওয়ার্ড দিন।' });
  }

  const user = db
    .prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?')
    .get(identifier, identifier) as Record<string, unknown> | undefined;

  if (!user || !bcrypt.compareSync(password, String(user.password_hash))) {
    return res.status(401).json({ error: 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'আপনার অ্যাকাউন্টটি নিষ্ক্রিয় করা হয়েছে।' });
  }

  const token = signToken({
    id: Number(user.id),
    email: String(user.email),
    role: String(user.role),
  });

  res.cookie('ln_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  logActivity(Number(user.id), String(user.name), 'অ্যাডমিন লগইন', 'auth', Number(user.id), `${user.role} প্যানেলে প্রবেশ করেছেন`);

  const { password_hash: _ph, reset_token: _rt, reset_expires: _re, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('ln_token');
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/forgot-password', rateLimit(5, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'ইমেইল ঠিকানা লিখুন।' });

  const user = db.prepare('SELECT id, name, email FROM users WHERE lower(email) = ?').get(email) as
    | { id: number; name: string; email: string }
    | undefined;

  if (!user) {
    // Do not leak user existence in production style
    return res.json({
      success: true,
      message: 'ইমেইলটি নিবন্ধিত থাকলে পাসওয়ার্ড রিসেট কোড প্রদান করা হয়েছে।',
    });
  }

  const token = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char code
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(token, expires, user.id);

  logActivity(user.id, user.name, 'পাসওয়ার্ড রিসেট অনুরোধ', 'auth', user.id, '৬-অক্ষরের রিসেট কোড তৈরি হয়েছে');

  res.json({
    success: true,
    message: 'রিসেট কোড তৈরি হয়েছে। অনুগ্রহ করে অ্যাডমিন প্যানেলে কোডটি ব্যবহার করে নতুন পাসওয়ার্ড সেট করুন।',
    devResetCode: IS_PROD ? undefined : token,
  });
});

app.post('/api/auth/reset-password', rateLimit(10, 60_000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim().toUpperCase();
  const newPassword = String(req.body?.newPassword || '');

  if (!email || !code || newPassword.length < 6) {
    return res.status(400).json({ error: 'সঠিক ইমেইল, রিসেট কোড এবং কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দিন।' });
  }

  const user = db
    .prepare('SELECT id, name, reset_token, reset_expires FROM users WHERE lower(email) = ?')
    .get(email) as { id: number; name: string; reset_token: string | null; reset_expires: string | null } | undefined;

  if (!user || !user.reset_token || user.reset_token !== code) {
    return res.status(400).json({ error: 'রিসেট কোড সঠিক নয়।' });
  }

  if (user.reset_expires && user.reset_expires < new Date().toISOString()) {
    return res.status(400).json({ error: 'রিসেট কোডের মেয়াদ শেষ হয়ে গেছে।' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?').run(hash, user.id);
  logActivity(user.id, user.name, 'পাসওয়ার্ড পরিবর্তন', 'auth', user.id, 'রিসেট কোডের মাধ্যমে পাসওয়ার্ড হালনাগাদ হয়েছে');
  res.json({ success: true, message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে। এখন লগইন করুন।' });
});

app.put('/api/auth/profile', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const { name, designation, avatar_url, bio, current_password, new_password } = req.body || {};

  if (new_password) {
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' });
    }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    if (!current_password || !bcrypt.compareSync(String(current_password), row.password_hash)) {
      return res.status(400).json({ error: 'বর্তমান পাসওয়ার্ড সঠিক নয়।' });
    }
    const hash = bcrypt.hashSync(String(new_password), 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  }

  db.prepare(
    `UPDATE users SET name = ?, designation = ?, avatar_url = ?, bio = ? WHERE id = ?`
  ).run(
    name || user.name,
    designation ?? user.designation ?? '',
    avatar_url ?? user.avatar_url ?? '',
    bio ?? user.bio ?? '',
    user.id
  );

  // Sync reporter profile if linked
  db.prepare(`UPDATE reporters SET name = ?, designation = ?, avatar_url = ?, bio = ? WHERE user_id = ?`).run(
    name || user.name,
    designation ?? user.designation ?? '',
    avatar_url ?? user.avatar_url ?? '',
    bio ?? user.bio ?? '',
    user.id
  );

  const updated = db
    .prepare(
      'SELECT id, name, username, email, role, designation, avatar_url, bio, assigned_categories, is_active, created_at FROM users WHERE id = ?'
    )
    .get(user.id);

  logActivity(user.id, user.name, 'প্রোফাইল হালনাগাদ', 'user', user.id, 'ব্যক্তিগত প্রোফাইল তথ্য আপডেট করা হয়েছে');
  res.json({ user: updated });
});

// ============================================================================
// 3. ADMIN & EDITORIAL API ROUTES
// ============================================================================

app.get('/api/admin/dashboard', requireAuth, (_req, res) => {
  publishDueScheduledNews();
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    publishedCount: (db.prepare("SELECT COUNT(*) as c FROM news WHERE status = 'published'").get() as { c: number }).c,
    draftCount: (db.prepare("SELECT COUNT(*) as c FROM news WHERE status = 'draft'").get() as { c: number }).c,
    pendingCount: (db.prepare("SELECT COUNT(*) as c FROM news WHERE status = 'pending'").get() as { c: number }).c,
    scheduledCount: (db.prepare("SELECT COUNT(*) as c FROM news WHERE status = 'scheduled'").get() as { c: number }).c,
    categoriesCount: (db.prepare('SELECT COUNT(*) as c FROM categories WHERE is_active = 1').get() as { c: number }).c,
    totalViews: (db.prepare('SELECT COALESCE(SUM(views), 0) as v FROM news').get() as { v: number }).v,
    todayViews:
      (db.prepare('SELECT total_views FROM analytics_daily WHERE view_date = ?').get(today) as { total_views: number } | undefined)
        ?.total_views || 0,
    reportersCount: (db.prepare('SELECT COUNT(*) as c FROM reporters WHERE is_active = 1').get() as { c: number }).c,
    activeAdsCount: (db.prepare('SELECT COUNT(*) as c FROM advertisements WHERE is_active = 1').get() as { c: number }).c,
    totalAdsCount: (db.prepare('SELECT COUNT(*) as c FROM advertisements').get() as { c: number }).c,
    subscribersCount: (db.prepare('SELECT COUNT(*) as c FROM subscribers').get() as { c: number }).c,
  };

  const recentActivities = db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 12').all();
  const topArticles = db
    .prepare(`${NEWS_SELECT_SQL} ORDER BY n.views DESC LIMIT 6`)
    .all();

  res.json({ stats, recentActivities, topArticles });
});

// News Management (CRUD)
app.get('/api/admin/news', requireAuth, (req: AuthRequest, res) => {
  publishDueScheduledNews();
  const { status, category_id, search } = req.query as Record<string, string>;
  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (req.user?.role === 'Reporter') {
    const rep = db.prepare('SELECT id FROM reporters WHERE user_id = ?').get(req.user.id) as { id: number } | undefined;
    if (rep) {
      where.push('n.reporter_id = ?');
      params.push(rep.id);
    }
  }
  if (status && status !== 'all') {
    where.push('n.status = ?');
    params.push(status);
  }
  if (category_id) {
    where.push('n.category_id = ?');
    params.push(Number(category_id));
  }
  if (search) {
    where.push('(n.title LIKE ? OR n.slug LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const items = db
    .prepare(`${NEWS_SELECT_SQL} WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC`)
    .all(...params);
  res.json({ items });
});

function resolveReporterId(body: Record<string, unknown>, user: NonNullable<AuthRequest['user']>, fallbackId?: number | null): number {
  const customName = String(body.custom_reporter_name || '').trim();
  if (customName) {
    const existing = db.prepare('SELECT id FROM reporters WHERE lower(name) = lower(?)').get(customName) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;

    const designation = String(body.custom_reporter_designation || '').trim() || 'নিজস্ব প্রতিবেদক';
    const info = db
      .prepare(
        'INSERT INTO reporters (name, designation, email, avatar_url, is_active) VALUES (?, ?, ?, ?, 1)'
      )
      .run(
        customName,
        designation,
        'desk@lalmonirhatnews.com',
        '/src/assets/images/reporter_avatar_senior_1794644387356.jpg'
      );
    return Number(info.lastInsertRowid);
  }

  if (body.reporter_id) return Number(body.reporter_id);
  if (fallbackId) return fallbackId;
  const ownRep = db.prepare('SELECT id FROM reporters WHERE user_id = ?').get(user.id) as { id: number } | undefined;
  return ownRep?.id || 1;
}

app.post('/api/admin/news', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const body = req.body || {};

  if (!body.title || !body.summary || !body.content || !body.category_id) {
    return res.status(400).json({ error: 'শিরোনাম, সারসংক্ষেপ, মূল সংবাদ এবং বিভাগ অবশ্যই দিতে হবে।' });
  }

  let slug = body.slug ? createSlug(String(body.slug)) : createSlug(String(body.title));
  const existingSlug = db.prepare('SELECT id FROM news WHERE slug = ?').get(slug);
  if (existingSlug) {
    slug = `${slug}-${Date.now().toString().slice(-4)}`;
  }

  // Reporters cannot self-publish directly unless approved by Editor/Admin/Super Admin
  let status = String(body.status || 'draft');
  if (user.role === 'Reporter' && status === 'published') {
    status = 'pending';
  }

  const reporterId = resolveReporterId(body, user);

  const nowIso = new Date().toISOString();
  const publishedAt = status === 'published' ? body.published_at || nowIso : null;

  const info = db
    .prepare(
      `INSERT INTO news (
        title, subheadline, slug, summary, content, featured_image, image_caption, gallery_images,
        category_id, subcategory_id, district_area, reporter_id, tags, status,
        is_featured, is_pinned, is_editors_choice, seo_title, seo_description, published_at, scheduled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(body.title).trim(),
      String(body.subheadline || '').trim(),
      slug,
      String(body.summary).trim(),
      String(body.content),
      String(body.featured_image || '/src/assets/images/hero_teesta_bridge_1794644384026.jpg'),
      String(body.image_caption || ''),
      JSON.stringify(Array.isArray(body.gallery_images) ? body.gallery_images : []),
      Number(body.category_id),
      body.subcategory_id ? Number(body.subcategory_id) : null,
      body.district_area || null,
      reporterId,
      String(body.tags || ''),
      status,
      body.is_featured ? 1 : 0,
      body.is_pinned ? 1 : 0,
      body.is_editors_choice ? 1 : 0,
      String(body.seo_title || body.title).trim(),
      String(body.seo_description || body.summary).trim(),
      publishedAt,
      body.scheduled_at || null,
      nowIso,
      nowIso
    );

  const createdId = Number(info.lastInsertRowid);
  const created = db.prepare(`${NEWS_SELECT_SQL} WHERE n.id = ?`).get(createdId);
  logActivity(user.id, user.name, `সংবাদ তৈরি (${status})`, 'news', createdId, String(body.title));
  res.status(201).json({ article: created });
});

app.put('/api/admin/news/:id', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM news WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'সংবাদটি পাওয়া যায়নি।' });

  if (user.role === 'Reporter') {
    const rep = db.prepare('SELECT id FROM reporters WHERE user_id = ?').get(user.id) as { id: number } | undefined;
    if (!rep || Number(existing.reporter_id) !== rep.id) {
      return res.status(403).json({ error: 'আপনি শুধুমাত্র আপনার নিজের লেখা সংবাদ সম্পাদনা করতে পারবেন।' });
    }
  }

  const body = req.body || {};
  let nextStatus = body.status !== undefined ? String(body.status) : String(existing.status);
  if (user.role === 'Reporter' && nextStatus === 'published') {
    nextStatus = 'pending';
  }

  const nowIso = new Date().toISOString();
  const nextPublishedAt =
    nextStatus === 'published' ? (existing.published_at as string) || body.published_at || nowIso : (existing.published_at as string | null);

  let slug = body.slug ? createSlug(String(body.slug)) : String(existing.slug);
  const dup = db.prepare('SELECT id FROM news WHERE slug = ? AND id != ?').get(slug, id);
  if (dup) slug = `${slug}-${id}`;

  db.prepare(
    `UPDATE news SET
      title = ?, subheadline = ?, slug = ?, summary = ?, content = ?,
      featured_image = ?, image_caption = ?, gallery_images = ?,
      category_id = ?, subcategory_id = ?, district_area = ?, reporter_id = ?, tags = ?,
      status = ?, is_featured = ?, is_pinned = ?, is_editors_choice = ?,
      seo_title = ?, seo_description = ?, published_at = ?, scheduled_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    body.title ?? existing.title,
    body.subheadline ?? existing.subheadline,
    slug,
    body.summary ?? existing.summary,
    body.content ?? existing.content,
    body.featured_image ?? existing.featured_image,
    body.image_caption ?? existing.image_caption,
    body.gallery_images !== undefined
      ? JSON.stringify(Array.isArray(body.gallery_images) ? body.gallery_images : [])
      : existing.gallery_images,
    body.category_id !== undefined ? Number(body.category_id) : existing.category_id,
    body.subcategory_id !== undefined ? (body.subcategory_id ? Number(body.subcategory_id) : null) : existing.subcategory_id,
    body.district_area !== undefined ? body.district_area : existing.district_area,
    resolveReporterId(body, user, Number(existing.reporter_id)),
    body.tags ?? existing.tags,
    nextStatus,
    body.is_featured !== undefined ? (body.is_featured ? 1 : 0) : existing.is_featured,
    body.is_pinned !== undefined ? (body.is_pinned ? 1 : 0) : existing.is_pinned,
    body.is_editors_choice !== undefined ? (body.is_editors_choice ? 1 : 0) : existing.is_editors_choice,
    body.seo_title ?? existing.seo_title,
    body.seo_description ?? existing.seo_description,
    nextPublishedAt,
    body.scheduled_at !== undefined ? body.scheduled_at : existing.scheduled_at,
    nowIso,
    id
  );

  const updated = db.prepare(`${NEWS_SELECT_SQL} WHERE n.id = ?`).get(id);
  logActivity(user.id, user.name, `সংবাদ হালনাগাদ (${nextStatus})`, 'news', id, String(body.title ?? existing.title));
  res.json({ article: updated });
});

app.delete('/api/admin/news/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT title FROM news WHERE id = ?').get(id) as { title: string } | undefined;
  db.prepare('DELETE FROM news WHERE id = ?').run(id);
  logActivity(req.user!.id, req.user!.name, 'সংবাদ মুছে ফেলা হয়েছে', 'news', id, row?.title || '');
  res.json({ success: true });
});

// Breaking News Management
app.get('/api/admin/breaking', requireAuth, (_req, res) => {
  const items = db
    .prepare(
      `SELECT b.*, n.slug as article_slug, n.title as article_title FROM breaking_news b LEFT JOIN news n ON b.article_id = n.id ORDER BY b.priority ASC, b.display_order ASC, b.id DESC`
    )
    .all();
  res.json({ items });
});

app.post('/api/admin/breaking', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req: AuthRequest, res) => {
  const { headline, article_id, priority = 1, display_order = 0, is_active = 1, starts_at = null, expires_at = null } = req.body || {};
  if (!headline) return res.status(400).json({ error: 'ব্রেকিং নিউজের শিরোনাম দিন।' });
  const info = db
    .prepare(
      `INSERT INTO breaking_news (headline, article_id, priority, display_order, is_active, starts_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(headline, article_id ? Number(article_id) : null, Number(priority), Number(display_order), is_active ? 1 : 0, starts_at || null, expires_at || null);
  logActivity(req.user!.id, req.user!.name, 'ব্রেকিং নিউজ যুক্ত', 'breaking', Number(info.lastInsertRowid), headline);
  res.status(201).json({ item: db.prepare('SELECT * FROM breaking_news WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/admin/breaking/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM breaking_news WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: 'পাওয়া যায়নি।' });
  const b = req.body || {};
  db.prepare(
    `UPDATE breaking_news SET headline = ?, article_id = ?, priority = ?, display_order = ?, is_active = ?, starts_at = ?, expires_at = ? WHERE id = ?`
  ).run(
    b.headline ?? existing.headline,
    b.article_id !== undefined ? (b.article_id ? Number(b.article_id) : null) : existing.article_id,
    b.priority !== undefined ? Number(b.priority) : existing.priority,
    b.display_order !== undefined ? Number(b.display_order) : existing.display_order,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active,
    b.starts_at !== undefined ? b.starts_at || null : existing.starts_at,
    b.expires_at !== undefined ? b.expires_at || null : existing.expires_at,
    id
  );
  res.json({ item: db.prepare('SELECT * FROM breaking_news WHERE id = ?').get(id) });
});

app.delete('/api/admin/breaking/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  db.prepare('DELETE FROM breaking_news WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// Categories & Subcategories
app.get('/api/admin/categories', requireAuth, (_req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY display_order ASC, id ASC').all();
  const subcategories = db
    .prepare('SELECT s.*, c.name as category_name FROM subcategories s LEFT JOIN categories c ON s.category_id = c.id ORDER BY s.display_order ASC')
    .all();
  res.json({ categories, subcategories });
});

app.post('/api/admin/categories', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req: AuthRequest, res) => {
  const { name, slug, description = '', display_order = 0, is_active = 1, show_in_nav = 1 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'ক্যাটাগরির নাম দিন।' });
  const finalSlug = slug ? createSlug(slug) : createSlug(name);
  const info = db
    .prepare('INSERT INTO categories (name, slug, description, display_order, is_active, show_in_nav) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, finalSlug, description, Number(display_order), is_active ? 1 : 0, show_in_nav ? 1 : 0);
  logActivity(req.user!.id, req.user!.name, 'নতুন ক্যাটাগরি তৈরি', 'category', Number(info.lastInsertRowid), name);
  res.status(201).json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/admin/categories/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!ex) return res.status(404).json({ error: 'পাওয়া যায়নি।' });
  const b = req.body || {};
  db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, display_order = ?, is_active = ?, show_in_nav = ? WHERE id = ?').run(
    b.name ?? ex.name,
    b.slug ? createSlug(b.slug) : ex.slug,
    b.description ?? ex.description,
    b.display_order !== undefined ? Number(b.display_order) : ex.display_order,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : ex.is_active,
    b.show_in_nav !== undefined ? (b.show_in_nav ? 1 : 0) : ex.show_in_nav,
    id
  );
  res.json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
});

app.delete('/api/admin/categories/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  const id = Number(req.params.id);
  const count = (db.prepare('SELECT COUNT(*) as c FROM news WHERE category_id = ?').get(id) as { c: number }).c;
  if (count > 0) {
    return res.status(400).json({ error: `এই ক্যাটাগরিতে ${count}টি সংবাদ রয়েছে। আগে সংবাদগুলো অন্য ক্যাটাগরিতে সরান।` });
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ success: true });
});

app.post('/api/admin/subcategories', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const { category_id, name, slug, display_order = 0, is_active = 1 } = req.body || {};
  if (!category_id || !name) return res.status(400).json({ error: 'মূল ক্যাটাগরি এবং সাব-ক্যাটাগরির নাম দিন।' });
  const info = db
    .prepare('INSERT INTO subcategories (category_id, name, slug, display_order, is_active) VALUES (?, ?, ?, ?, ?)')
    .run(Number(category_id), name, slug ? createSlug(slug) : createSlug(name), Number(display_order), is_active ? 1 : 0);
  res.status(201).json({ subcategory: db.prepare('SELECT * FROM subcategories WHERE id = ?').get(info.lastInsertRowid) });
});

app.delete('/api/admin/subcategories/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  db.prepare('DELETE FROM subcategories WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// Reporters Management
app.get('/api/admin/reporters', requireAuth, (_req, res) => {
  const items = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM news n WHERE n.reporter_id = r.id) as article_count FROM reporters r ORDER BY r.id DESC`
    )
    .all();
  res.json({ items });
});

app.post('/api/admin/reporters', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req: AuthRequest, res) => {
  const { name, designation, email, phone = '', avatar_url = '', bio = '', assigned_categories = '', is_active = 1 } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'সাংবাদিকের নাম ও ইমেইল দিন।' });
  const info = db
    .prepare(
      'INSERT INTO reporters (name, designation, email, phone, avatar_url, bio, assigned_categories, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      name,
      designation || 'সংবাদদাতা',
      email,
      phone,
      avatar_url || '/src/assets/images/reporter_avatar_senior_1794644387356.jpg',
      bio,
      assigned_categories,
      is_active ? 1 : 0
    );
  logActivity(req.user!.id, req.user!.name, 'প্রতিবেদক যুক্ত', 'reporter', Number(info.lastInsertRowid), name);
  res.status(201).json({ item: db.prepare('SELECT * FROM reporters WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/admin/reporters/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM reporters WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!ex) return res.status(404).json({ error: 'পাওয়া যায়নি।' });
  const b = req.body || {};
  db.prepare(
    'UPDATE reporters SET name = ?, designation = ?, email = ?, phone = ?, avatar_url = ?, bio = ?, assigned_categories = ?, is_active = ? WHERE id = ?'
  ).run(
    b.name ?? ex.name,
    b.designation ?? ex.designation,
    b.email ?? ex.email,
    b.phone ?? ex.phone,
    b.avatar_url ?? ex.avatar_url,
    b.bio ?? ex.bio,
    b.assigned_categories ?? ex.assigned_categories,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : ex.is_active,
    id
  );
  res.json({ item: db.prepare('SELECT * FROM reporters WHERE id = ?').get(id) });
});

app.delete('/api/admin/reporters/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  db.prepare('DELETE FROM reporters WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// Media Library & Real File Upload
app.get('/api/admin/media', requireAuth, (req, res) => {
  const search = String(req.query.search || '').trim();
  const items = search
    ? db
        .prepare('SELECT * FROM media WHERE filename LIKE ? OR alt_text LIKE ? OR caption LIKE ? ORDER BY id DESC')
        .all(`%${search}%`, `%${search}%`, `%${search}%`)
    : db.prepare('SELECT * FROM media ORDER BY id DESC').all();
  res.json({ items });
});

app.post('/api/admin/upload', requireAuth, upload.single('file'), (req: AuthRequest, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'কোনো ফাইল নির্বাচন করা হয়নি।' });
  }
  const url = `/uploads/${req.file.filename}`;
  const altText = String(req.body?.alt_text || req.file.originalname);
  const caption = String(req.body?.caption || '');
  const info = db
    .prepare('INSERT INTO media (filename, url, mime_type, size_bytes, alt_text, caption, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.file.originalname, url, req.file.mimetype, req.file.size, altText, caption, req.user!.id);

  logActivity(req.user!.id, req.user!.name, 'মিডিয়া আপলোড', 'media', Number(info.lastInsertRowid), req.file.originalname);
  res.status(201).json({ item: db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/admin/media/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { alt_text, caption } = req.body || {};
  db.prepare('UPDATE media SET alt_text = ?, caption = ? WHERE id = ?').run(alt_text || '', caption || '', id);
  res.json({ item: db.prepare('SELECT * FROM media WHERE id = ?').get(id) });
});

app.delete('/api/admin/media/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT url FROM media WHERE id = ?').get(id) as { url: string } | undefined;
  if (item && item.url.startsWith('/uploads/')) {
    const filePath = path.join(process.cwd(), item.url.replace(/^\//, ''));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('DELETE FROM media WHERE id = ?').run(id);
  res.json({ success: true });
});

// Advertisement Management (Strictly Super Admin & Admin only)
app.get('/api/admin/ads', requireAuth, requireRole(['Super Admin', 'Admin']), (_req, res) => {
  const items = db.prepare('SELECT * FROM advertisements ORDER BY priority ASC, id ASC').all();
  res.json({ items });
});

app.post('/api/admin/ads', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const { name, placement, ad_type = 'banner', code = '', device_target = 'all', priority = 1, is_active = 0, start_date = null, end_date = null } =
    req.body || {};
  if (!name || !placement) return res.status(400).json({ error: 'বিজ্ঞাপনের নাম ও প্লেসমেন্ট নির্বাচন করুন।' });
  const nowIso = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO advertisements (name, placement, ad_type, code, device_target, priority, is_active, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(name, placement, ad_type, code, device_target, Number(priority), is_active ? 1 : 0, start_date || null, end_date || null, nowIso, nowIso);
  logActivity(req.user!.id, req.user!.name, 'নতুন বিজ্ঞাপন যুক্ত', 'advertisement', Number(info.lastInsertRowid), `${name} (${placement})`);
  res.status(201).json({ item: db.prepare('SELECT * FROM advertisements WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/admin/ads/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM advertisements WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!ex) return res.status(404).json({ error: 'পাওয়া যায়নি।' });
  const b = req.body || {};
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE advertisements SET name = ?, placement = ?, ad_type = ?, code = ?, device_target = ?, priority = ?, is_active = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`
  ).run(
    b.name ?? ex.name,
    b.placement ?? ex.placement,
    b.ad_type ?? ex.ad_type,
    b.code !== undefined ? String(b.code) : ex.code,
    b.device_target ?? ex.device_target,
    b.priority !== undefined ? Number(b.priority) : ex.priority,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : ex.is_active,
    b.start_date !== undefined ? b.start_date || null : ex.start_date,
    b.end_date !== undefined ? b.end_date || null : ex.end_date,
    nowIso,
    id
  );
  logActivity(req.user!.id, req.user!.name, 'বিজ্ঞাপন আপডেট', 'advertisement', id, String(b.name ?? ex.name));
  res.json({ item: db.prepare('SELECT * FROM advertisements WHERE id = ?').get(id) });
});

app.delete('/api/admin/ads/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  db.prepare('DELETE FROM advertisements WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// Website Settings & Social Links
app.get('/api/admin/settings', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (_req, res) => {
  res.json({ settings: getSettingsMap(), socialLinks: getSocialMap() });
});

app.put('/api/admin/settings', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const updates = req.body?.settings || req.body || {};
  const stmt = db.prepare(
    'INSERT INTO website_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value'
  );
  const tx = db.transaction((obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      stmt.run(k, String(v ?? ''));
    }
  });
  tx(updates);
  logActivity(req.user!.id, req.user!.name, 'ওয়েবসাইট সেটিংস পরিবর্তন', 'settings', null, 'সাইট সেটিংস আপডেট করা হয়েছে');
  res.json({ settings: getSettingsMap() });
});

app.put('/api/admin/social', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const updates = req.body?.socialLinks || req.body || {};
  const stmt = db.prepare(
    'INSERT INTO social_links (link_key, link_value) VALUES (?, ?) ON CONFLICT(link_key) DO UPDATE SET link_value = excluded.link_value'
  );
  const tx = db.transaction((obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      stmt.run(k, String(v ?? ''));
    }
  });
  tx(updates);
  logActivity(req.user!.id, req.user!.name, 'সোশ্যাল মিডিয়া সেটিংস আপডেট', 'social', null, 'সোশ্যাল লিংক হালনাগাদ হয়েছে');
  res.json({ socialLinks: getSocialMap() });
});

// Homepage Sections & Menu Management
app.get('/api/admin/homepage-sections', requireAuth, (_req, res) => {
  res.json({ items: db.prepare('SELECT * FROM homepage_sections ORDER BY display_order ASC').all() });
});

app.put('/api/admin/homepage-sections/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const ex = db.prepare('SELECT * FROM homepage_sections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!ex) return res.status(404).json({ error: 'পাওয়া যায়নি।' });
  db.prepare('UPDATE homepage_sections SET title = ?, item_limit = ?, display_order = ?, is_active = ? WHERE id = ?').run(
    b.title ?? ex.title,
    b.item_limit !== undefined ? Number(b.item_limit) : ex.item_limit,
    b.display_order !== undefined ? Number(b.display_order) : ex.display_order,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : ex.is_active,
    id
  );
  res.json({ item: db.prepare('SELECT * FROM homepage_sections WHERE id = ?').get(id) });
});

app.get('/api/admin/menus', requireAuth, (_req, res) => {
  res.json({ items: db.prepare('SELECT * FROM menu_items ORDER BY display_order ASC, id ASC').all() });
});

app.post('/api/admin/menus', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  const { label, url, category_slug = null, display_order = 0, is_active = 1, open_in_new_tab = 0 } = req.body || {};
  if (!label || !url) return res.status(400).json({ error: 'মেনু নাম ও লিংক দিন।' });
  const info = db
    .prepare('INSERT INTO menu_items (label, url, category_slug, display_order, is_active, open_in_new_tab) VALUES (?, ?, ?, ?, ?, ?)')
    .run(label, url, category_slug, Number(display_order), is_active ? 1 : 0, open_in_new_tab ? 1 : 0);
  res.status(201).json({ item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(info.lastInsertRowid) });
});

app.put('/api/admin/menus/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!ex) return res.status(404).json({ error: 'পাওয়া যায়নি।' });
  const b = req.body || {};
  db.prepare('UPDATE menu_items SET label = ?, url = ?, display_order = ?, is_active = ?, open_in_new_tab = ? WHERE id = ?').run(
    b.label ?? ex.label,
    b.url ?? ex.url,
    b.display_order !== undefined ? Number(b.display_order) : ex.display_order,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : ex.is_active,
    b.open_in_new_tab !== undefined ? (b.open_in_new_tab ? 1 : 0) : ex.open_in_new_tab,
    id
  );
  res.json({ item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) });
});

app.delete('/api/admin/menus/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// Photo Gallery & Video News Management
app.get('/api/admin/gallery', requireAuth, (_req, res) => {
  res.json({ items: db.prepare('SELECT * FROM photo_gallery ORDER BY id DESC').all() });
});

app.post('/api/admin/gallery', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const { title, image_url, caption = '', photographer = '' } = req.body || {};
  if (!title || !image_url) return res.status(400).json({ error: 'শিরোনাম ও ছবির লিংক দিন।' });
  const info = db
    .prepare('INSERT INTO photo_gallery (title, image_url, caption, photographer) VALUES (?, ?, ?, ?)')
    .run(title, image_url, caption, photographer);
  res.status(201).json({ item: db.prepare('SELECT * FROM photo_gallery WHERE id = ?').get(info.lastInsertRowid) });
});

app.delete('/api/admin/gallery/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  db.prepare('DELETE FROM photo_gallery WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

app.get('/api/admin/videos', requireAuth, (_req, res) => {
  res.json({ items: db.prepare('SELECT * FROM video_news ORDER BY id DESC').all() });
});

app.post('/api/admin/videos', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  const { title, youtube_url, thumbnail_url, duration = '03:00', category_name = 'লালমনিরহাট' } = req.body || {};
  if (!title || !youtube_url) return res.status(400).json({ error: 'শিরোনাম ও ইউটিউব লিংক দিন।' });
  const info = db
    .prepare('INSERT INTO video_news (title, youtube_url, thumbnail_url, duration, category_name) VALUES (?, ?, ?, ?, ?)')
    .run(title, youtube_url, thumbnail_url || '/src/assets/images/hero_teesta_bridge_1794644384026.jpg', duration, category_name);
  res.status(201).json({ item: db.prepare('SELECT * FROM video_news WHERE id = ?').get(info.lastInsertRowid) });
});

app.delete('/api/admin/videos/:id', requireAuth, requireRole(['Super Admin', 'Admin', 'Editor']), (req, res) => {
  db.prepare('DELETE FROM video_news WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// User Management (Super Admin & Admin)
app.get('/api/admin/users', requireAuth, requireRole(['Super Admin', 'Admin']), (_req, res) => {
  const items = db
    .prepare(
      'SELECT id, name, username, email, role, designation, avatar_url, bio, assigned_categories, is_active, created_at FROM users ORDER BY id ASC'
    )
    .all();
  res.json({ items });
});

app.post('/api/admin/users', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const { name, username, email, password, role = 'Reporter', designation = 'সংবাদদাতা', assigned_categories = '' } = req.body || {};
  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'নাম, ইউজারনেম, ইমেইল এবং পাসওয়ার্ড দিন।' });
  }
  if (role === 'Super Admin' && req.user!.role !== 'Super Admin') {
    return res.status(403).json({ error: 'শুধুমাত্র সুপার অ্যাডমিন নতুন সুপার অ্যাডমিন তৈরি করতে পারেন।' });
  }
  const hash = bcrypt.hashSync(String(password), 10);
  try {
    const info = db
      .prepare(
        'INSERT INTO users (name, username, email, password_hash, role, designation, avatar_url, assigned_categories) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        name,
        username.toLowerCase(),
        email.toLowerCase(),
        hash,
        role,
        designation,
        '/src/assets/images/reporter_avatar_senior_1794644387356.jpg',
        assigned_categories
      );

    if (role === 'Reporter' || role === 'Editor') {
      db.prepare('INSERT INTO reporters (user_id, name, designation, email, avatar_url, assigned_categories) VALUES (?, ?, ?, ?, ?, ?)').run(
        Number(info.lastInsertRowid),
        name,
        designation,
        email.toLowerCase(),
        '/src/assets/images/reporter_avatar_senior_1794644387356.jpg',
        assigned_categories
      );
    }

    logActivity(req.user!.id, req.user!.name, 'নতুন ব্যবহারকারী তৈরি', 'user', Number(info.lastInsertRowid), `${name} (${role})`);
    const created = db
      .prepare(
        'SELECT id, name, username, email, role, designation, avatar_url, bio, assigned_categories, is_active, created_at FROM users WHERE id = ?'
      )
      .get(info.lastInsertRowid);
    res.status(201).json({ item: created });
  } catch {
    res.status(400).json({ error: 'এই ইমেইল বা ইউজারনেম ইতোমধ্যেই ব্যবহৃত হচ্ছে।' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!ex) return res.status(404).json({ error: 'ব্যবহারকারী পাওয়া যায়নি।' });
  const b = req.body || {};
  if (b.password) {
    const hash = bcrypt.hashSync(String(b.password), 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }
  db.prepare('UPDATE users SET name = ?, role = ?, designation = ?, assigned_categories = ?, is_active = ? WHERE id = ?').run(
    b.name ?? ex.name,
    b.role ?? ex.role,
    b.designation ?? ex.designation,
    b.assigned_categories ?? ex.assigned_categories,
    b.is_active !== undefined ? (b.is_active ? 1 : 0) : ex.is_active,
    id
  );
  const updated = db
    .prepare(
      'SELECT id, name, username, email, role, designation, avatar_url, bio, assigned_categories, is_active, created_at FROM users WHERE id = ?'
    )
    .get(id);
  res.json({ item: updated });
});

app.delete('/api/admin/users/:id', requireAuth, requireRole(['Super Admin']), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) return res.status(400).json({ error: 'নিজের অ্যাকাউন্ট মুছে ফেলা যাবে না।' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true });
});

// Analytics
app.get('/api/admin/analytics', requireAuth, (_req, res) => {
  const daily = db.prepare('SELECT * FROM analytics_daily ORDER BY view_date ASC LIMIT 14').all();
  const byCategory = db
    .prepare(
      `SELECT c.name, c.slug, COUNT(n.id) as article_count, COALESCE(SUM(n.views), 0) as total_views
       FROM categories c LEFT JOIN news n ON c.id = n.category_id AND n.status = 'published'
       GROUP BY c.id ORDER BY total_views DESC`
    )
    .all();
  const topNews = db.prepare(`${NEWS_SELECT_SQL} WHERE n.status = 'published' ORDER BY n.views DESC LIMIT 10`).all();
  res.json({ daily, byCategory, topNews });
});

// Backup & Restore
app.get('/api/admin/backup', requireAuth, requireRole(['Super Admin', 'Admin']), (req: AuthRequest, res) => {
  const dump = {
    exported_at: new Date().toISOString(),
    version: '1.0',
    categories: db.prepare('SELECT * FROM categories').all(),
    subcategories: db.prepare('SELECT * FROM subcategories').all(),
    reporters: db.prepare('SELECT * FROM reporters').all(),
    news: db.prepare('SELECT * FROM news').all(),
    breaking_news: db.prepare('SELECT * FROM breaking_news').all(),
    media: db.prepare('SELECT * FROM media').all(),
    advertisements: db.prepare('SELECT * FROM advertisements').all(),
    website_settings: db.prepare('SELECT * FROM website_settings').all(),
    social_links: db.prepare('SELECT * FROM social_links').all(),
    menu_items: db.prepare('SELECT * FROM menu_items').all(),
    homepage_sections: db.prepare('SELECT * FROM homepage_sections').all(),
    photo_gallery: db.prepare('SELECT * FROM photo_gallery').all(),
    video_news: db.prepare('SELECT * FROM video_news').all(),
  };
  logActivity(req.user!.id, req.user!.name, 'ডাটাবেস ব্যাকআপ ডাউনলোড', 'backup', null, 'সম্পূর্ণ ডাটাবেস JSON স্ন্যাপশট নেওয়া হয়েছে');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lalmonirhat-news-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(dump, null, 2));
});

app.post('/api/admin/restore', requireAuth, requireRole(['Super Admin']), (req: AuthRequest, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.news)) {
    return res.status(400).json({ error: 'সঠিক ব্যাকআপ JSON ফাইল নয়।' });
  }
  const tx = db.transaction(() => {
    if (Array.isArray(data.website_settings)) {
      const sStmt = db.prepare(
        'INSERT INTO website_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value'
      );
      for (const s of data.website_settings) sStmt.run(s.setting_key, s.setting_value);
    }
    if (Array.isArray(data.social_links)) {
      const slStmt = db.prepare(
        'INSERT INTO social_links (link_key, link_value) VALUES (?, ?) ON CONFLICT(link_key) DO UPDATE SET link_value = excluded.link_value'
      );
      for (const sl of data.social_links) slStmt.run(sl.link_key, sl.link_value);
    }
  });
  tx();
  logActivity(req.user!.id, req.user!.name, 'ব্যাকআপ পুনরুদ্ধার', 'backup', null, 'ব্যাকআপ থেকে সেটিংস পুনরুদ্ধার সম্পন্ন');
  res.json({ success: true, message: 'ব্যাকআপ থেকে সেটিংস সফলভাবে পুনরুদ্ধার করা হয়েছে।' });
});

// OG Preview Debugger Helper
app.get('/api/admin/og-preview/:slug', requireAuth, (req, res) => {
  const slug = decodeURIComponent(req.params.slug);
  const article = db.prepare(`${NEWS_SELECT_SQL} WHERE n.slug = ?`).get(slug) as Record<string, unknown> | undefined;
  if (!article) return res.status(404).json({ error: 'সংবাদ পাওয়া যায়নি' });

  const articleUrl = `${getBaseUrl(req)}/news/${encodeURIComponent(String(article.slug))}`;
  const ogImage = toAbsoluteUrl(req, String(article.featured_image || ''));
  res.json({
    ogTitle: article.seo_title || article.title,
    ogDescription: article.seo_description || article.summary,
    ogImage,
    ogUrl: articleUrl,
    ogType: 'article',
    twitterCard: 'summary_large_image',
    facebookDebuggerUrl: `https://developers.facebook.com/tools/debug/?q=${encodeURIComponent(articleUrl)}`,
  });
});

// Deployment Status & Live Netlify ZIP Package Generator
app.get('/api/admin/deployment-status', requireAuth, requireRole(['Super Admin', 'Admin']), (req, res) => {
  const distExists = fs.existsSync(path.join(process.cwd(), 'dist', 'index.html'));
  const netlifyTomlExists = fs.existsSync(path.join(process.cwd(), 'netlify.toml'));
  const functionsExist = fs.existsSync(path.join(process.cwd(), 'netlify', 'functions', 'og-meta.ts'));
  const migrationExists = fs.existsSync(path.join(process.cwd(), 'supabase', 'migrations', '001_initial_schema.sql'));
  res.json({
    appUrl: getBaseUrl(req),
    distBuilt: distExists,
    netlifyTomlExists,
    functionsExist,
    migrationExists,
    hasNetlifyHook: Boolean(process.env.NETLIFY_BUILD_HOOK_URL),
    hasSupabaseConfig: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
});

app.post('/api/admin/trigger-netlify', requireAuth, requireRole(['Super Admin', 'Admin']), async (req: AuthRequest, res) => {
  const hookUrl = String(req.body?.hookUrl || process.env.NETLIFY_BUILD_HOOK_URL || '').trim();
  if (!hookUrl || !hookUrl.startsWith('https://api.netlify.com/build_hooks/')) {
    return res.status(400).json({
      error: 'সঠিক Netlify Build Hook URL সেট করা নেই (https://api.netlify.com/build_hooks/...)।',
    });
  }
  try {
    const resp = await fetch(hookUrl, { method: 'POST' });
    if (!resp.ok) throw new Error(`Netlify returned ${resp.status}`);
    logActivity(req.user!.id, req.user!.name, 'Netlify বিল্ড ট্রিগার', 'deployment', null, 'নতুন Netlify ডিপ্লয়মেন্ট শুরু হয়েছে');
    res.json({ success: true, message: 'Netlify বিল্ড এবং ডিপ্লয়মেন্ট সফলভাবে ট্রিগার হয়েছে!' });
  } catch (err) {
    res.status(502).json({ error: `Netlify বিল্ড ট্রিগার ব্যর্থ: ${err instanceof Error ? err.message : 'Unknown error'}` });
  }
});

function addDirectoryToZip(zip: JSZip, dirPath: string, zipFolder: string) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
    const full = path.join(dirPath, entry.name);
    const rel = zipFolder ? `${zipFolder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, full, rel);
    } else {
      zip.file(rel, fs.readFileSync(full));
    }
  }
}

app.get('/api/admin/export-zip', requireAuth, requireRole(['Super Admin', 'Admin']), async (req: AuthRequest, res) => {
  try {
    const zip = new JSZip();
    const root = process.cwd();
    const rootFiles = [
      'package.json',
      'netlify.toml',
      'tsconfig.json',
      'vite.config.ts',
      'index.html',
      'metadata.json',
      '.env.example',
      'README.md',
      'server.ts',
    ];
    for (const f of rootFiles) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) zip.file(f, fs.readFileSync(p));
    }

    addDirectoryToZip(zip, path.join(root, 'src'), 'src');
    addDirectoryToZip(zip, path.join(root, 'server'), 'server');
    addDirectoryToZip(zip, path.join(root, 'netlify'), 'netlify');
    addDirectoryToZip(zip, path.join(root, 'supabase'), 'supabase');
    if (fs.existsSync(path.join(root, 'dist'))) {
      addDirectoryToZip(zip, path.join(root, 'dist'), 'dist');
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    logActivity(req.user!.id, req.user!.name, 'Netlify ZIP ডাউনলোড', 'deployment', null, 'সম্পূর্ণ ডিপ্লয়েবল সোর্স ও বিল্ড ZIP ডাউনলোড হয়েছে');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="lalmonirhat-news-netlify-ready.zip"');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: `ZIP তৈরি করতে ব্যর্থ: ${err instanceof Error ? err.message : 'Error'}` });
  }
});

// ============================================================================
// 4. DYNAMIC SEO ROUTES (SITEMAPS & ROBOTS.TXT)
// ============================================================================

app.get('/robots.txt', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${baseUrl}/sitemap.xml\nSitemap: ${baseUrl}/news-sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const categories = db.prepare('SELECT slug FROM categories WHERE is_active = 1').all() as Array<{ slug: string }>;
  const articles = db
    .prepare("SELECT slug, updated_at, published_at FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 500")
    .all() as Array<{ slug: string; updated_at: string; published_at: string }>;

  const urls = [
    `<url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    ...categories.map(
      (c) => `<url><loc>${baseUrl}/category/${encodeURIComponent(c.slug)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`
    ),
    ...articles.map(
      (a) =>
        `<url><loc>${baseUrl}/news/${encodeURIComponent(a.slug)}</loc><lastmod>${new Date(
          a.updated_at || a.published_at || Date.now()
        ).toISOString()}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>`
    ),
  ];

  res
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

app.get('/news-sitemap.xml', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const articles = db
    .prepare("SELECT title, slug, published_at FROM news WHERE status = 'published' ORDER BY published_at DESC LIMIT 100")
    .all() as Array<{ title: string; slug: string; published_at: string }>;

  const items = articles
    .map(
      (a) => `  <url>
    <loc>${baseUrl}/news/${encodeURIComponent(a.slug)}</loc>
    <news:news>
      <news:publication>
        <news:name>লালমনিরহাট নিউজ</news:name>
        <news:language>bn</news:language>
      </news:publication>
      <news:publication_date>${new Date(a.published_at || Date.now()).toISOString()}</news:publication_date>
      <news:title>${escapeHtml(a.title)}</news:title>
    </news:news>
  </url>`
    )
    .join('\n');

  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${items}\n</urlset>`
    );
});

// ============================================================================
// 5. SERVER-SIDE OPEN GRAPH INJECTION & VITE/STATIC FRONTEND SERVING
// ============================================================================

async function startServer() {
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (!IS_PROD) {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist'), { index: false }));
  }

  // Server-Side Open Graph metadata injection for Facebook Sharing Debugger & crawlers
  app.get('/news/:slug', async (req, res, next) => {
    try {
      const slug = decodeURIComponent(req.params.slug);
      const article = db
        .prepare(`${NEWS_SELECT_SQL} WHERE n.slug = ? AND n.status = 'published'`)
        .get(slug) as Record<string, unknown> | undefined;

      const templatePath = IS_PROD
        ? path.join(process.cwd(), 'dist', 'index.html')
        : path.join(process.cwd(), 'index.html');
      let html = fs.readFileSync(templatePath, 'utf-8');
      if (vite) {
        html = await vite.transformIndexHtml(req.originalUrl, html);
      }

      if (article) {
        const baseUrl = getBaseUrl(req);
        const articleUrl = `${baseUrl}/news/${encodeURIComponent(String(article.slug))}`;
        const absImg = toAbsoluteUrl(req, String(article.featured_image || '/src/assets/images/hero_teesta_bridge_1794644384026.jpg'));
        const seoTitle = escapeHtml(String(article.seo_title || article.title));
        const seoDesc = escapeHtml(String(article.seo_description || article.summary || ''));

        const jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'NewsArticle',
          headline: String(article.title),
          description: String(article.summary),
          image: [absImg],
          datePublished: article.published_at,
          dateModified: article.updated_at,
          mainEntityOfPage: articleUrl,
          author: {
            '@type': 'Person',
            name: String(article.reporter_name || 'লালমনিরহাট নিউজ ডেস্ক'),
          },
          publisher: {
            '@type': 'Organization',
            name: 'লালমনিরহাট নিউজ (Lalmonirhat News)',
            url: baseUrl,
          },
        };

        const ogTags = `
    <title>${seoTitle} | লালমনিরহাট নিউজ</title>
    <meta name="description" content="${seoDesc}" />
    <link rel="canonical" href="${articleUrl}" />
    <meta property="og:site_name" content="লালমনিরহাট নিউজ (Lalmonirhat News)" />
    <meta property="og:locale" content="bn_BD" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${seoTitle}" />
    <meta property="og:description" content="${seoDesc}" />
    <meta property="og:url" content="${articleUrl}" />
    <meta property="og:image" content="${absImg}" />
    <meta property="og:image:secure_url" content="${absImg}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="article:published_time" content="${String(article.published_at || '')}" />
    <meta property="article:modified_time" content="${String(article.updated_at || '')}" />
    <meta property="article:section" content="${escapeHtml(String(article.category_name || ''))}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${seoTitle}" />
    <meta name="twitter:description" content="${seoDesc}" />
    <meta name="twitter:image" content="${absImg}" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

        html = html.replace(/<title>[\s\S]*?<\/title>/i, '');
        html = html.replace(/<meta[^>]+property=["']og:[^"']+["'][^>]*>/gi, '');
        html = html.replace(/<meta[^>]+name=["']twitter:[^"']+["'][^>]*>/gi, '');
        html = html.replace(/<meta[^>]+name=["']description["'][^>]*>/gi, '');
        html = html.replace('</head>', `${ogTags}\n  </head>`);
      }

      res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } catch (err) {
      next(err);
    }
  });

  if (vite) {
    app.use(vite.middlewares);
  } else {
    app.get('*', (_req, res) => {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Lalmonirhat News server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
