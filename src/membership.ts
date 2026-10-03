import type { Room, Session } from '../shared/types';
import { ApiError } from './api';

export const ACTIVE_SESSION_KEY = 'multiplayer-session-v1';
export const MEMBERSHIPS_KEY = 'multiplayer-memberships-v1';
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type SavedMembership = {
  session: Session;
  roomCode: string;
  roomName: string;
  memberName: string;
  savedAt: number;
};
export const normalizeRoomCode = (code: string) => code.trim().toUpperCase().replace(/[\s-]/g, '');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const session = value as Session;
  return nonempty(session.roomId) && nonempty(session.memberId) && nonempty(session.token);
}

// Keep the active room tab-local, while remembering credentials across tabs and visits.
export function createMembershipStore(persistent: StorageLike, tab: StorageLike) {
  function active(): Session | null {
    try {
      const value: unknown = JSON.parse(tab.getItem(ACTIVE_SESSION_KEY) || 'null');
      return isSession(value) ? value : null;
    } catch {
      return null;
    }
  }
  function list(): SavedMembership[] {
    try {
      const value: unknown = JSON.parse(persistent.getItem(MEMBERSHIPS_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      return value
        .filter(
          (item): item is SavedMembership =>
            item &&
            typeof item === 'object' &&
            isSession(item.session) &&
            nonempty(item.roomCode) &&
            nonempty(item.roomName) &&
            nonempty(item.memberName) &&
            typeof item.savedAt === 'number' &&
            Number.isFinite(item.savedAt),
        )
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }
  function remember(session: Session, room: Room): boolean {
    const member = room.members.find((m) => m.id === session.memberId);
    if (session.roomId !== room.id || !member) return false;
    const saved: SavedMembership = {
      session,
      roomCode: room.code,
      roomName: room.name,
      memberName: member.name,
      savedAt: Date.now(),
    };
    const others = list().filter(
      (item) =>
        item.session.roomId !== session.roomId || item.session.memberId !== session.memberId,
    );
    try {
      persistent.setItem(MEMBERSHIPS_KEY, JSON.stringify([saved, ...others].slice(0, 40)));
      return true;
    } catch {
      return false;
    }
  }
  function enter(session: Session, room: Room): boolean {
    try {
      tab.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
    } catch {
      /* In-memory navigation remains available. */
    }
    return remember(session, room);
  }
  function leave() {
    try {
      tab.removeItem(ACTIVE_SESSION_KEY);
    } catch {
      /* In-memory navigation remains available. */
    }
  }
  function forget(token: string) {
    try {
      persistent.setItem(
        MEMBERSHIPS_KEY,
        JSON.stringify(list().filter((item) => item.session.token !== token)),
      );
    } catch {
      /* Storage may be unavailable. */
    }
    if (active()?.token === token) leave();
  }
  async function resume(saved: SavedMembership, loadRoom: (session: Session) => Promise<Room>) {
    try {
      const room = await loadRoom(saved.session);
      if (
        room.id !== saved.session.roomId ||
        !room.members.some((member) => member.id === saved.session.memberId)
      )
        throw new ApiError('This saved room profile is no longer available.', 401);
      return { session: saved.session, room };
    } catch (error) {
      if (error instanceof ApiError && [401, 404].includes(error.status))
        forget(saved.session.token);
      throw error;
    }
  }
  return { active, list, remember, enter, leave, forget, resume };
}
