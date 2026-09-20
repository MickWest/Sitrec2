// Shared plain-language explanations for analysis UI and standalone reports.
// These describe the displayed measurements and assumptions, not new evidence.
const entry = (term, explanation, aliases = []) => ({term, explanation, aliases});
export const TRAVERSE_TERMS = [
    entry("Interpretation", "An assumed way the object moves, such as drifting with the wind or flying at constant speed. Each wind column is a separate fit of that motion model."),
    entry("Supplied wind", "The wind selected as input for this analysis, held fixed while fitting the path. It may be a user assumption or an independent measurement; the fit does not change it."),
    entry("Fitted wind", "Wind chosen by the search together with the object's path. It is fitted independently of the supplied wind, subject to the model's assumptions, search limits and preferences. It is not an independent weather measurement."),
    entry("Supplied + correction", "The supplied wind plus a fitted horizontal vector adjustment. The fit can change eastward and northward wind, but larger adjustments cost more according to the stated correction scale. This is a separate solution, not an extra adjustment to the fitted-wind column.", ["supplied wind + correction"]),
    entry("Correction scale", "The assumed uncertainty scale for each horizontal wind component. A smaller scale keeps the fitted correction closer to the supplied wind; a larger scale allows more change. It is an input assumption, not a measured confidence interval."),
    entry("Target-speed prior", "A preferred speed that adds a soft cost to the search. It can select one path when several fit similarly; it is not a measured object speed or a hard speed requirement."),
    entry("Wind search edge", "The search reached an allowed wind limit. The best value may lie outside the tested region, so the wind has not been resolved."),
    entry("Wind constraint", "What fixes or limits the wind for this candidate: supplied input, fitted correction, or the motion model's assumptions. A good fit alone does not uniquely determine wind."),
    entry("Wind correction", "An eastward/northward vector added to the supplied wind. Vector addition can change both wind speed and direction."),
    entry("Wind shear", "A change in wind speed or direction with altitude. The model estimates only the form of that change that it allows."),
    entry("FROM", "Meteorological wind direction: where the air comes from, measured clockwise from true north. Wind from 180° comes from the south and blows northward."),
    entry("LOS", "Line of sight: the measured viewing direction from the sensor toward the object. A direction alone does not tell us the object's distance.", ["line of sight", "line-of-sight", "sightline", "sightlines"]),
    entry("Mean LOS error", "Average angular separation, in degrees, between the observed viewing directions and the candidate path. Smaller means a closer angular fit; it does not by itself prove the path or distance is correct.", ["Mean LOS offset", "LOS fit error", "LOS residual"]),
    entry("Slant range", "Straight-line distance from the sensor to the object, including height difference. Min–max is how that distance varies over the clip, not an uncertainty interval."),
    entry("Horizontal air speed", "Speed through the air in the local horizontal plane, after subtracting this candidate's wind. A balloon drifting exactly with the wind has zero horizontal air speed. Mean/max are the average and largest sampled speeds.", ["horizontal airspeed"]),
    entry("Vertical air speed", "Signed speed through the air in the local up/down direction, after subtracting vertical wind. Positive means rising; negative means sinking. Mean/range give the average and minimum-to-maximum values in feet per minute. Fitted wind models assume no vertical wind.", ["vertical airspeed"]),
    entry("Air speed", "Motion relative to the moving air, found by subtracting wind from motion over the ground. Horizontal and vertical components are reported separately.", ["airspeed", "air-relative"]),
    entry("Ground speed", "Speed relative to the Earth, including the object's motion through the air and the wind's contribution.", ["ground-relative"]),
    entry("True heading", "Direction of horizontal motion over the ground, clockwise from geographic north. Here it describes travel direction, not which way an aircraft's nose points. The mean respects the 0°/360° wrap."),
    entry("Geodetic", "Measured relative to the curved reference Earth rather than a flat local plane. Geodetic altitude here is height above an idealized smooth Earth surface, not height above terrain."),
    entry("Kinematic acceleration", "How quickly the estimated velocity changes, expressed in units of Earth's gravity (g). This is acceleration inferred from the path, not the force an occupant feels or the object's required thrust.", ["Max g-Force", "g-force", "peak acceleration"]),
    entry("Angular size", "The object's apparent width or height as an angle at the sensor. Converting it to physical size also requires distance and a projected-shape assumption."),
    entry("Angular-size fitting", "Using apparent object size as part of the path search. This is separate from checking size after fitting; unavailable or disabled size evidence does not constrain the fit."),
    entry("Physical compatibility", "Whether the path falls within the tested size, speed, acceleration and motion limits of an object class. Passing those checks does not identify the object; missing checks remain unassessed."),
    entry("Implied object size", "The physical size needed to produce the observed angular size at the candidate's distance. An upper bound supplies only a maximum, not a measured size."),
    entry("Platform acceleration match", "Checks whether the candidate repeats the observing platform's acceleration at the same times. Such a match can indicate a viewing-geometry artifact rather than independent object motion.", ["mirroring"]),
    entry("Model priors cost", "The extra fitting cost from the model's built-in preferences, such as smaller wind or gentler turns. This is separate from the angular mismatch to the observations."),
    entry("Prior", "An assumption or preference supplied before fitting. It helps choose between possible answers but is not evidence measured from this clip.", ["priors"]),
    entry("Model selection", "Choosing between simpler and more flexible motion models. Extra parameters are retained only when they improve the fit by the stated practical amount."),
    entry("Range band", "The span of sampled distances whose solutions passed the stated checks under this model. It is not a measured distance interval or a statistical confidence interval."),
    entry("Model-conditional", "Valid only under the stated motion model, input assumptions and allowed parameter values. Another model can give a different answer."),
    entry("Truth Δ", "Separation between the candidate and a reference trajectory at matching times. Mean 3D uses the average full spatial distance. This comparison is for validation, not fitting."),
    entry("Truth", "A reference trajectory loaded for comparison, often the known path in a synthetic test. It is excluded from fitting and primary ranking. Air-relative truth values still require a wind assumption.", ["truth track"]),
    entry("BOT Score", "Sitrec's weighted score for comparing candidate paths after screening. It combines motion, angular-fit and platform-match terms. Lower is preferred; it is not a probability or an object-identification confidence level."),
    entry("Co-leader", "One of the completed candidates that pass the broad checks and are close enough in score that the ranking does not distinguish them. Display order is not evidence that one is more likely."),
    entry("Passes broad screen", "The candidate passes the current broad checks on fit, motion, model limits and search completion. This is a screening result, not proof that the object or path is correct.", ["broad screen", "broad gates"]),
    entry("Weak fit", "The candidate's mismatch or motion falls outside one or more of the stronger screening thresholds. Read the individual checks to see why."),
    entry("Poor fit", "The candidate fails one or more broad fit or motion checks. The detailed reasons identify the failing quantities."),
    entry("Provisional fit", "A candidate worth inspecting whose search is incomplete or limited. Its current values are not a fully resolved solution."),
    entry("Model limit hit", "A parameter reached a permitted model limit, and moving away from that limit worsened the local fitting objective. The bound affects the result; it is not a measured physical limit.", ["active model limits", "load-bearing"]),
    entry("Optimizer incomplete", "The numerical search stopped without meeting its completion checks. The current candidate may improve with more search; it is not an established optimum."),
    entry("Optimizer", "The numerical procedure that tries parameter values to reduce the fitting cost."),
    entry("Convergence", "The search has met its stopping rule because further local changes are small. This does not prove it found the best answer anywhere in the allowed search region."),
    entry("Search boundary", "An edge of the parameter values the search was allowed to try. A solution on an edge may indicate that the answer remains unresolved beyond the tested region.", ["search bounds", "boundary-limited"]),
    entry("Search completion", "Whether the search met its stopping checks without unfinished-search warnings. Completion does not establish a unique or globally best solution."),
    entry("Residual", "The difference left between the model's prediction and an observation after fitting. Here an LOS residual is an angular difference in degrees.", ["residuals"]),
    entry("Heuristic", "A practical comparison rule or threshold, not a calibrated probability or statistical significance test."),
    entry("Confidence interval", "An uncertainty interval calculated from a specified statistical model and its assumptions. The displayed search bands and assumed wind-correction scale are not such intervals."),
    entry("Family", "Multiple candidate paths that fit about equally well under the tested assumptions. A selected representative does not establish a unique path or distance."),
    entry("Slow-drift valley", "A region of the searched distances where slower paths have low fitting cost. It can replace the faster grid representative when it scores better."),
    entry("Grid representative", "The candidate selected from sampled combinations of search parameters. It represents the search results, not necessarily a uniquely determined solution."),
    entry("CAS/SW", "Constant Air Speed with Supplied Wind: the speed-constrained path is fitted while the input wind is held fixed."),
    entry("CAS/FW", "Constant Air Speed with Fitted Wind: wind and the speed-constrained path are fitted together, using the shared wind assumptions."),
    entry("Constant Air Speed", "Fits a path that approximately holds a requested speed through the air. This solver constrains total 3D speed; displayed horizontal and vertical speeds are its separate components.", ["constant-air-speed", "CAS"]),
    entry("Constant Altitude", "Fits a path that stays at a fixed height while following the observed viewing directions."),
    entry("Minimum Acceleration", "Selects a path that follows the viewing directions while keeping changes in velocity small, with any stated speed preference included."),
    entry("Minimum Speed", "Selects a path that follows the viewing directions while minimizing motion through the air under the stated wind assumption."),
    entry("Kalman smoother", "A motion estimator that combines observations across the clip, first forward and then backward in time. It balances angular fit against assumed smooth motion; it does not identify an object type."),
    entry("Polynomial LSQ", "Least-squares fitting of a smooth polynomial path to the viewing directions. Higher order allows more changes in motion but also more flexibility to fit noise.", ["least squares", "least-squares", "LSQ"]),
    entry("Monte Carlo", "Repeated trials with varied inputs or starting values to explore possible answers. The spread of trials is not automatically a calibrated uncertainty interval."),
    entry("Differential evolution", "A numerical search that improves a population of candidate parameter sets by combining and comparing them. Repeated starts reduce dependence on the first guesses."),
    entry("B-spline", "A smooth curve assembled from simpler curve segments. Its control values let the fit change shape without choosing an object type."),
    entry("IRLS", "Iteratively reweighted least squares: repeatedly solves a weighted fitting problem and updates the weights to handle a nonlinear cost."),
    entry("Forward model", "Predicts an object's path from motion parameters, then compares that path with the observations."),
    entry("Parallax", "Apparent motion caused by the observer changing position. A nearby object can appear to move strongly even when its own motion is small."),
    entry("Degeneracy", "Different combinations of distance and motion produce nearly the same observations, so the data cannot clearly distinguish them.", ["degenerate"]),
    entry("Regularization", "A penalty that favors smoother or more moderate solutions when observations alone leave several possibilities."),
    entry("Bootstrap", "Repeatedly refitting resampled observations to check how stable an answer is. It tests sensitivity within the chosen model, not whether that model is true."),
    entry("Fine scale", "The thin gray copy of the candidate curve uses the right-hand axis to show small changes. Read it against that axis, not the main colored axis.", ["fine-scale"]),
    entry("RMS", "Root mean square: square the values, average them, then take the square root. It measures overall magnitude and gives larger values more influence."),
    entry("std", "Standard deviation: how much the sampled values vary around their mean. This describes variation over the clip, not uncertainty in the fitted answer."),
    entry("ENU", "East, North, Up: the local coordinate frame used for the analysis, with a horizontal plane tangent to the reference Earth at the origin."),
    entry("Azimuth", "Horizontal viewing direction measured clockwise from north."),
    entry("Elevation", "For a viewing direction, the angle above the local horizontal plane; negative angles point below it. For terrain data, elevation instead means the surface's height above its reference level."),
    entry("FOV", "Field of view: the angular width or height covered by the camera image."),
    entry("3D", "Three-dimensional: includes both horizontal directions and vertical position or motion."),
    entry("AGL", "Above ground level: height above the terrain at that location, rather than above the reference Earth."),
    entry("NM", "Nautical mile: exactly 1,852 meters. Used here for distances."),
    entry("kt", "Knot: one nautical mile per hour, about 0.514 meters per second.", ["knots"]),
    entry("fpm", "Feet per minute, a vertical-speed unit. Positive means upward motion; negative means downward motion.", ["ft/min"]),
    entry("Sitch", "A saved Sitrec situation: the scene, source data, camera settings and other analysis configuration.", ["sitches"]),
    entry("Traverse", "A candidate 3D object path inferred or constructed from viewing directions and additional assumptions.", ["traversal"]),
];

