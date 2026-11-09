import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fail } from "./crypto.js";
import type { HostedConfig } from "./hosted-config.js";
import type { Store } from "./store.js";

export class Enrollment {
  constructor(
    private store: Store,
    private config: HostedConfig["enrollment"],
  ) {
    store.transaction(() => {
      const binding = store.get("OwnerBinding", "owner"),
        saved = store.get("Enrollment", "current");
      if (config.kind === "owner") {
        if (binding?.owner !== config.owner || saved?.phase !== "confirmed")
          fail();
      } else {
        if (binding || saved?.phase === "confirmed") fail();
        const digest = this.digest(config.capability);
        if (saved?.issuance === config.issuance) {
          if (saved.digest !== digest || saved.expires !== config.expires)
            fail();
        } else {
          if (saved?.phase === "claimed" || saved?.phase === "candidate")
            fail();
          store.put(
            "Enrollment",
            "current",
            {
              issuance: config.issuance,
              digest,
              expires: config.expires,
              attempts: 0,
              phase: "available",
            },
            Number.MAX_SAFE_INTEGER,
          );
        }
      }
    });
  }
  private digest(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  claim(capability: string, browser: string) {
    if (this.config.kind !== "enroll") fail();
    let flow: string | undefined;
    this.store.transaction(() => {
      const r = this.store.get("Enrollment", "current");
      if (
        r?.phase !== "available" ||
        typeof r.expires !== "number" ||
        r.expires <= this.store.now() ||
        Number(r.attempts) >= 5
      )
        return;
      if (
        !timingSafeEqual(
          Buffer.from(this.digest(capability)),
          Buffer.from(String(r.digest)),
        )
      ) {
        this.store.put(
          "Enrollment",
          "current",
          { ...r, attempts: Number(r.attempts) + 1 },
          Number.MAX_SAFE_INTEGER,
          {},
          true,
        );
        return;
      }
      flow = randomBytes(32).toString("base64url");
      this.store.put(
        "Enrollment",
        "current",
        { ...r, phase: "claimed", browser, flow },
        Number.MAX_SAFE_INTEGER,
        {},
        true,
      );
    });
    if (!flow) fail();
    return flow;
  }
  candidate(flow: string, browser: string, owner: string) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner)) fail();
    this.store.transaction(() => {
      const r = this.store.get("Enrollment", "current");
      if (
        r?.phase !== "claimed" ||
        r.flow !== flow ||
        r.browser !== browser ||
        Number(r.expires) <= this.store.now()
      )
        fail();
      this.store.put(
        "Enrollment",
        "current",
        { issuance: r.issuance, phase: "candidate", candidate: owner },
        Number.MAX_SAFE_INTEGER,
        {},
        true,
      );
    });
  }
  // Called only by the private operator socket; never an HTTP route.
  inspectCandidate() {
    const r = this.store.get("Enrollment", "current");
    return r?.phase === "candidate" ? r.candidate : undefined;
  }
  confirm(owner: string) {
    this.store.transaction(() => {
      const r = this.store.get("Enrollment", "current");
      if (
        r?.phase !== "candidate" ||
        r.candidate !== owner ||
        this.store.get("OwnerBinding", "owner")
      )
        fail();
      this.store.put(
        "OwnerBinding",
        "owner",
        { owner },
        Number.MAX_SAFE_INTEGER,
      );
      this.store.put(
        "Enrollment",
        "current",
        { issuance: r.issuance, phase: "confirmed" },
        Number.MAX_SAFE_INTEGER,
        {},
        true,
      );
    });
  }
  status() {
    return this.store.get("Enrollment", "current")?.phase;
  }
}
