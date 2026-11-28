// The altitude lock controls of a track: a Lock Altitude checkbox, the lock height, and what the
// height is measured from. They replace one "Alt Lock (-1 = off)" slider, where switching the
// lock off meant dragging to a special value.
//
// The lock itself is unchanged (AltitudeLock.js): altitudeLock is -1 when off, else the height
// in meters; altitudeLockAGL measures it from the ground (true) or the ellipsoid (false, HAE).
// The height control is still the CNodeGUIValue that holds altitudeLock, so saved sitches load
// as before.

import {Globals, Units} from "./Globals";
import {t} from "./i18n";
import {altitudeHAE} from "./SphericalMath";
import {getVisiblePointBelow} from "./threeExt";

/**
 * The height of an ECEF point the way a lock measures it: above the ground below it, or HAE.
 * @param {Vector3} position - ECEF
 * @param {boolean} agl - measure from the ground
 * @returns {number} meters
 */
export function lockHeightAt(position, agl) {
    const hae = altitudeHAE(position);
    return agl ? hae - altitudeHAE(getVisiblePointBelow(position)) : hae;
}

/**
 * Add Lock Altitude and Height From around a track's lock height control.
 *
 * @param {GUI} folder - the folder the height control is in
 * @param {object} opts
 * @param {CNodeGUIValue} opts.heightNode - holds altitudeLock in display units (-1 = off). Its
 *        onChange applies the lock, and must call the returned update().
 * @param {function(): boolean} opts.isOn - the lock is on
 * @param {function(): number} opts.currentHeight - the track's height now, in meters, measured
 *        as Height From says. Switching the lock on holds the track there, rather than
 *        dropping it to the ground.
 * @param {function(): boolean} opts.getAGL
 * @param {function(boolean)} opts.setAGL
 * @param {function(): boolean} [opts.hasSavedZeroLock] - a spline's track record can explicitly
 *        lock it at zero even when an older import left its height control hidden
 * @param {boolean} [opts.legacyZeroIsOff] - before 2.177.0 this control defaulted to 0, which did
 *        not lock, so a saved 0 from then means off
 * @returns {{update: function()}} shows the height and Height From only while the lock is on
 */
export function addAltitudeLockControls(folder, {heightNode, isOn, currentHeight, getAGL, setAGL, hasSavedZeroLock, legacyZeroIsOff = false}) {
    const state = {
        get lockAltitude() { return isOn(); },
        set lockAltitude(on) {
            if (on === isOn()) return;
            if (on) {
                // In whole display units, so the field does not show 14611.710239279928.
                const scale = Units.getScaleFactors("metric").small;
                heightNode.setValue(Math.round(Math.max(0, currentHeight()) * scale));
            } else {
                heightNode.setValue(-1);
            }
        },
        get heightFrom() { return getAGL() ? "ground" : "ellipsoid"; },
        set heightFrom(value) { setAGL(value === "ground"); },
    };

    const lock = folder.add(state, "lockAltitude").name(t("altitudeLock.lock.label"))
        .tooltip(t("altitudeLock.lock.tooltip")).listen();
    const heightFrom = folder.add(state, "heightFrom", {
        [t("altitudeLock.heightFrom.ground")]: "ground",
        [t("altitudeLock.heightFrom.ellipsoid")]: "ellipsoid",
    }).name(t("altitudeLock.heightFrom.label")).tooltip(t("altitudeLock.heightFrom.tooltip")).listen();

    // On screen: Lock Altitude, the height, then Height From.
    const heightElement = heightNode.guiEntry.domElement;
    heightElement.parentElement.insertBefore(lock.domElement, heightElement);
    heightElement.parentElement.insertBefore(heightFrom.domElement, heightElement.nextSibling);

    const update = () => {
        const on = isOn();
        heightNode.show(on);
        heightFrom.show(on);
    };
    const controls = {update};
    lock.onChange(() => controls.update());
    // A saved sitch restores the height control's own `visible`, which CNodeGUIValue.update()
    // then applies, and it changes the lock only when the saved value differs. So after a
    // restore, show or hide by the lock again.
    const restore = heightNode.modDeserialize?.bind(heightNode);
    if (restore) {
        heightNode.modDeserialize = (v) => {
            // Older imported tracks could save an OFF lock as a hidden zero.
            // A spline also saves its lock on the track itself, before the controls load.
            // Before 2.177.0 there was no Lock Altitude checkbox, and an untouched
            // control saved its default 0 as visible, so with legacyZeroIsOff that is off too.
            if (v.value === 0 && ((v.visible === false && !hasSavedZeroLock?.())
                || (legacyZeroIsOff && (Globals.exportTagNumber ?? 0) < 2177000))) v = {...v, value: -1};
            const unchanged = heightNode.value === v.value;
            restore(v);
            // GUIValue skips onChange for an unchanged value. The data node can
            // nevertheless still be unlocked (notably a saved zero-height lock).
            if (unchanged && v.value !== undefined) heightNode.onChange?.(heightNode.v0);
            controls.update();
        };
    }
    update();
    return controls;
}
