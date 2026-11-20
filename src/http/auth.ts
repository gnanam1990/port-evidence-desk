import type { IncomingMessage } from 'node:http';
import type { Db } from '../db.ts';
import { one } from '../db.ts';
import { newId } from '../util/crypto.ts';
import { isoNow } from '../util/dates.ts';
import { unauthorized, forbidden } from '../domain/errors.ts';
import type { Actor } from '../domain/audit.ts';

interface SessionRow {
  token: string;
  user_id: string;
  name: string;
  role: Actor['role'];
  tenant_id: string;
}

export function createSession(db: Db, userName: string, pin: string): { token: string; user: Actor } {
  const user = one<{ id: string; tenant_id: string; name: string; role: Actor['role'] }>(
    db,
    'SELECT id, tenant_id, name, role FROM users WHERE name = ? AND pin = ?',
    userName,
    pin,
  );
  if (!user) throw unauthorized('invalid credentials');
  const token = `ped_${newId('tok').slice(4).replaceAll('-', '')}`;
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
    token,
    user.id,
    isoNow(),
  );
  return { token, user: { userId: user.id, name: user.name, role: user.role, tenantId: user.tenant_id } };
}

type Headers = IncomingMessage['headers'];

function cookieToken(headers: Headers): string | null {
  const cookie = headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'ped_session' && v) return v;
  }
  return null;
}

export function actorFromRequest(db: Db, headers: Headers): Actor {
  const auth = headers.authorization;
  let token: string | null = null;
  if (auth?.startsWith('Bearer ')) token = auth.slice(7).trim();
  else token = cookieToken(headers);
  if (!token) throw unauthorized();
  const row = one<SessionRow>(
    db,
    `SELECT s.token, u.id AS user_id, u.name, u.role, u.tenant_id
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    token,
  );
  if (!row) throw unauthorized('session not found');
  return { userId: row.user_id, name: row.name, role: row.role, tenantId: row.tenant_id };
}

export function requireRole(actor: Actor, ...roles: Actor['role'][]): void {
  if (!roles.includes(actor.role)) {
    throw forbidden('role_denied', `role ${actor.role} cannot perform this action; requires ${roles.join(' or ')}`);
  }
}
