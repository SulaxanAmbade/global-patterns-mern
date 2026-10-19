import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
const secret = process.env.SESSION_SECRET || '';
export function validateAuth() {
  if (secret.length < 32 || secret.startsWith('CHANGE_'))
    throw Error('Set SESSION_SECRET to at least 32 random characters');
  const users = JSON.parse(process.env.APP_USERS_JSON || '{}');
  if (
    !Object.keys(users).length ||
    Object.values(users).some((p) => !p || String(p).startsWith('CHANGE_'))
  )
    throw Error('Configure real passwords in APP_USERS_JSON');
}
export const hash = (s) =>
  createHmac('sha256', secret).update(String(s)).digest('hex');
export function cookie(req) {
  const value = (req.headers.cookie || '')
    .split(';')
    .find((s) => s.trim().startsWith('gp_session='));
  return value ? value.trim().slice(11) : '';
}
export async function auth(req, res, next) {
  const session = await req.app.locals.db
    .collection('sessions')
    .findOne({ _id: hash(cookie(req)), expiresAt: { $gt: new Date() } });
  if (!session) return res.status(401).json({ error: 'Please sign in' });
  req.user = session.username;
  req.csrf = session.csrf;
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.headers['x-csrf-token'] !== session.csrf
  )
    return res.status(403).json({ error: 'Invalid CSRF token' });
  next();
}
export async function login(req, res) {
  const user = String(req.body.username || '')
    .trim()
    .toLowerCase();
  const users = Object.fromEntries(
    Object.entries(JSON.parse(process.env.APP_USERS_JSON || '{}')).map(
      ([u, p]) => [u.trim().toLowerCase(), p],
    ),
  );
  const actual = hash(req.body.password || '');
  const expected = hash(users[user] ?? randomBytes(32).toString('hex'));
  if (
    !Object.hasOwn(users, user) ||
    !users[user] ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    return res.status(401).json({ error: 'Incorrect username or password' });
  const token = randomBytes(32).toString('hex'),
    csrf = randomBytes(24).toString('hex');
  await req.app.locals.db.collection('sessions').insertOne({
    _id: hash(token),
    username: user,
    csrf,
    expiresAt: new Date(Date.now() + 8 * 3600000),
  });
  res.cookie('gp_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 3600000,
    path: '/',
  });
  res.json({ username: user, csrf });
}
