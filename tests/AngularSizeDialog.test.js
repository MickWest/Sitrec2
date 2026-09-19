/** @jest-environment jsdom */
import {showAngularSizeDialog} from "../src/AngularSizeDialog";

afterEach(() => document.body.replaceChildren());

test("constant projected size is an explicit recommendation, not a default assumption", () => {
    const apply = jest.fn();
    const dialog = showAngularSizeDialog({n: 11, onApply: apply, allowFit: true});
    const checks = [...dialog.querySelectorAll('input[type="checkbox"]')];
    expect(checks.every(c => !c.checked)).toBe(true);
    expect(dialog.textContent).toContain("recommended when shape and orientation stay stable");
    checks[0].checked = true;
    checks[3].checked = true;
    dialog.querySelector('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({relativeBound:
        {referenceFrame: 0, startFrame: 0, endFrame: 10, minRatio: .5, maxRatio: 1.5}}),
    {judge: true, fit: false, constantProjectedSize: false});
});

test("Escape dismisses the evidence editor without closing the results underneath", () => {
    const outside = jest.fn();
    document.addEventListener('keydown', outside);
    const dialog = showAngularSizeDialog({n: 11, onApply: jest.fn()});
    dialog.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.querySelector('.angular-size-dialog')).toBeNull();
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outside);
});

test("editing only options preserves recorded provenance and a partial interval", () => {
    const observations = {source: "Measured bounds with a declared calibration",
        relativeBound: {referenceFrame: 3, startFrame: 5, endFrame: 8, minRatio: .8, maxRatio: 1.2}};
    const apply = jest.fn();
    const dialog = showAngularSizeDialog({n: 11, observations, onApply: apply});
    dialog.querySelector('input[type="checkbox"]').checked = true;
    dialog.querySelector('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    expect(apply.mock.calls[0][0]).toBe(observations);
    expect(apply.mock.calls[0][1].judge).toBe(true);
});

test("upper-only data are available with judging off, and cannot enable fitting alone", () => {
    const observations = {source: "Recorded sensor angular-size bounds", samples: [
        {frame: 0, minDeg: 0, maxDeg: .1}, {frame: 10, minDeg: 0, maxDeg: .05}]};
    const apply = jest.fn();
    const dialog = showAngularSizeDialog({n: 11, observations, onApply: apply, allowFit: true});
    const checks = [...dialog.querySelectorAll('input[type="checkbox"]')];
    expect(dialog.textContent).toContain("Available: 2 upper-bound samples");
    expect(dialog.textContent).toContain("Judging: off");
    expect(checks[2].disabled).toBe(true);
    checks[1].checked = true;
    checks[1].dispatchEvent(new Event('change', {bubbles: true}));
    expect(checks[2].disabled).toBe(true);
    checks[3].checked = true; // Add an independently observed relative bound.
    checks[3].dispatchEvent(new Event('change', {bubbles: true}));
    expect(checks[2].disabled).toBe(false);
    checks[0].checked = true;
    checks[2].checked = true;
    dialog.querySelector('form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    expect(apply.mock.calls[0][1]).toEqual({judge: true, fit: true, constantProjectedSize: true});
});
