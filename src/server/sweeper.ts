import type { Db } from './db/client';
import type { Broadcaster } from './realtime';
import { deleteExpiredRooms, expiredRounds, revealExpired } from './room-service';

/** Reveals rounds whose timer ran out and deletes rooms that expired from inactivity. */
export function startSweeper(db: Db, broadcaster: Broadcaster) {
  let busy = false;
  const timers = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const { roomId, roundId } of await expiredRounds(db)) {
        await revealExpired(db, roomId, roundId);
        broadcaster.schedule(roomId);
      }
    } catch (e) {
      console.error('[sweeper:timers]', e);
    } finally {
      busy = false;
    }
  }, 1000);

  const cleanup = setInterval(async () => {
    try {
      const n = await deleteExpiredRooms(db);
      if (n) console.log(`[sweeper] deleted ${n} expired room(s)`);
    } catch (e) {
      console.error('[sweeper:cleanup]', e);
    }
  }, 10 * 60 * 1000);

  return {
    stop() {
      clearInterval(timers);
      clearInterval(cleanup);
    },
  };
}