const escape = s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const terms = new Map(TRAVERSE_TERMS.flatMap(t => [t.term, ...t.aliases].map(alias => [alias.toLowerCase(), t])));
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// FROM is a wind convention only in its explicit table label, not in prose
// such as "distance from the sensor".
const pattern = new RegExp(`(?<![\\w])(?:${[...terms.keys()].filter(k => k !== "from")
    .sort((a, b) => b.length - a.length).map(escapeRegex).join("|")})(?![\\w])`, "gi");

export function traverseTermAttributes(term) {
    const t = terms.get(term.toLowerCase());
    return t ? `class="traverse-term" data-traverse-term="${escape(t.term)}" title="${escape(t.explanation)}" aria-label="${escape(term + ': ' + t.explanation)}" tabindex="0"` : "";
}

export const TRAVERSE_TERM_CSS = `
.traverse-term { cursor:help; text-decoration:underline dotted; text-decoration-color:#8392a3; text-underline-offset:3px; }
.traverse-term:focus-visible { outline:2px solid #3987e5; outline-offset:3px; }
.traverse-glossary dt { font-weight:650; margin-top:12px; break-after:avoid; }
.traverse-glossary dd { margin:3px 0 12px; }
@media print { .traverse-term { text-decoration:none; } }
`;

// Work on text nodes so names, URLs, attributes, existing event handlers and
// user-provided strings keep their meaning. Repeated calls are idempotent.
export function explainTraverseTerms(root, used = new Set()) {
    const doc = root.ownerDocument;
    root.querySelectorAll("[data-traverse-term]").forEach(el => used.add(el.dataset.traverseTerm));
    const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const parent = node.parentElement;
        if (parent?.closest("script,style,textarea,select,pre,code,svg,canvas,.traverse-term,.traverse-glossary,.tg-ribbon,[title]:not(button)")) continue;
        const matches = [...node.textContent.matchAll(pattern)];
        if (!matches.length) continue;
        const fragment = doc.createDocumentFragment();
        let end = 0;
        for (const match of matches) {
            const t = terms.get(match[0].toLowerCase());
            fragment.append(node.textContent.slice(end, match.index));
            const help = doc.createElement("abbr");
            help.className = "traverse-term";
            help.dataset.traverseTerm = t.term;
            help.title = t.explanation;
            help.textContent = match[0];
            help.setAttribute("aria-label", `${match[0]}: ${t.explanation}`);
            // Headings and measurement labels are keyboard discoverable. Do
            // not insert extra tab stops inside buttons or every prose line.
            if (parent?.closest("th,h2,h3,h4,.tg-stk,.tg-d-stk,.stk") && !parent.closest("button,a")) help.tabIndex = 0;
            fragment.append(help);
            used.add(t.term);
            end = match.index + match[0].length;
        }
        fragment.append(node.textContent.slice(end));
        node.replaceWith(fragment);
    }
    return used;
}

export function explainTraverseHTML(html, used = new Set()) {
    const template = document.createElement("template");
    template.innerHTML = html;
    explainTraverseTerms(template.content, used);
    return template.innerHTML;
}

export function traverseGlossaryHTML(used) {
    return '<p>Definitions of the marked terms used in this report. These explanations are retained when printed or saved as PDF.</p><dl class="traverse-glossary">'
        + TRAVERSE_TERMS.filter(t => used.has(t.term)).sort((a, b) => a.term.localeCompare(b.term))
            .map(t => `<dt>${escape(t.term)}</dt><dd>${escape(t.explanation)}</dd>`).join("") + "</dl>";
}
