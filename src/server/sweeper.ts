import type { Db } from './db/client';
import { deleteExpiredRooms } from './room-service';

/**
 * Deletes rooms that expired from inactivity. It only touches the database while
 * someone is connected, so a serverless Postgres (e.g. Neon free tier) can
 * suspend when nobody is using the app.
 */
export function startSweeper(db: Db, hasClients: () => boolean) {
  const cleanup = setInterval(async () => {
    if (!hasClients()) return;
    try {
      const n = await deleteExpiredRooms(db);
      if (n) console.log(`[sweeper] deleted ${n} expired room(s)`);
    } catch (e) {
      console.error('[sweeper:cleanup]', e);
    }
  }, 10 * 60 * 1000);

  return {
    stop() {
      clearInterval(cleanup);
    },
  };
}
