import type { AdapterPayload } from "oidc-provider";
import { adapterFor } from "./adapter.js";
import { fail } from "./crypto.js";
import type { RefreshFamilies } from "./refresh-families.js";
import type { Store } from "./store.js";

export function hostedAdapter(
  store: Store,
  families: RefreshFamilies,
  ready: () => void = () => {},
) {
  const Base = adapterFor(store);
  return class extends Base {
    constructor(private kind: string) {
      super(kind);
    }
    override async upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn = 3600,
    ) {
      if (this.kind === "AuthorizationCode") {
        if (
          typeof payload.grantId !== "string" ||
          typeof payload.clientId !== "string" ||
          typeof payload.accountId !== "string"
        )
          fail();
        ready();
        families.allowCode(
          payload.grantId,
          payload.clientId,
          payload.accountId,
        );
      }
      if (this.kind === "RefreshToken") {
        if (typeof payload.grantId !== "string") fail();
        const family = families.get(payload.grantId);
        if (family?.status !== "rotating") fail();
        // Preserve original protocol exp. Retain encrypted replay evidence until
        // absolute family expiry, even after the consumed member expires.
        expiresIn = Math.ceil((family.deadline - store.now()) / 1000);
      }
      await super.upsert(id, payload, expiresIn);
    }
    override async revokeByGrantId(id: string) {
      families.revoke(id);
      await super.revokeByGrantId(id);
    }
  };
}
