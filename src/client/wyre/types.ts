import type { BadgeKind, Presence, Warning } from "./data";

/** A Wyre user as returned by `wyre.searchPeople`. */
export interface Person {
  userId: string;
  name: string;
  username: string;
  initials: string;
  avatarUrl?: string | null;
  colors: [string, string];
  badge?: BadgeKind;
  online: boolean;
  status: string;
  warnings: Warning[];
}

/** Public profile card returned by `wyre.userProfile`. */
export interface UserProfile {
  userId: string;
  name: string;
  username: string;
  initials: string;
  colors: [string, string];
  avatarUrl?: string | null;
  badge?: BadgeKind;
  bio: string;
  status: string;
  presence: Presence;
  warnings: Warning[];
  phone?: string | null;
  canMessage: boolean;
  canCall: boolean;
  isSelf: boolean;
}
