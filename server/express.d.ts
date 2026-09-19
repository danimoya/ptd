import type { Role, User } from "../db/schema";

declare global {
  namespace Express {
    interface Request {
      user?: User[];
      /** Decided by the auth middleware from the credential presented — never by the client. */
      authType?: "human" | "agent";
      /** Org bound to a ptd_ token; resolveOrg uses it as the default context. */
      tokenOrgId?: number;
      org?: { id: number; role: Role };
    }
  }
}

export {};
