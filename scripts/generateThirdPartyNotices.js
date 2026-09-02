#!/usr/bin/env node

/**
 * Generates ThirdPartyNotices.txt listing all bundled open-source dependencies
 * and their licenses. Modeled on the VS Code ThirdPartyNotices.txt format.
 *
 * Usage:  node scripts/generateThirdPartyNotices.js
 * Output: ThirdPartyNotices.txt in the project root
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "ThirdPartyNotices.txt");

// ---------------------------------------------------------------------------
// Standard license texts used as fallback when no LICENSE file is found
// ---------------------------------------------------------------------------

const STANDARD_LICENSES = {
    "MIT": `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,

    "ISC": `ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,

    "Apache-2.0": `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright
owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities
that control, are controlled by, or are under common control with that entity.
For the purposes of this definition, "control" means (i) the power, direct or
indirect, to cause the direction or management of such entity, whether by
contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the
outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including
but not limited to software source code, documentation source, and
configuration files.

"Object" form shall mean any form resulting from mechanical transformation or
translation of a Source form, including but not limited to compiled object code,
generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made
available under the License, as indicated by a copyright notice that is included
in or attached to the work.

"Derivative Works" shall mean any work, whether in Source or Object form, that
is based on (or derived from) the Work and for which the editorial revisions,
annotations, elaborations, or other modifications represent, as a whole, an
original work of authorship. For the purposes of this License, Derivative Works
shall not include works that remain separable from, or merely link (or bind by
name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version
of the Work and any modifications or additions to that Work or Derivative Works
thereof, that is intentionally submitted to the Licensor for inclusion in the
Work by the copyright owner or by an individual or Legal Entity authorized to
submit on behalf of the copyright owner. For the purposes of this definition,
"submitted" means any form of electronic, verbal, or written communication sent
to the Licensor or its representatives, including but not limited to
communication on electronic mailing lists, source code control systems, and
issue tracking systems that are managed by, or on behalf of, the Licensor for
the purpose of discussing and improving the Work, but excluding communication
that is conspicuously marked or otherwise designated in writing by the copyright
owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of
whom a Contribution has been received by the Licensor and subsequently
incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable copyright license to
reproduce, prepare Derivative Works of, publicly display, publicly perform,
sublicense, and distribute the Work and such Derivative Works in Source or
Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License,
each Contributor hereby grants to You a perpetual, worldwide, non-exclusive,
no-charge, royalty-free, irrevocable (except as stated in this section) patent
license to make, have made, use, offer to sell, sell, import, and otherwise
transfer the Work, where such license applies only to those patent claims
licensable by such Contributor that are necessarily infringed by their
Contribution(s) alone or by combination of their Contribution(s) with the Work
to which such Contribution(s) was submitted. If You institute patent litigation
against any entity (including a cross-claim or counterclaim in a lawsuit)
alleging that the Work or a Contribution incorporated within the Work
constitutes direct or contributory patent infringement, then any patent licenses
granted to You under this License for that Work shall terminate as of the date
such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or
Derivative Works thereof in any medium, with or without modifications, and in
Source or Object form, provided that You meet the following conditions:

(a) You must give any other recipients of the Work or Derivative Works a copy of
this License; and

(b) You must cause any modified files to carry prominent notices stating that You
changed the files; and

(c) You must retain, in the Source form of any Derivative Works that You
distribute, all copyright, patent, trademark, and attribution notices from the
Source form of the Work, excluding those notices that do not pertain to any part
of the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its distribution, then
any Derivative Works that You distribute must include a readable copy of the
attribution notices contained within such NOTICE file, excluding any notices that
do not pertain to any part of the Derivative Works, in at least one of the
following places: within a NOTICE text file distributed as part of the Derivative
Works; within the Source form or documentation, if provided along with the
Derivative Works; or, within a display generated by the Derivative Works, if and
wherever such third-party notices normally appear. The contents of the NOTICE
file are for informational purposes only and do not modify the License. You may
add Your own attribution notices within Derivative Works that You distribute,
alongside or as an addendum to the NOTICE text from the Work, provided that such
additional attribution notices cannot be construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide
additional or different license terms and conditions for use, reproduction, or
distribution of Your modifications, or for any such Derivative Works as a whole,
provided Your use, reproduction, and distribution of the Work otherwise complies
with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any
Contribution intentionally submitted for inclusion in the Work by You to the
Licensor shall be under the terms and conditions of this License, without any
additional terms or conditions. Notwithstanding the above, nothing herein shall
supersede or modify the terms of any separate license agreement you may have
executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names,
trademarks, service marks, or product names of the Licensor, except as required
for reasonable and customary use in describing the origin of the Work and
reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in
writing, Licensor provides the Work (and each Contributor provides its
Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied, including, without limitation, any warranties or
conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
PARTICULAR PURPOSE. You are solely responsible for determining the
appropriateness of using or redistributing the Work and assume any risks
associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in
tort (including negligence), contract, or otherwise, unless required by
applicable law (such as deliberate and grossly negligent acts) or agreed to in
writing, shall any Contributor be liable to You for damages, including any
direct, indirect, special, incidental, or consequential damages of any character
arising as a result of this License or out of the use or inability to use the
Work (including but not limited to damages for loss of goodwill, work stoppage,
computer failure or malfunction, or any and all other commercial damages or
losses), even if such Contributor has been advised of the possibility of such
damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or
Derivative Works thereof, You may choose to offer, and charge a fee for,
acceptance of support, warranty, indemnity, or other liability obligations and/or
rights consistent with this License. However, in accepting such obligations, You
may act only on Your own behalf and on Your sole responsibility, not on behalf of
any other Contributor, and only if You agree to indemnify, defend, and hold each
Contributor harmless for any liability incurred by, or claims asserted against,
such Contributor by reason of your accepting any such warranty or additional
liability.

END OF TERMS AND CONDITIONS`,

    "BSD-3-Clause": `BSD 3-Clause License

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,

    "BSD-2-Clause": `BSD 2-Clause License

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
};

// ---------------------------------------------------------------------------
// Vendored libraries in src/js/ that are not managed by npm
// ---------------------------------------------------------------------------

const VENDORED_LIBRARIES = [
    {
        name: "get-pixels (modified)",
        version: "3.3.3",
        license: "MIT",
        copyright: "Copyright (c) 2013-2014 Mikola Lysenko",
        repository: "https://github.com/scijs/get-pixels",
        notes: "Modified version with Sitrec-specific changes (src/js/get-pixels-mick.js).",
    },
    {
        name: "jsfeat",
        version: "0.0.8 ALPHA",
        license: "MIT",
        copyright: "Copyright (c) 2014 Eugene Zatepyakin",
        repository: "https://github.com/inspirit/jsfeat",
        notes: "Computer vision library. Minified copy in src/js/jsfeat.js.",
    },
    {
        name: "lil-gui (modified)",
        version: "0.19.1",
        license: "MIT",
        copyright: "Copyright (c) 2022 George Michael Brower",
        repository: "https://lil-gui.georgealways.com",
        notes: "Modified version with Sitrec-specific changes (src/js/lil-gui.esm.js).",
    },
    {
        name: "misb.js",
        version: "1.0.0",
        license: "MIT",
        copyright: "Copyright (c) 2021 Vidterra",
        repository: "https://github.com/vidterra/misb.js",
        licenseFile: path.join(ROOT, "src/js/misb.js-main/LICENSE"),
        notes: "MISB standards implementation (src/js/misb.js-main/).",
    },
    {
        name: "mp4box.js",
        version: "0.5.2",
        license: "BSD-3-Clause",
        copyright: "Copyright (c) 2012-2013 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato",
        repository: "https://github.com/gpac/mp4box.js",
        notes: "MP4 demuxing library (src/js/mp4box.all.js).",
    },
    {
        name: "OpenCV.js",
        version: "4.12.0",
        license: "Apache-2.0",
        copyright: "Copyright (c) 2000-2024 Intel Corporation, Willow Garage Inc., NVIDIA Corporation, and contributors",
        repository: "https://github.com/opencv/opencv",
        notes: "Compiled to JavaScript/WebAssembly via Emscripten (src/js/opencv.js).",
    },
    {
        name: "OrbitControls (Three.js)",
        version: "0.183.0",
        license: "MIT",
        copyright: "Copyright (c) 2010-2024 three.js authors",
        repository: "https://github.com/mrdoob/three.js",
        notes: "Extracted from Three.js examples with modifications (src/js/OrbitControls.js).",
    },
    {
        name: "FlyControls (Three.js)",
        version: "0.183.0",
        license: "MIT",
        copyright: "Copyright (c) 2010-2024 three.js authors",
        repository: "https://github.com/mrdoob/three.js",
        notes: "Extracted from Three.js examples (src/js/FlyControls.js).",
    },
    {
        name: "TrackballControls (Three.js)",
        version: "0.183.0",
        license: "MIT",
        copyright: "Copyright (c) 2010-2024 three.js authors",
        repository: "https://github.com/mrdoob/three.js",
        notes: "Extracted from Three.js examples (src/js/TrackballControls.js).",
    },
    {
        name: "three-spritetext",
        version: "1.8.2",
        license: "MIT",
        copyright: "Copyright (c) 2018 Vasco Asturiano",
        repository: "https://github.com/vasturiano/three-spritetext",
        notes: "Vendored copy (src/js/three-spritetext.js).",
    },
    {
        name: "uPlot (modified)",
        version: "1.6.18",
        license: "MIT",
        copyright: "Copyright (c) 2022 Leon Sorokin",
        repository: "https://github.com/leeoniya/uPlot",
        notes: "Pinned at v1.6.18 with Sitrec-specific modifications (src/js/uPlot/). Contains monotone cubic spline code adapted from Chartist.js (MIT, Copyright (c) 2013 Gion Kunz, https://github.com/gionkunz/chartist-js).",
    },
    {
        name: "ACESFilmicToneMappingShader (Three.js)",
        version: "n/a",
        license: "MIT",
        copyright: "Copyright (c) 2010-2024 three.js authors",
        repository: "https://github.com/mrdoob/three.js",
        notes: "ACES filmic tone mapping by Stephen Hill, extracted from Three.js examples (src/shaders/ACESFilmicToneMappingShader.js). Original source: https://github.com/selfshadow/ltc_code/blob/master/webgl/shaders/ltc/ltc_blit.fs",
    },
    {
        name: "FLIR Shader (adapted from Geeks3D)",
        version: "n/a",
        license: "Public tutorial code",
        copyright: "",
        repository: "https://www.geeks3d.com/20091009/shader-library-night-vision-post-processing-filter-glsl/",
        notes: "FLIR post-processing shader adapted from Geeks3D shader tutorial (src/shaders/FLIRShader.js).",
        licenseTextOverride: `This shader is adapted from a publicly available shader tutorial by Geeks3D:
https://www.geeks3d.com/20091009/shader-library-night-vision-post-processing-filter-glsl/

The tutorial code has been substantially modified for use as a FLIR
(Forward Looking Infrared) post-processing effect in Sitrec.`,
    },
];

// ---------------------------------------------------------------------------
// Bundled data files (catalogs, asterism definitions, etc.)
// These are not source code and have separate provenance/licensing.
// ---------------------------------------------------------------------------

const DATA_FILES = [
    {
        name: "d3-celestial constellations data",
        version: "n/a",
        license: "BSD-3-Clause",
        copyright: "Copyright (c) 2015, Olaf Frohn",
        repository: "https://github.com/ofrohn/d3-celestial",
        notes: "Constellation line and metadata GeoJSON (data/nightsky/constellations.lines.json, data/nightsky/constellations.json).",
    },
    {
        name: "Astrometry.net asterism lines",
        version: "n/a",
        license: "BSD-3-Clause",
        copyright: "Copyright (c) 2006-2015, Astrometry.net Developers",
        repository: "https://github.com/dstndstn/astrometry.net",
        notes: "Constellation/asterism line dataset (data/nightsky/constellations.lines.astrometry.json). Derived from catalogs/stellarium-constellations.c via scripts/convertAstrometryConstellations.js. Upstream asterism conventions originate from Stellarium's default 'Western' skyculture; redistributed by Astrometry.net under BSD-3-Clause.",
    },
    {
        name: "IAU Catalog of Star Names (IAU-CSN)",
        version: "n/a",
        license: "Public Domain",
        copyright: "International Astronomical Union Working Group on Star Names (WGSN)",
        repository: "https://www.iau.org/public/themes/naming_stars/",
        notes: "Reference catalog of officially-approved IAU star names (data/nightsky/IAU-CSN.txt).",
        licenseTextOverride: `The IAU Catalog of Star Names is a public reference document maintained by
the International Astronomical Union (IAU) Working Group on Star Names. It
lists star names officially approved by the IAU and is freely usable.
See: https://www.iau.org/public/themes/naming_stars/`,
    },
    {
        name: "Hipparcos Catalogue (ESA)",
        version: "ESA SP-1200 (1997)",
        license: "Public Domain",
        copyright: "European Space Agency (ESA) / Hipparcos mission",
        repository: "https://www.cosmos.esa.int/web/hipparcos",
        notes: "The star catalogue Sitrec actually loads and renders: repacked as " +
            "data/nightsky/sitrec_bsc_lite.bin — 117,955 stars keyed by Hipparcos (HIP) number, " +
            "magnitudes -1.44 to 14.08. Despite the filename and the BSC5 key in " +
            "src/ExtraFiles.js, the CONTENTS are Hipparcos, not the Yale Bright Star Catalogue; " +
            "only the 28-byte-header / 22-byte-record binary container comes from the BSC5 " +
            "format. Star proper names are correlated to it by HIP number from the IAU CSN.",
        licenseTextOverride: `The Hipparcos Catalogue is the astrometric catalogue produced by the European
Space Agency's Hipparcos mission and published as ESA Special Publication
SP-1200 (1997). ESA distributes it for free public use, and the data are facts
(stellar positions, parallaxes, magnitudes, etc.) not subject to copyright.
Reference: M. A. C. Perryman, L. Lindegren, J. Kovalevsky et al., "The
HIPPARCOS Catalogue", Astronomy & Astrophysics 323, L49-L52, 1997.`,
    },
    {
        name: "Yale Bright Star Catalog (BSC5)",
        version: "5th Revised",
        license: "Public Domain",
        copyright: "Hoffleit, D. & Warren, W.H., Yale University Observatory",
        repository: "http://tdc-www.harvard.edu/catalogs/bsc5.html",
        notes: "Present in the tree as data/nightsky/BSC5.bin but NOT loaded — the BSC5 entry in " +
            "src/ExtraFiles.js points at the Hipparcos repack above. Credited because the file " +
            "is still distributed, and because the BSC5 binary format is what that repack uses.",
        licenseTextOverride: `The Yale Bright Star Catalog (BSC5) is a public-domain stellar catalog
originally compiled by Dorrit Hoffleit and Wayne H. Warren Jr. at Yale
University Observatory and distributed via NASA ADC / Harvard CDS.
The data are facts (stellar positions, magnitudes, etc.) and are not
subject to copyright restrictions.`,
    },
    {
        name: "EGM96 geoid (15-arc-minute grid)",
        version: "EGM96",
        license: "Public Domain",
        copyright: "U.S. National Geospatial-Intelligence Agency (NGA) / NASA / Ohio State University",
        repository: "https://earth-info.nga.mil/",
        notes: "Earth Gravitational Model 1996 geoid-undulation grid, extracted from the egm96-universal package and repacked for Sitrec as data/egm96/egm96-15.bin (gzip(planar(rowDelta(721x1440 int16))), see scripts/extractEGM96Geoid.js).",
        licenseTextOverride: `The EGM96 (Earth Gravitational Model 1996) geoid is a public-domain
geophysical model produced by the U.S. National Geospatial-Intelligence
Agency (NGA, formerly NIMA), NASA Goddard Space Flight Center, and Ohio
State University. The grid values are scientific facts (geoid undulation
heights) and are not subject to copyright restrictions.
See: https://earth-info.nga.mil/`,
    },
];

// ---------------------------------------------------------------------------
// Optional/separate components (not in the main webpack bundle)
// ---------------------------------------------------------------------------

const OPTIONAL_COMPONENTS = [
    {
        name: "Three.js (local tools copy)",
        version: "0.180.0",
        license: "MIT",
        copyright: "Copyright (c) 2010-2025 three.js authors",
        repository: "https://github.com/mrdoob/three.js",
        notes: "Local copy in tools/three.js/ for standalone HTML tools. Not part of the main webpack bundle.",
    },
    {
        name: "Segment Anything Model 2 (SAM2)",
        version: "2.0",
        license: "Apache-2.0",
        copyright: "Copyright (c) Meta Platforms, Inc. and affiliates",
        repository: "https://github.com/facebookresearch/segment-anything-2",
        licenseFile: path.join(ROOT, "sam2-service/segment-anything-2/LICENSE"),
        notes: "Optional video segmentation service (sam2-service/). Requires separate Python environment. Not part of the main application bundle.",
    },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LICENSE_FILE_NAMES = [
    "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE.MIT", "LICENSE.markdown",
    "LICENCE", "LICENCE.md", "LICENCE.txt",
    "COPYING", "COPYING.md", "COPYING.txt",
    "license", "license.md", "license.txt",
];

function findLicenseFile(pkgDir) {
    for (const name of LICENSE_FILE_NAMES) {
        const p = path.join(pkgDir, name);
        if (fs.existsSync(p)) {
            return fs.readFileSync(p, "utf-8").trim();
        }
    }
    return null;
}

function normalizeRepo(repo) {
    if (!repo) return "";
    if (typeof repo === "string") return repo;
    return repo.url || "";
}

function cleanRepoUrl(url) {
    if (!url) return "";
    return url
        .replace(/^git\+/, "")
        .replace(/^git:\/\//, "https://")
        .replace(/\.git$/, "")
        .replace(/^ssh:\/\/git@github\.com/, "https://github.com");
}

function getAuthorString(author) {
    if (!author) return "";
    if (typeof author === "string") return author;
    let s = author.name || "";
    if (author.email) s += ` <${author.email}>`;
    if (author.url) s += ` (${author.url})`;
    return s;
}

// Normalize the license field from package.json
// It can be a string, an object { type, url }, or an array (legacy SPDX)
function normalizeLicense(lic) {
    if (!lic) return "UNKNOWN";
    if (typeof lic === "string") return lic;
    if (typeof lic === "object" && lic.type) return lic.type;
    if (Array.isArray(lic)) return lic.map(l => normalizeLicense(l)).join(" OR ");
    return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Extract bundled package names from webpack stats JSON
// ---------------------------------------------------------------------------

function extractBundledPackages(statsPath) {
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
    const modules = stats.modules || [];
    const pkgs = new Set();
    for (const m of modules) {
        const name = m.name || m.identifier || "";
        // Match node_modules/PACKAGE or node_modules/@SCOPE/PACKAGE
        const match = name.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
        if (match) pkgs.add(match[1]);
    }
    return pkgs;
}

// ---------------------------------------------------------------------------
// Resolve package info from node_modules for a given package name
// ---------------------------------------------------------------------------

function resolvePackageInfo(pkgName) {
    // Try to find the package in node_modules (may be nested)
    const pkgDir = path.join(ROOT, "node_modules", pkgName);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return null;

    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    } catch { return null; }

    const license = normalizeLicense(pkg.license || pkg.licenses);
    const repoUrl = cleanRepoUrl(normalizeRepo(pkg.repository));
    const homepage = pkg.homepage || "";
    const url = repoUrl || homepage;
    const author = getAuthorString(pkg.author);

    let licenseText = findLicenseFile(pkgDir);
    if (!licenseText) {
        const normalized = license.replace(/\s*\(.*\)/, "");
        if (STANDARD_LICENSES[normalized]) {
            const copyrightLine = author
                ? `Copyright (c) ${author}`
                : (pkg.contributors ? `Copyright (c) ${pkg.name} contributors` : "");
            licenseText = copyrightLine
                ? copyrightLine + "\n\n" + STANDARD_LICENSES[normalized]
                : STANDARD_LICENSES[normalized];
        } else {
            licenseText = `License: ${license}\nSee ${url || "package repository"} for full license text.`;
        }
    }

    return {
        name: pkg.name,
        version: pkg.version,
        license,
        url,
        author,
        licenseText,
    };
}

// ---------------------------------------------------------------------------
// Collect npm dependencies — from webpack stats (accurate) or npm ls (fallback)
// ---------------------------------------------------------------------------

function collectNpmDeps(statsPath) {
    if (statsPath) {
        // Accurate mode: only packages webpack actually bundled
        console.log(`  Reading webpack stats from ${statsPath}`);
        const bundled = extractBundledPackages(statsPath);
        console.log(`  Webpack bundled ${bundled.size} npm packages.`);

        // Exclude webpack internals that aren't real shipped dependencies
        const WEBPACK_INTERNALS = new Set(["css-loader", "style-loader", "mini-css-extract-plugin"]);

        // Packages we SHIP but never IMPORT: copy-webpack-plugin drops their files
        // into the output verbatim, so they are not webpack modules and the stats
        // file cannot see them. Without this they silently lose their attribution
        // in every --from-stats run, while still being distributed. Keep in step
        // with webpackCopyPatterns.js; a name listed here that is also imported is
        // harmless, since `bundled` is a Set.
        const COPIED_NOT_IMPORTED = [
            "@cornerstonejs/codec-openjpeg",   // libs/openjpeg — JPEG 2000 WASM decoder
        ];
        for (const pkgName of COPIED_NOT_IMPORTED) bundled.add(pkgName);

        const results = [];
        for (const pkgName of bundled) {
            if (WEBPACK_INTERNALS.has(pkgName)) continue;
            const info = resolvePackageInfo(pkgName);
            if (info) {
                results.push(info);
            } else {
                console.warn(`  WARNING: Could not resolve package info for: ${pkgName}`);
            }
        }
        return results;
    }

    // Fallback: use npm ls (conservative — includes all transitive deps)
    console.log("  WARNING: No webpack stats file. Using npm ls (may include unused transitive deps).");
    console.log("  For accurate results, run: npm run generate-notices");
    let raw;
    try {
        raw = execSync("npm ls --production --all --parseable 2>/dev/null", {
            cwd: ROOT,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
        });
    } catch (e) {
        raw = e.stdout || "";
    }

    const lines = raw.trim().split("\n").filter(Boolean);
    const seen = new Map();

    for (const pkgDir of lines) {
        const pkgJsonPath = path.join(pkgDir, "package.json");
        if (!fs.existsSync(pkgJsonPath)) continue;

        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
        } catch { continue; }

        if (pkgDir === ROOT) continue;

        const key = `${pkg.name}@${pkg.version}`;
        if (seen.has(key)) continue;

        const info = resolvePackageInfo(pkg.name);
        if (info) seen.set(key, info);
    }

    return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Collect vendored libraries
// ---------------------------------------------------------------------------

function resolveLicenseText(v) {
    // 1. Explicit override text
    if (v.licenseTextOverride) return v.licenseTextOverride;

    // 2. Try to read a specified license file
    if (v.licenseFile && fs.existsSync(v.licenseFile)) {
        return fs.readFileSync(v.licenseFile, "utf-8").trim();
    }

    // 3. Fall back to standard template
    const template = STANDARD_LICENSES[v.license];
    if (template) {
        return (v.copyright ? v.copyright + "\n\n" : "") + template;
    }

    return `License: ${v.license}\nSee ${v.repository} for full license text.`;
}

function collectEntries(list) {
    return list.map(v => ({
        name: v.name,
        version: v.version,
        license: v.license,
        url: v.repository,
        author: v.copyright || "",
        licenseText: resolveLicenseText(v),
        notes: v.notes || "",
    }));
}

function collectVendoredDeps() {
    return collectEntries(VENDORED_LIBRARIES);
}

function collectDataFiles() {
    return collectEntries(DATA_FILES);
}

function collectOptionalDeps() {
    return collectEntries(OPTIONAL_COMPONENTS);
}

// ---------------------------------------------------------------------------
// Generate the notices file
// ---------------------------------------------------------------------------

function generate() {
    // Parse CLI args
    const args = process.argv.slice(2);
    const statsIdx = args.indexOf("--from-stats");
    const statsPath = statsIdx !== -1 ? args[statsIdx + 1] : null;
    const copyIdx = args.indexOf("--copy-to");
    let copyTo = copyIdx !== -1 ? args[copyIdx + 1] : null;

    // --copy-to-prod resolves the path from config/config-install.js, or from
    // SITREC_PROD_PATH when building for another deployment (see buildTarget.js)
    if (args.includes("--copy-to-prod")) {
        copyTo = require("./buildTarget").prodPath();
        if (!copyTo) {
            console.warn("  WARNING: No prod_path in config/config-install.js and no SITREC_PROD_PATH");
        }
    }

    if (statsPath && !fs.existsSync(statsPath)) {
        console.error(`ERROR: Stats file not found: ${statsPath}`);
        process.exit(1);
    }

    console.log("Collecting npm dependencies...");
    const npmDeps = collectNpmDeps(statsPath);
    console.log(`  Found ${npmDeps.length} npm packages.`);

    console.log("Collecting vendored libraries...");
    const vendored = collectVendoredDeps();
    console.log(`  Found ${vendored.length} vendored libraries.`);

    console.log("Collecting bundled data files...");
    const dataFiles = collectDataFiles();
    console.log(`  Found ${dataFiles.length} data files.`);

    console.log("Collecting optional components...");
    const optional = collectOptionalDeps();
    console.log(`  Found ${optional.length} optional components.`);

    // Combine bundled deps and sort alphabetically
    const bundledDeps = [...npmDeps, ...vendored].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    const dataFileDeps = dataFiles.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    const optionalDeps = optional.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );

    const SEPARATOR = "-".repeat(57);

    function appendEntries(lines, deps) {
        for (const dep of deps) {
            lines.push(SEPARATOR);
            lines.push("");
            lines.push(`${dep.name} ${dep.version} - ${dep.license}`);
            if (dep.url) lines.push(dep.url);
            if (dep.notes) lines.push(`(${dep.notes})`);
            lines.push("");
            lines.push(dep.licenseText);
            lines.push("");
        }
    }

    const lines = [];
    lines.push("THIRD-PARTY SOFTWARE NOTICES AND INFORMATION");
    lines.push("Do Not Translate or Localize");
    lines.push("");
    lines.push("This project incorporates components from the projects listed below.");
    lines.push("The original copyright notices and the licenses under which Sitrec");
    lines.push("received such components are set forth below. Sitrec reserves all");
    lines.push("rights not expressly granted herein, whether by implication, estoppel,");
    lines.push("or otherwise.");
    lines.push("");

    appendEntries(lines, bundledDeps);
    lines.push(SEPARATOR);

    if (dataFileDeps.length > 0) {
        lines.push("");
        lines.push("");
        lines.push("=".repeat(57));
        lines.push("BUNDLED DATA FILES");
        lines.push("=".repeat(57));
        lines.push("");
        lines.push("The following data files (astronomical catalogs, asterism");
        lines.push("definitions, etc.) are bundled with Sitrec. They are not");
        lines.push("source code; many contain factual data not subject to");
        lines.push("copyright. Provenance and license/attribution are recorded");
        lines.push("below.");
        lines.push("");
        appendEntries(lines, dataFileDeps);
        lines.push(SEPARATOR);
    }

    if (optionalDeps.length > 0) {
        lines.push("");
        lines.push("");
        lines.push("=".repeat(57));
        lines.push("OPTIONAL / SEPARATELY DISTRIBUTED COMPONENTS");
        lines.push("=".repeat(57));
        lines.push("");
        lines.push("The following components are not part of the main application");
        lines.push("bundle. They are distributed as separate tools or services and");
        lines.push("are only included when explicitly installed or enabled.");
        lines.push("");
        appendEntries(lines, optionalDeps);
        lines.push(SEPARATOR);
    }

    const allDeps = [...bundledDeps, ...dataFileDeps, ...optionalDeps];
    const content = lines.join("\n");
    fs.writeFileSync(OUTPUT, content, "utf-8");
    console.log(`\nWrote ${OUTPUT} (${allDeps.length} entries, ${content.length} bytes)`);

    // Copy to build output directory if requested
    if (copyTo) {
        const destDir = path.resolve(copyTo);
        if (fs.existsSync(destDir)) {
            const dest = path.join(destDir, "ThirdPartyNotices.txt");
            fs.copyFileSync(OUTPUT, dest);
            console.log(`Copied to ${dest}`);
        } else {
            console.warn(`WARNING: Output directory does not exist, skipping copy: ${destDir}`);
        }
    }

    // Print license summary
    const licenseCounts = {};
    for (const dep of allDeps) {
        licenseCounts[dep.license] = (licenseCounts[dep.license] || 0) + 1;
    }
    console.log("\nLicense summary:");
    for (const [lic, count] of Object.entries(licenseCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${lic}: ${count}`);
    }
}

generate();
