// Starting profiles in metres and degrees Celsius. Upper lapse rates describe
// continuation above the last anchor, not the gradients within a layered profile.
export const PROFILE_PRESETS = {
    Standard: [[0, 15], [100, 14.35], [1000, 8.5]],
    "Inferior mirage": [[0, 30], [0.5, 23], [2, 19], [10, 18], [100, 17.4]],
    "Superior mirage": [[0, 10], [2, 10.1], [10, 16], [30, 17], [100, 16.5]],
    "Elevated inversion": [[0, 15], [10, 14.9], [20, 14.8], [30, 19], [45, 19.2], [100, 18.8]],
    "Dry adiabatic": [[0, 20], [1000, 10.2]],
    "Surveying lapse": [[0, 20], [1000, 6.3]],
    "Near-zero refraction": [[0, 25], [1000, -9.2]],
    // Adapted from the Andy Young reference profile in the original simulator.
    // https://aty.sdsu.edu/explain/simulations/inf-mir/Omega.html
    // The 1 km anchor supplies an illustrative upper continuation.
    "Andy Young inferior mirage": [[0, 15.05], [2, 14.11], [4, 13.95], [6, 13.84], [8, 13.77],
        [10, 13.72], [20, 13.52], [30, 13.38], [1000, 13]],
    "Cold-water inversion": [[0, 4], [10, 6], [30, 9], [100, 10], [1000, 3.5]],
    "Ducting inversion": [[0, 10], [25, 10.2], [30, 14], [45, 18], [60, 18.4], [1000, 8]],
    Isothermal: [[0, 15], [1000, 15]],
};

export const PROFILE_PRESET_DETAILS = {
    Standard: {lapseRate: -6.5, note: "15 °C at sea level, cooling by 6.5 K/km."},
    "Inferior mirage": {note: "A hot surface beneath cooler air bends low rays upward."},
    "Superior mirage": {note: "A strong temperature increase above the surface bends low rays downward."},
    "Elevated inversion": {note: "A warm layer above cooler surface air can fold the ray fan."},
    "Dry adiabatic": {lapseRate: -9.8, note: "20 °C at the surface, cooling by 9.8 K/km: a dry, well-mixed reference."},
    "Surveying lapse": {lapseRate: -13.7, note: "A 13.7 K/km lapse gives approximately the traditional surveying k of 0.13 near the surface."},
    "Near-zero refraction": {lapseRate: -34.2, note: "A 34.2 K/km lapse is an approximate near-zero-curvature control. Turn Bend light off for exactly straight rays."},
    "Andy Young inferior mirage": {note: "Reference profile with a rapid temperature drop in the first few metres, adapted from the original simulator."},
    "Cold-water inversion": {note: "Cold surface air beneath warmer air strongly bends low rays downward."},
    "Ducting inversion": {note: "An elevated inversion can turn rays back toward the surface and produce multiple images where geometry is available."},
    Isothermal: {lapseRate: 0, note: "Constant temperature. Light still bends because pressure decreases with height."},
};
