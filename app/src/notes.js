import { Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cacheKey = (id) => `note:${id}`;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function validateNote(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const { title, content } = body;
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    return 'title must be a non-empty string of at most 200 characters';
  }
  if (content !== undefined && (typeof content !== 'string' || content.length > 10000)) {
    return 'content must be a string of at most 10000 characters';
  }
  return null;
}

export function notesRouter({ pool, cache }) {
  const router = Router();

  router.post('/', async (req, res) => {
    const error = validateNote(req.body);
    if (error) return badRequest(res, error);

    const { rows } = await pool.query(
      `INSERT INTO notes (title, content) VALUES ($1, $2)
       RETURNING id, title, content, created_at`,
      [req.body.title.trim(), req.body.content ?? ''],
    );
    res.status(201).location(`/api/notes/${rows[0].id}`).json(rows[0]);
  });

  router.get('/', async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const { rows } = await pool.query(
      'SELECT id, title, content, created_at FROM notes ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    res.json({ items: rows });
  });

  router.get('/:id', async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badRequest(res, 'id must be a UUID');

    const cached = await cache.get(cacheKey(id));
    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    const { rows } = await pool.query(
      'SELECT id, title, content, created_at FROM notes WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'note not found' });

    await cache.set(cacheKey(id), rows[0]);
    res.set('X-Cache', 'MISS');
    res.json(rows[0]);
  });

  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return badRequest(res, 'id must be a UUID');

    const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    await cache.del(cacheKey(id));
    if (rowCount === 0) return res.status(404).json({ error: 'note not found' });
    res.status(204).end();
  });

  return router;
}
