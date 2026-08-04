/**
 * Zaehlt Likes pro Foto in einem Sorted Set, damit die Rangliste ein einzelner
 * Redis-Aufruf bleibt. Ausgelesen wird sie ueber /api/likes.
 *
 * Der Schluessel ist "album/dateiname", nicht die Foto-ID aus dem Manifest: die
 * traegt einen Content-Hash, der sich beim Neubearbeiten eines Bildes aendert und
 * die gesammelten Likes wegwerfen wuerde.
 *
 * Ohne Upstash-Zugangsdaten antwortet der Endpunkt still mit 204. Die Galerie soll
 * auch dann laufen, wenn sie ohne Datenbank irgendwo statisch liegt.
 */
import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const BOARD = 'travel:likes';
const GUARD_TTL = 60 * 60 * 24 * 30; // 30 Tage
const PHOTO_KEY = /^[a-z0-9][a-z0-9-]{0,40}\/[\w.() -]{1,80}$/i;

const configured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = configured ? Redis.fromEnv() : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!redis) return res.status(204).end();

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const photo = String(body.photo || '');
  const on = body.on !== false;

  if (!PHOTO_KEY.test(photo)) return res.status(400).json({ error: 'bad photo key' });

  /*
   * Ein Zaehler pro Besucher und Foto. Die IP wird nur gehasht abgelegt und faellt nach
   * 30 Tagen weg, sie dient allein dazu, mehrfaches Klicken nicht mehrfach zu zaehlen.
   */
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const guard = `travel:seen:${createHash('sha256').update(`${ip}|${photo}`).digest('hex').slice(0, 24)}`;

  try {
    if (on) {
      const fresh = await redis.set(guard, 1, { nx: true, ex: GUARD_TTL });
      if (fresh) await redis.zincrby(BOARD, 1, photo);
    } else if (await redis.del(guard)) {
      await redis.zincrby(BOARD, -1, photo);
    }
    return res.status(204).end();
  } catch (err) {
    console.error('like fehlgeschlagen', err);
    return res.status(204).end(); // der Besucher soll davon nichts merken
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
