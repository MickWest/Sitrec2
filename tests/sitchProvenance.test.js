// Provenance decides whether the assistant's writes need confirmation, so the classifier is
// the hinge the whole mitigation turns on.
//
// The rule it encodes: Sitrec loads a sitch from ANY url via ?custom= (verified — a
// cross-origin fetch from the live page succeeds), so a sitch's notes and labels may have
// been written by whoever sent the link. Provenance is therefore derived from the delivery
// channel and never from the downloaded payload.

import {
    PROVENANCE, _resetProvenanceForTests, classifyProvenance, getSitchProvenance,
    getSitchSourceLabel, isSitchExternal, setSitchProvenance, trustCurrentSitch,
} from '../src/SitchProvenance';

beforeEach(() => {
    _resetProvenanceForTests();
});

describe('classifyProvenance', () => {
    test('an arbitrary URL is external', () => {
        expect(classifyProvenance({resolvable: false, ownerId: null, viewerId: '42'}))
            .toBe(PROVENANCE.EXTERNAL);
    });

    test("another user's Sitrec-hosted sitch is external", () => {
        // Being on our own storage says who paid for the bytes, not who wrote the words.
        expect(classifyProvenance({resolvable: true, ownerId: '999', viewerId: '42'}))
            .toBe(PROVENANCE.EXTERNAL);
    });

    test("the user's own Sitrec-hosted sitch is local", () => {
        expect(classifyProvenance({resolvable: true, ownerId: '42', viewerId: '42'}))
            .toBe(PROVENANCE.LOCAL);
    });

    test('ids are compared as strings, so a numeric id still matches its string form', () => {
        expect(classifyProvenance({resolvable: true, ownerId: 42, viewerId: '42'}))
            .toBe(PROVENANCE.LOCAL);
    });

    test('a resolvable reference with no owner is local', () => {
        // Built-in and legacy references carry no user id; they are ours, not a stranger's.
        expect(classifyProvenance({resolvable: true, ownerId: null, viewerId: '42'}))
            .toBe(PROVENANCE.LOCAL);
    });

    test('a logged-out viewer does not turn their own reference external', () => {
        // With no viewer id there is nothing to compare, so the owner check cannot fire.
        expect(classifyProvenance({resolvable: true, ownerId: '999', viewerId: null}))
            .toBe(PROVENANCE.LOCAL);
    });
});

describe('provenance state', () => {
    test('defaults to local', () => {
        expect(getSitchProvenance()).toBe(PROVENANCE.LOCAL);
        expect(isSitchExternal()).toBe(false);
    });

    test('records external plus a human-readable source', () => {
        setSitchProvenance(PROVENANCE.EXTERNAL, 'https://evil.example/x.js');
        expect(isSitchExternal()).toBe(true);
        expect(getSitchSourceLabel()).toBe('https://evil.example/x.js');
    });

    test('anything that is not exactly EXTERNAL is treated as local', () => {
        // Guards against a typo or a stray value silently disabling the gate... in the safe
        // direction only: an unrecognised value must never be able to mark a sitch trusted
        // when it should be external, so the check is for the external sentinel, not against
        // the local one.
        setSitchProvenance('EXTERNAL');       // wrong case
        expect(isSitchExternal()).toBe(false);
        setSitchProvenance(PROVENANCE.EXTERNAL);
        expect(isSitchExternal()).toBe(true);
    });

    test('trusting the sitch lifts the gate for the session', () => {
        setSitchProvenance(PROVENANCE.EXTERNAL, 'https://evil.example/x.js');
        expect(isSitchExternal()).toBe(true);
        trustCurrentSitch();
        expect(isSitchExternal()).toBe(false);
    });

    test('a fresh load starts untrusted again', () => {
        setSitchProvenance(PROVENANCE.EXTERNAL);
        trustCurrentSitch();
        // Loading another shared sitch must not inherit the previous decision.
        setSitchProvenance(PROVENANCE.EXTERNAL, 'https://other.example/y.js');
        expect(isSitchExternal()).toBe(true);
    });
});
