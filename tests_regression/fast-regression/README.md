# Fast Chrome visual-regression harness

A fast, reliable visual-regression pass over every sitch tagged with the
**`Regression`** label in the sitch browser. Built to be *much* faster than the
Playwright test-runner suite (`tests_regression/regression.test.js`) and easy for
both humans and AI agents to drive.

## Why it's fast

| | Playwright suite | this harness |
|---|---|---|
| Browser | bundled Chromium, **SwiftShader CPU** rasterizer | **real installed Chrome**, Metal GPU |
| Cache | fresh context per worker → **cold every test** | one **persistent profile** → **warm tile/asset cache** |
| Flake control | `retries=3` to absorb SwiftShader shader-link races | real GPU is deterministic; no retries needed |
| Sitch list | hardcoded `testData[]` | **dynamic** — every `Regression`-labeled sitch |

Measured: **~18s warm** for the current 6 sitches at the default 3 lanes (~38s
serial), all passing with 0–2px diff.

## Usage

```bash
npm run test-fast            # compare every Regression sitch vs its baseline
npm run test-fast-update     # (re)generate ALL baselines (do this in-suite, see note)
npm run test-fast-list       # just list the Regression sitches + latest versions

# direct, with flags:
node tests_regression/fast-regression/run.mjs --filter=wind     # only matching sitches
node tests_regression/fast-regression/run.mjs --concurrency=2   # N pages in parallel (bonus)
node tests_regression/fast-regression/run.mjs --headed          # show the Chrome window (default is headless)
node tests_regression/fast-regression/run.mjs --update --filter=ThomasH   # re-baseline one
```

> **Network/sandbox:** the harness talks to `local.metabunk.org` and S3, so run it
> with the sandbox disabled if your shell sandboxes network.

> **App code changes:** the harness loads the deployed build of the **current
> worktree** (the URL is auto-derived from the git branch — `main` →
> `local.metabunk.org/sitrec/`, any other branch → `local.metabunk.org/<branch>/`,
> matching `config/config-install.js`), so run `npm run build` after editing `src/`
> before re-testing.

### Flags

| flag | default | meaning |
|---|---|---|
| `--update` | off | write/refresh baselines instead of comparing |
| `--filter=SUBSTR` | — | only sitches whose name contains SUBSTR (case-insensitive) |
| `--sitches=A,B,C` | — | test these exact saved-sitch names, bypassing the label (vet candidates / one-off checks) |
| `--concurrency=N` | 3 | run N sitches in parallel (one Chrome page each). ~2× faster; pixel-identical to serial on a real GPU. Use 1 for CI/SwiftShader or strict ordering |
| `--headed` | off | show the Chrome window. **Default is headless** — new-headless Chrome uses the *same* ANGLE Metal GPU backend as headed (verified `ANGLE Metal Renderer` in both) at the same speed, but draws no window, so repeated runs don't steal keyboard focus while you work. Use `--headed` to watch a run. (Headed and headless ANGLE rasterize ~0.1-0.5% differently, so baselines are mode-specific — regenerate if you switch modes.) `--headless` is still accepted as a no-op. |
| `--label=NAME` | `Regression` | enumerate a different label |
| `--frame=N` | 10 | frame to lock + screenshot |
| `--maxDiffRatio=R` | 0.001 | fraction of pixels allowed to differ before FAIL |
| `--cropTop=PX` | 30 | pixels cropped off the top (menu bar has a live clock) |
| `--base=URL` | current worktree's build (`local.metabunk.org/<buildFolder>/`) | app base URL override |

## How a sitch is tested

1. Enumerate `Regression`-labeled sitch names from `sitrecServer/metadata.php`
   (`sitchLabels`), then resolve each to its latest version URL via
   `getsitches.php?get=versions`. (Pure Node — no browser, no CORS.)
2. Navigate real Chrome to `BASE?custom=<url>&regression=1&frame=10&ignoreunload=1`.
3. Wait for the scene to **settle** (load/parse/tile/elevation bookkeeping goes
   quiet *and* the visible-tile set is stable — ported from `regression.test.js`).
4. Force one render (regression mode renders on-demand; `frame=10` locks
   `par.frame` via `Globals.fixedFrame`), flush every WebGL context.
5. Screenshot a fixed `1920×1050` clip — the top 30px **menu bar (which has a live
   clock!) is cropped off**.
6. Pixel-compare to the baseline with `pixelmatch`.

## Output (agent-friendly)

`output/report.json` — machine-readable, one entry per sitch:

```jsonc
{
  "name": "wind test", "slug": "wind-test", "status": "pass|fail|error|baseline|updated",
  "diffPixels": 0, "diffRatio": 0, "renderedFrame": 10,
  "cause": "matches baseline within tolerance",     // one-line why
  "baselinePath": "...png", "actualPath": null, "diffPath": null   // set on failure
}
```

Exit codes: **0** all good · **1** visual diffs only · **2** at least one hard
error (load/assert/blank). On a diff, `output/<slug>_Bad.png` and `_Diff.png` are
written and their paths land in the report.

## Adding coverage

Tag a sitch `Regression` in the sitch browser (right-click → label). It's picked
up automatically on the next run — no code change. Then generate its baseline:

```bash
npm run test-fast-update     # regenerates ALL baselines in-suite
```

> **Note — always baseline in-suite.** Generate baselines with a full
> `--update` run (not `--filter`), so each sitch is loaded in the same browser
> context/order as a real compare run. Commit the new `baseline/*.png` after
> eyeballing them.

## Layout

```
run.mjs            the runner
baseline/*.png     committed baselines (one per sitch, slug-named)
output/            report.json + *_Bad/_Diff.png on failure   (gitignored)
.chrome-profile/   persistent Chrome profile = warm cache     (gitignored)
```
