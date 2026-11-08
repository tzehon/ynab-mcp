import type { AdapterPayload } from "oidc-provider";
import type { Store } from "./store.js";
export function adapterFor(store: Store) {
  return class {
    constructor(private model: string) {}
    async upsert(id: string, payload: AdapterPayload, expiresIn = 3600) {
      const links: Record<string, string> = {};
      for (const k of ["uid", "userCode", "grantId"])
        if (typeof payload[k] === "string") links[k] = payload[k] as string;
      if (this.model === "ReplayDetection")
        store.insert(this.model, id, payload, store.now() + expiresIn * 1000);
      else
        store.put(
          this.model,
          id,
          payload,
          store.now() + expiresIn * 1000,
          links,
        );
    }
    async find(id: string) {
      return this.model === "Client"
        ? undefined
        : (store.get(this.model, id) as AdapterPayload | undefined);
    }
    async findByUid(uid: string) {
      return store.find(this.model, "uid", uid) as AdapterPayload | undefined;
    }
    async findByUserCode(code: string) {
      return store.find(this.model, "userCode", code) as
        | AdapterPayload
        | undefined;
    }
    async destroy(id: string) {
      store.remove(this.model, id);
    }
    async consume(id: string) {
      store.consume(this.model, id);
    }
    async revokeByGrantId(id: string) {
      store.revoke(id);
    }
  };
}
