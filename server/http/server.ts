import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { App } from '../app.ts';
import { registerRoutes } from './routes.ts';

export interface HttpOptions {
  /** Verzeichnis der gebauten Oberfläche (web/dist). */
  webDir?: string;
  /** Zusätzlich erlaubte Host-Namen (z. B. bei Zugriff über das LAN). */
  allowedHosts?: string[];
  version?: string;
  logger?: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostName(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/**
 * HTTP-Schicht: REST-API + Server-Sent Events + statische Oberfläche.
 *
 * Schutz für den lokalen Betrieb:
 * - Host-Header-Prüfung (gegen DNS-Rebinding),
 * - schreibende API-Aufrufe brauchen den Header "X-Davenet: 1" (Browser können ihn cross-origin nicht ohne CORS setzen),
 * - Origin muss – falls vorhanden – zum Host passen,
 * - Secrets werden nie ausgeliefert.
 */
export async function buildHttp(app: App, opts: HttpOptions = {}): Promise<FastifyInstance> {
  const http = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const allowed = new Set([...LOCAL_HOSTS, ...(opts.allowedHosts ?? []).map((h) => h.toLowerCase())]);

  http.addHook('onRequest', async (req, reply) => {
    const host = hostName(req.headers.host);
    if (!allowed.has(host)) {
      return reply.code(403).send({ error: `Host "${host}" nicht erlaubt (DAVENET_ALLOWED_HOSTS)` });
    }
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        originHost = '';
      }
      const normalized = originHost.includes(':') && !originHost.startsWith('[') ? `[${originHost}]` : originHost;
      if (!allowed.has(normalized) && !allowed.has(originHost)) return reply.code(403).send({ error: 'Fremder Origin' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-davenet'] !== '1') {
      return reply.code(403).send({ error: 'Header X-Davenet fehlt' });
    }
  });

  // Leere JSON-Bodies (z. B. bei Aktions-POSTs) als {} akzeptieren
  http.removeContentTypeParser('application/json');
  http.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body ?? '').trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const e = new Error('Ungültiges JSON') as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  http.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ') });
    }
    const e = err as Error & { statusCode?: number };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    console.error('[http]', e);
    return reply.code(500).send({ error: e.message || 'Interner Fehler' });
  });

  // Server-Sent Events: die Oberfläche aktualisiert sich bei Änderungen sofort
  http.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const off = app.bus.on((ev) => {
      if (ev.type === 'scheduler.wake' || ev.type === 'job.cancel') return;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      off();
    });
  });

  registerRoutes(http, app, opts.version ?? '0.0.0');

  http.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Unbekannter Endpunkt' });
    if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) return reply.sendFile('index.html');
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Davenet</title><body style="font-family:sans-serif;padding:2rem">' +
          '<h1>Davenet API läuft</h1><p>Die Oberfläche ist noch nicht gebaut. Bitte <code>npm run build</code> ausführen ' +
          'oder für die Entwicklung <code>npm run dev</code> nutzen.</p></body>',
      );
  });

  if (opts.webDir && fs.existsSync(opts.webDir)) {
    await http.register(fastifyStatic, { root: path.resolve(opts.webDir), prefix: '/', wildcard: false, index: ['index.html'] });
  }
  return http;
}
