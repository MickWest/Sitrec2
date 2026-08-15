// SitchProvenance.js
// Where did the currently loaded sitch come from, and should its contents be trusted?
//
// Sitrec will load a sitch from ANY url via ?custom= (src/index.js) — there is no allowlist,
// and cross-origin loading demonstrably works. That is a feature: it is how recreations get
// shared. But it means a sitch's Notes, track names, object titles and graph labels can be
// written by whoever sent the link rather than by the person who clicked it, and those
// strings reach the AI assistant's context.
//
// So the trust decision belongs to the SITCH, not to any one field. Attacker text arrives
// through several routes (Notes via getNotes, labels via getMenuSummary), and gating each
// route separately is both leaky and endless; gating by where the whole sitch came from is
// one decision in one place.
//
// TWO RULES, both load-bearing:
//
//  1. Provenance is derived from the DELIVERY CHANNEL, never from the sitch payload. A
//     serialized `trusted: true` field would be written by the attacker. Nothing in this
//     module may ever read the sitch object. (CNodeNotes.js's addSimpleSerial("notesText")
//     is the shape to avoid here — fine for content, fatal for a trust flag.)
//
//  2. It is runtime-only state. It is not persisted and not serialized, so it cannot leak
//     into a saved sitch and come back as an assertion of trust.

// WHAT IS DELIBERATELY *NOT* COVERED, and why — so this reads as a decision, not an
// oversight, to whoever reviews it next:
//
//  - Dropping a file on the page does not load a sitch at all. DragDropHandler and the
//    sitch browser queue dropped files for import INTO the current sitch; nothing in that
//    path reaches textSitchToObject/setNewSitchObject. There is no drag-drop sitch load to
//    classify. (Checked all seven setNewSitchObject call sites: in-memory origin reset,
//    version restore from a resolved ref, and two admin loops.)
//
//  - File -> Open Local Sitch is treated as LOCAL. A file picked off disk carries no signal
//    distinguishing the user's own saved work from something emailed to them, and the same
//    picker serves both. Gating it would put a confirmation in front of the user's own
//    recreations every session, which is a real cost against a threat that needs the victim
//    to save an attachment and then deliberately open it — while the realistic delivery
//    route for a hostile sitch, a link, IS covered.
//
//    Marking files that Sitrec itself saved was considered and rejected: any marker written
//    into the file is attacker-writable, and a per-install secret token would leak the first
//    time a sitch is shared publicly — which is the product's whole point — after which it
//    is both forgeable and a fingerprint linking that user's shares.
//
//    Reviewed and chosen deliberately; revisit if sitches start being passed around as
//    files rather than links.

export const PROVENANCE = Object.freeze({
    LOCAL: 'local',
    EXTERNAL: 'external',
});

let currentProvenance = PROVENANCE.LOCAL;
let currentSource = null;   // human-readable, for the confirmation dialog only

// Pure classifier, kept separate from the mutable state so it can be unit-tested.
//
//   resolvable — the ?custom= value is one of Sitrec's own reference forms (sitrec:// ref,
//                raw object path, legacy S3 url) rather than an arbitrary URL.
//   ownerId    — the user id owning that object, when the reference carries one.
//   viewerId   — the current user.
//
// An arbitrary URL is external because anyone can host one. A Sitrec-hosted object owned by
// someone else is also external: being on our own storage says who paid for the bytes, not
// who wrote the words. Own objects, built-in sitches and new work are local.
export function classifyProvenance({resolvable, ownerId, viewerId}) {
    if (!resolvable) return PROVENANCE.EXTERNAL;
    if (ownerId && viewerId && String(ownerId) !== String(viewerId)) return PROVENANCE.EXTERNAL;
    return PROVENANCE.LOCAL;
}

// Called once per sitch load. `source` is only ever shown to the user, never parsed.
export function setSitchProvenance(provenance, source = null) {
    currentProvenance = (provenance === PROVENANCE.EXTERNAL) ? PROVENANCE.EXTERNAL : PROVENANCE.LOCAL;
    currentSource = source;
    if (currentProvenance === PROVENANCE.EXTERNAL) {
        console.log('Sitch provenance: EXTERNAL' + (source ? ' (' + source + ')' : '')
            + ' — assistant writes will ask first.');
    }
}

export function getSitchProvenance() {
    return currentProvenance;
}

export function isSitchExternal() {
    return currentProvenance === PROVENANCE.EXTERNAL;
}

export function getSitchSourceLabel() {
    return currentSource;
}

// The escape hatch. A user who has looked at a shared sitch and decided it is fine can lift
// the write gating for the rest of the session. This is consent over CAPABILITY, which is a
// real decision, rather than consent over reading, which people click through because
// reading is the reason they opened the sitch at all.
//
// Deliberately not persisted: it lasts for this sitch in this session, and any fresh load
// starts untrusted again.
export function trustCurrentSitch() {
    currentProvenance = PROVENANCE.LOCAL;
    console.log('Sitch marked as trusted for this session.');
}

// Test seam only.
export function _resetProvenanceForTests() {
    currentProvenance = PROVENANCE.LOCAL;
    currentSource = null;
}
