/**
 * Rangliste der Likes, absteigend. Nur fuer Robin, deshalb hinter einem Schluessel:
 *
 *   curl "https://<domain>/api/likes?key=$LIKES_SECRET"
 *
 * Ohne gesetztes LIKES_SECRET bleibt der Endpunkt komplett zu, damit die Zahlen nicht
 * versehentlich oeffentlich stehen.
 */
import { Redis } from '@upstash/redis';

const BOARD = 'travel:likes';

const configured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = configured ? Redis.fromEnv() : null;

export default async function handler(req, res) {
  const secret = process.env.LIKES_SECRET;
  if (!secret || req.query.key !== secret) return res.status(404).end();
  if (!redis) return res.status(503).json({ error: 'kein Upstash konfiguriert' });

  try {
    // withScores liefert ein flaches Array: [member, score, member, score, ...]
    const flat = await redis.zrange(BOARD, 0, -1, { rev: true, withScores: true });
    const photos = [];
    for (let i = 0; i < flat.length; i += 2) {
      const likes = Number(flat[i + 1]);
      // Zurueckgenommene Likes lassen den Eintrag auf 0 stehen, der interessiert nicht
      if (likes > 0) photos.push({ photo: String(flat[i]), likes });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ total: photos.reduce((n, p) => n + p.likes, 0), photos });
  } catch (err) {
    console.error('likes lesen fehlgeschlagen', err);
    return res.status(500).json({ error: 'Abfrage fehlgeschlagen' });
  }
}
