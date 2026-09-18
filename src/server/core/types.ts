export interface UserInfo {
  id: string;
  email: string;
  totpVerified?: boolean;
  pinVerified?: boolean;
  webauthnAccountVerified?: boolean;
  webauthnAppVerified?: boolean;
  deviceApproved?: boolean;
  additionalPasswordVerified?: boolean;
}

export interface RpcContext {
  user: UserInfo | null;
  sessionTokenHash?: string;
}
