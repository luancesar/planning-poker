import type { PermissionKey, Role, RoomSettings } from './protocol';

type Person = { role: Role; canReveal: boolean };

/** Single source of truth for what someone may do in a room (server checks and UI both use it). */
export function permissionsFor(person: Person, settings: RoomSettings): Record<PermissionKey, boolean> & { vote: boolean; manageRoom: boolean } {
  const facilitator = person.role === 'facilitator';
  const byLevel = (key: PermissionKey) => facilitator || (settings.permissions[key] === 'voters' && person.role === 'voter');
  return {
    reveal: byLevel('reveal') || person.canReveal,
    rounds: byLevel('rounds'),
    items: byLevel('items'),
    vote: person.role === 'voter' || (facilitator && settings.facilitatorVotes),
    manageRoom: facilitator,
  };
}
