// Right-click arbitration between a view and an overlay drawn on top of it.
//
// The two halves of a right-click arrive as separate DOM events on separate elements — the
// overlay gets its click through the document-level router, the view opens its menu from a
// listener on its own canvas — so the overlay cannot cancel the view's event. It leaves a claim
// instead, and the semantics of that claim are the whole contract:
//
//   consumed on read, so it suppresses the ONE menu it was paired with and not a burst;
//   time limited, so a claim nothing ever reads expires instead of ambushing a later right-click.

import {claimRightClick, rightClickWasClaimed} from "../src/ViewUtils";

describe("right-click claim", () => {
    beforeEach(() => {
        // Drain any claim left by a previous test.
        rightClickWasClaimed();
    });

    test("no claim means the view opens its menu", () => {
        expect(rightClickWasClaimed()).toBe(false);
    });

    test("a claim suppresses exactly one menu, then releases", () => {
        claimRightClick();
        expect(rightClickWasClaimed()).toBe(true);
        // The very next right-click, however quickly it follows, must work normally. Without
        // consumption this stayed suppressed for the whole 600 ms window.
        expect(rightClickWasClaimed()).toBe(false);
        expect(rightClickWasClaimed()).toBe(false);
    });

    test("an unread claim expires rather than waiting for a later right-click", () => {
        claimRightClick();
        // Zero window stands in for "long enough afterwards": the claim is stale, so it does not
        // suppress anything, and it is not left armed either.
        expect(rightClickWasClaimed(0)).toBe(false);
        expect(rightClickWasClaimed()).toBe(true);   // still inside the real window
    });

    test("re-claiming re-arms", () => {
        claimRightClick();
        expect(rightClickWasClaimed()).toBe(true);
        claimRightClick();
        expect(rightClickWasClaimed()).toBe(true);
    });
});
