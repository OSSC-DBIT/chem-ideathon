import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db } from './src/db.js';
import { securityHeaders, sameOrigin, rateLimit, adminConfigured } from './src/security.js';
import { router as publicRoutes } from './src/public-routes.js';
import { router as adminRoutes } from './src/admin-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

// TRUST_PROXY=1 when exactly one reverse proxy (the bundled nginx) sits in front.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp);
}

app.use(securityHeaders);
app.get('/healthz', (req, res) => res.json({ ok: true }));

// API: same origin writes only, a general rate limit, then the routers
// (each route sets its own JSON body size limit).
app.use('/api', sameOrigin, rateLimit({ windowMs: 60 * 1000, max: Number(process.env.API_RATE_LIMIT) || 6000 }));
app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, file) {
    // HTML, CSS and JS are revalidated on every load so updates show up at once.
    res.set('Cache-Control', /\.(woff2|jpe?g|png|svg)$/.test(file) ? 'public, max-age=604800' : 'no-cache');
  },
}));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  if (err.type === 'entity.parse.failed' || err.status === 400) return res.status(400).json({ error: 'Invalid request.' });
  if (err.code === 'ENOSPC') {
    console.error('DISK FULL:', err.message);
    return res.status(507).json({ error: 'The server is out of storage. Please tell the organisers.' });
  }
  if (err.type === 'request.aborted' || err.code === 'ECONNABORTED') return res.status(400).end();
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// Log and keep serving on stray async errors; exit on truly unknown state so Docker restarts us.
process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason));
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
  process.exit(1);
});

const server = app.listen(PORT, () => {
  console.log(`Ideathon '26 registration running on port ${PORT}`);
  if (!adminConfigured) console.warn('WARNING: ADMIN_PASSWORD is not set, the admin panel is disabled.');
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : `Server error: ${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
