// layers are collections of objects that are rendered by a camera
// only if it's also on that layer
// it uses a 32-but mask, but individual layers are specified by bit number
// You could use (1<<LAYER_name) to build the mask if needed


export const podsEye = 7    // Specific to the ATFLIR pod
export const podBack = 8

export const LEFTEYE = 1
export const RIGHTEYE = 2

export const WORLD = 0       // all normal 3D objects in the GlobalScene

export const MAIN = 3       // things that we want to see in the main camera
export const LOOK = 4       // things that we want to see in the look camera
export const HELPERS = 5    // things like lines that we want ONLY in the main view, but not in the recreation
export const TARGET = 6     // things that are targets, like the target sphere or a F/A-18F

export const MASK_EYES = (1<<RIGHTEYE) | (1<<LEFTEYE);

export const MASK_WORLD = (1<<WORLD);      // all normal 3D objects in the GlobalScene (default)
export const MASK_MAIN = (1<<MAIN);        // things that we want to see in the main camera
export const MASK_LOOK = (1<<LOOK);        // things that we want to see in the look camera
export const MASK_HELPERS = (1<<HELPERS)   // things like lines that we want ONLY in the main view, but not in the recreation
export const MASK_TARGET = (1<<TARGET)     // things that are targets, like the target sphere or a F/A-18F

// Lighitng applies to all non-helpers
// generally this is just going to be stuff in WORLD group
// very few real ussage of this just MASK_MAIN or MASK_LOOK
export const MASK_LIGHTING = MASK_WORLD | MASK_MAIN | MASK_LOOK | MASK_TARGET ;

export const MASK_MAINRENDER = MASK_WORLD | MASK_MAIN | MASK_TARGET | MASK_HELPERS ;
export const MASK_LOOKRENDER = MASK_WORLD | MASK_LOOK | MASK_TARGET;
export const MASK_TARGETRENDER = MASK_TARGET;  // for the target-only window




// The layer mask for something switchable INDEPENDENTLY per view — the pattern behind the
// "… in Main" / "… in Look" pairs (labels, features, measurements, the equatorial grid).
//
// Only two bits distinguish the two renders: HELPERS is in MAINRENDER alone, LOOK in LOOKRENDER
// alone. WORLD and TARGET are in BOTH, which is the trap — masking with MASK_MAINRENDER to mean
// "main only" actually leaks into the look view, because the look camera tests WORLD and TARGET
// too. A zero result means "in neither"; the caller should clear .visible as well, since an
// object with a zero mask is skipped but its children are still walked.
export function perViewLayerMask(inMain, inLook) {
    return (inMain ? MASK_HELPERS : 0) | (inLook ? MASK_LOOK : 0);
}
