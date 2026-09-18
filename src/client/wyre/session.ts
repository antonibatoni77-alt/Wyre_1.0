import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKey, wyreQuery } from "../lib/api";

export interface WyreProfile {
  id: string;
  name: string;
  username: string;
  usernameHistory: { username: string; changedAt: string }[];
  email: string;
  bio: string;
  phone: string | null;
  colors: [string, string];
  initials: string;
  avatarUrl?: string | null;
  badge: "dev" | "official" | null;
  role: "user" | "moderator" | "admin" | "owner";
  warnings: { reason: string; issuedAt: string }[];
  presenceVisibility: "all" | "contacts" | "nobody";
  presenceAlways: string[];
  presenceNever: string[];
}

export interface WyreSession {
  authenticated: boolean;
  needsProfile: boolean;
  needsPhoneSetup: boolean;
  needsChallenge: boolean;
  needsTotp: boolean;
  needsPin: boolean;
  needsAdditionalPassword: boolean;
  needsWebAuthn: boolean;
  needsDeviceApproval: boolean;
  requiresPhone: boolean;
  profile: WyreProfile | null;
  email?: string | null;
}

const SESSION_QUERY = "wyre.session";

/**
 * Single source of truth for the client auth state — server-derived, so a page
 * reload always resumes exactly where the user left off (persistent session).
 */
export function useWyreSession() {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...wyreQuery<WyreSession>(SESSION_QUERY, {}),
    staleTime: 0,
  });

  const refresh = useCallback(
    async () => {
      // Force a fresh read: a stale cached session made the 2FA step look stuck
      // even after the server had already accepted the code.
      await queryClient.invalidateQueries({ queryKey: createQueryKey(SESSION_QUERY, {}), refetchType: "all" });
      await queryClient.refetchQueries({ queryKey: createQueryKey(SESSION_QUERY, {}) });
    },
    [queryClient],
  );

  return { session: query.data, isLoading: query.isLoading, refresh };
}
