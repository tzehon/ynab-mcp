# Hosted authorization recovery

Use authenticated operator access and the current private release record.
Never restore an old authorization database: it can resurrect consumed refresh
tokens or revoked grants. Keep provider changes, real credential operations,
deployment and spending behind their separate owner decisions.

## Shutdown and stale ownership

Normal SIGTERM closes admission, cancels control requests, closes SQLite/admin
socket and releases the exclusive `owner.lock`. Crash residue intentionally
prevents startup. A timestamp, PID or expired heartbeat cannot prove that a
previous service stopped; there is no automatic lock stealing.

1. Stop every earlier deployment/process that can mount this volume. Verify that
   through Railway/container state, not the lock timestamp. Prevent new starts.
2. In a private maintenance container using the approved image, same volume and
   UID 1000, inspect `/data/authorization/owner.lock` ownership/type/mode and obtain
   its SHA-256 fingerprint. Do not open another application database handle.
3. Pass the fingerprint on stdin to
   `node scripts/recover-ownership.mjs --confirmed-stopped`.
   This flag records the operator's prerequisite; it is not automatic stop
   detection. The bounded helper checks exact path, owner, mode, inode and digest,
   then removes only that matching claim. It never deletes state or resets grants.
4. Restart the same approved image with current secrets/configuration. Startup
   invalidates interrupted refresh and incomplete token-delivery state. Check
   generic readiness, denial of old affected grants and fresh reconnect behavior.

The control socket lives in the ephemeral container filesystem. Replace the
stopped container to discard a crashed socket; never blindly unlink sockets in a
running process. If in-place restart leaves a socket, keep the service stopped
and use a new container with the existing durable volume.

## Compatible rollback and clean recovery

A rollback may use only a reviewed image compatible with the **current** schema,
keys/configuration and grant state. Stop the current image before mounting the
same volume with the earlier compatible image. Do not restore its historical
database or secret snapshot. Unknown schema/key mismatch must fail closed. If
compatibility is unproven, keep the service stopped and prepare a reviewed fix.

If the authorization store is unrecoverable, approve a clean authorization store
and fresh enrollment/reconnect. Preserve only independently verified owner
identity and current key custody through the private recovery decision; do not
copy grant/token rows into it. Quarantine old encrypted artifacts privately for
diagnosis under the chosen retention policy. Never reset a live volume for tests.

An interrupted enrollment remains closed. A claimed/candidate issuance cannot be
reset by restarting or supplying a different capability. Complete the private
candidate decision if legitimate; otherwise stop and use an explicitly approved
clean-store recovery. Confirmation persisted before a configuration interruption
requires the exact verified owner setting and removal of all enrollment settings.
The same saved issuance can reopen for private inspection/confirmation even after
its admission deadline. That does not make the expired capability usable again;
fresh expired enrollment still fails startup, and candidate state cannot claim again.

## Keys and storage limits

Keep encryption/index/cookie values unchanged across ordinary restarts and signing
rotation. To rotate signing, prepare a new active private RSA key and retain only
the previous public JWK as `retiring`, with absolute `retiringUntil` no more than
one hour ahead. Preserve a 1Password history outside the volume. Only the active
key signs new tokens; public verification/JWKS drop the retiring key at the deadline.
Remove the expired retiring configuration before a later restart (startup refuses
an expired overlap). Do not reset the deadline to extend retirement. Changing
encryption/index keys requires a separately reviewed migration or clean recovery.

State is bounded to 1,000 records, 64 KiB payloads and 32 MiB of database artifacts,
with reserved space for revocation. Retained consumed tokens count toward capacity.
Capacity/storage failure denies authority; it never evicts active replay evidence.
Investigate privately, stop admission if needed, and use reconnect/clean recovery
instead of deleting arbitrary rows. Recovery evidence uses disposable synthetic
stores; real grant restoration is never a test shortcut.
