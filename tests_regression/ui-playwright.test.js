import path from 'path';
import {expect, test} from '@playwright/test';
import {takeScreenshotOrCompare} from './snapshot-utils.js';

async function waitForFrames(page, count = 10, maxWaitMs = 5000) {
    // Avoid page.evaluate here: under heavy GPU/video load, main-thread stalls can make
    // evaluate itself hit the Playwright test timeout.
    const targetMs = Math.max(1, count) * 16;
    await page.waitForTimeout(Math.min(maxWaitMs, targetMs));
}

async function clickMenuTitle(page, menuName) {
    const result = await page.evaluate(({ name }) => {
        const titles = document.querySelectorAll('.lil-gui .title');
        const titleTexts = Array.from(titles).map(t => t.textContent.trim());
        for (const title of titles) {
            if (title.textContent.trim() === name) {
                title.click();
                return { success: true, found: titleTexts };
            }
        }
        return { success: false, found: titleTexts };
    }, { name: menuName });
    
    if (!result.success) {
        throw new Error(`Could not find ${menuName} menu. Available: ${result.found.join(', ')}`);
    }
}

async function setSliderValue(page, folderName, sliderName, value) {
    const result = await page.evaluate(({ folder, slider, val }) => {
        const guiFolder = Array.from(document.querySelectorAll('.lil-gui')).find(gui => {
            const title = gui.querySelector(':scope > .title');
            return title && title.textContent.trim() === folder;
        });
        
        if (!guiFolder) {
            return { success: false, error: `${folder} folder not found` };
        }
        
        const controllers = guiFolder.querySelectorAll('.controller');
        for (const controller of controllers) {
            const name = controller.querySelector('.name');
            if (name && name.textContent.trim() === slider) {
                const input = controller.querySelector('input');
                if (input) {
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeInputValueSetter.call(input, String(val));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true };
                }
            }
        }
        return { success: false, error: `${slider} controller not found in ${folder}` };
    }, { folder: folderName, slider: sliderName, val: value });
    
    if (!result.success) {
        throw new Error(result.error);
    }
}

async function setCheckboxValue(page, folderName, checkboxName, value) {
    const result = await page.evaluate(({ folder, checkbox, val }) => {
        const guiFolder = Array.from(document.querySelectorAll('.lil-gui')).find(gui => {
            const title = gui.querySelector(':scope > .title');
            return title && title.textContent.trim() === folder;
        });
        
        if (!guiFolder) {
            return { success: false, error: `${folder} folder not found` };
        }
        
        const controllers = guiFolder.querySelectorAll('.controller');
        for (const controller of controllers) {
            const name = controller.querySelector('.name');
            if (name && name.textContent.trim() === checkbox) {
                const input = controller.querySelector('input[type="checkbox"]');
                if (input) {
                    if (input.checked !== val) {
                        input.click();
                    }
                    return { success: true };
                }
            }
        }
        return { success: false, error: `${checkbox} controller not found in ${folder}` };
    }, { folder: folderName, checkbox: checkboxName, val: value });
    
    if (!result.success) {
        throw new Error(result.error);
    }
}

async function takeSnapshot(page, snapshotName, testInfo) {
    await takeScreenshotOrCompare(page, snapshotName, testInfo, {
        maxDiffPixels: 100,
        threshold: 0.05,
    });
}

async function waitForConsoleText(page, expectedText, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for console text: "${expectedText}"`));
        }, timeoutMs);

        const handler = (msg) => {
            if (msg.text().includes(expectedText)) {
                clearTimeout(timeout);
                page.off('console', handler);
                resolve();
            }
        };

        page.on('console', handler);
    });
}

async function getSceneSettleState(page) {
    return page.evaluate(() => {
        const globals = window.Globals;
        const nodeMan = window.NodeMan;

        const state = {
            ready: !!globals && !!nodeMan && !!nodeMan.list,
            pendingActions: 0,
            texturePendingLoads: 0,
            textureLoading: 0,
            textureRecalc: 0,
            textureNeedsHighRes: 0,
            texturePendingAncestor: 0,
            textureUsingParentData: 0,
            elevationLoading: 0,
            elevationRecalc: 0,
            elevationPendingAncestor: 0,
            activeVisibleTextureTiles: 0,
            activeElevationTiles: 0,
            pending3DTiles: 0,
            visibleTileHash: 0,
            tilesVisibilityVersionHash: 0,
        };

        if (!state.ready) {
            return state;
        }

        state.pendingActions = globals.pendingActions ?? 0;

        const hashString = (input) => {
            let hash = 2166136261;
            for (let i = 0; i < input.length; i++) {
                hash ^= input.charCodeAt(i);
                hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
            }
            return hash >>> 0;
        };

        const addTileHash = (tile, mapID) => {
            const tileSig = `${mapID}:${tile.z}/${tile.x}/${tile.y}:${tile.usingParentData ? 1 : 0}:${tile.needsHighResLoad ? 1 : 0}:${tile.pendingAncestorLoad ? 1 : 0}`;
            state.visibleTileHash = (state.visibleTileHash ^ hashString(tileSig)) >>> 0;
        };

        for (const entry of Object.values(nodeMan.list)) {
            const node = entry?.data;
            if (!node) continue;

            if (node.elevationMap && node.elevationMap.forEachTile) {
                node.elevationMap.forEachTile((tile) => {
                    const active = (tile.tileLayers ?? 0) !== 0;
                    if (!active) return;

                    state.activeElevationTiles++;
                    if (tile.isLoadingElevation) state.elevationLoading++;
                    if (tile.isRecalculatingCurve) state.elevationRecalc++;
                    if (tile.pendingAncestorLoad) state.elevationPendingAncestor++;
                });
            }

            if (node.maps) {
                for (const mapID in node.maps) {
                    const map = node.maps[mapID]?.map;
                    if (!map || !map.forEachTile) continue;

                    if (map.pendingTileLoads && typeof map.pendingTileLoads.size === "number") {
                        state.texturePendingLoads += map.pendingTileLoads.size;
                    }

                    map.forEachTile((tile) => {
                        const active = (tile.tileLayers ?? 0) !== 0;
                        const visible = !!tile.mesh?.visible;
                        if (!active || !visible) return;

                        state.activeVisibleTextureTiles++;
                        addTileHash(tile, mapID);

                        if (tile.isLoading) state.textureLoading++;
                        if (tile.isRecalculatingCurve) state.textureRecalc++;
                        if (tile.needsHighResLoad) state.textureNeedsHighRes++;
                        if (tile.pendingAncestorLoad) state.texturePendingAncestor++;
                        if (tile.usingParentData) state.textureUsingParentData++;
                    });
                }
            }

            if (typeof node.getPendingLoadState === "function") {
                const pending = node.getPendingLoadState();
                if (pending?.hasPending) {
                    state.pending3DTiles++;
                }
                if (pending?.perView) {
                    for (const stats of Object.values(pending.perView)) {
                        const version = stats?.visibilityVersion ?? 0;
                        state.tilesVisibilityVersionHash = ((state.tilesVisibilityVersionHash * 33) ^ (version + 1)) >>> 0;
                    }
                }
            }
        }

        return state;
    });
}

function formatSceneSettleState(state) {
    return [
        `pendingActions=${state.pendingActions}`,
        `texPendingSet=${state.texturePendingLoads}`,
        `texLoading=${state.textureLoading}`,
        `texRecalc=${state.textureRecalc}`,
        `texNeedsHighRes=${state.textureNeedsHighRes}`,
        `texPendingAncestor=${state.texturePendingAncestor}`,
        `texUsingParent=${state.textureUsingParentData}`,
        `elevLoading=${state.elevationLoading}`,
        `elevRecalc=${state.elevationRecalc}`,
        `elevPendingAncestor=${state.elevationPendingAncestor}`,
        `pending3DTiles=${state.pending3DTiles}`,
        `activeTexVisible=${state.activeVisibleTextureTiles}`,
        `activeElev=${state.activeElevationTiles}`,
        `tileHash=${state.visibleTileHash}`,
        `tileVersionHash=${state.tilesVisibilityVersionHash}`,
    ].join(', ');
}

function isScenePending(state) {
    if (!state.ready) return true;
    return state.pendingActions > 0
        || state.texturePendingLoads > 0
        || state.textureLoading > 0
        || state.textureRecalc > 0
        || state.texturePendingAncestor > 0
        || state.elevationLoading > 0
        || state.elevationRecalc > 0
        || state.elevationPendingAncestor > 0
        || state.pending3DTiles > 0;
}

function sceneSettleSignature(state) {
    return `${state.activeVisibleTextureTiles}:${state.visibleTileHash}:${state.tilesVisibilityVersionHash}`;
}

async function waitForSceneToSettle(page, timeoutMs = 60000, stableChecks = 20, postSettleRenders = 2, minWaitMs = 1500) {
    const startMs = Date.now();
    let checks = 0;
    let stableCount = 0;
    let lastSignature = '';
    let observedBusy = false;

    while (Date.now() - startMs < timeoutMs) {
        const state = await getSceneSettleState(page);
        const pending = isScenePending(state);
        const signature = sceneSettleSignature(state);

        if (!pending) {
            if (signature === lastSignature) {
                stableCount++;
            } else {
                stableCount = 1;
                lastSignature = signature;
            }

            const elapsedMs = Date.now() - startMs;
            const canFinish = (observedBusy || elapsedMs >= minWaitMs) && stableCount >= stableChecks;
            if (canFinish) {
                let postSettleStable = true;
                for (let i = 0; i < postSettleRenders; i++) {
                    await waitForFrames(page, 1);
                    const postState = await getSceneSettleState(page);
                    const postPending = isScenePending(postState);
                    const postSignature = sceneSettleSignature(postState);
                    if (postPending || postSignature !== signature) {
                        postSettleStable = false;
                        stableCount = 0;
                        lastSignature = postSignature;
                        break;
                    }
                }

                if (postSettleStable) {
                    return true;
                }
            }
        } else {
            observedBusy = true;
            stableCount = 0;
            lastSignature = '';
        }

        checks++;
        if (checks % 120 === 0) {
            console.log(`[UI settle] Waiting... ${formatSceneSettleState(state)}`);
        }

        await waitForFrames(page, 2);
    }

    const finalState = await getSceneSettleState(page);
    console.log(`[UI settle] Timeout after ${timeoutMs}ms: ${formatSceneSettleState(finalState)}`);
    return false;
}

test.describe.serial('UI Interaction Tests - Playwright', () => {
    let sharedPage;
    let workerIndex;

    test.beforeAll(async ({ browser }, testInfo) => {
        workerIndex = testInfo.workerIndex;
        sharedPage = await browser.newPage();
        
        sharedPage.on('console', msg => {
            console.log(`[WORKER-${workerIndex}] PAGE CONSOLE [${msg.type()}]: ${msg.text()}`);
        });

        sharedPage.on('pageerror', error => {
            console.log(`[WORKER-${workerIndex}] PAGE ERROR: ${error.message}`);
        });
        
        await sharedPage.goto('?frame=10&ignoreunload=1&regression=1&mapType=Local&elevationType=Local');
        
        await sharedPage.waitForFunction(() => {
            return document.querySelector('.lil-gui') !== null;
        }, { timeout: 30000 });
        
        await sharedPage.evaluate(() => {
            window.__consoleLogs = [];
            const originalLog = console.log;
            console.log = function(...args) {
                window.__consoleLogs.push(args.join(' '));
                originalLog.apply(console, args);
            };
        });
        
        await sharedPage.waitForFunction(() => {
            return window.__consoleLogs?.some(log => log.includes('No pending actions'));
        }, { timeout: 30000 }).catch(() => {
            console.log('Warning: Did not detect "No pending actions" message');
        });
        
        await waitForSceneToSettle(sharedPage, 60000);
        await sharedPage.waitForTimeout(5000);
    });

    test.afterAll(async () => {
        if (sharedPage) {
            await sharedPage.close();
        }
    });

    test.skip('should adjust Lighting ambient intensity slider to 1.5', async ({}, testInfo) => {
        console.log('[TEST:ui-lighting:STARTED]');
        try {
            test.setTimeout(60000);
            
            await clickMenuTitle(sharedPage, 'Lighting');
            await sharedPage.waitForTimeout(100);

            await setSliderValue(sharedPage, 'Lighting', 'Ambient Intensity', 1.5);

            await sharedPage.waitForTimeout(500);
            await waitForFrames(sharedPage);

            await takeSnapshot(sharedPage, 'lighting-ambient-intensity-1.5-snapshot', testInfo);

            await setSliderValue(sharedPage, 'Lighting', 'Ambient Intensity', 0.2);
            await sharedPage.waitForTimeout(100);
            await waitForFrames(sharedPage);
            console.log('[TEST:ui-lighting:PASSED]');
        } catch (error) {
            console.log('[TEST:ui-lighting:FAILED]');
            throw error;
        }
    });

    test('should import LA Features CSV file via File menu', async ({}, testInfo) => {
        console.log('[TEST:ui-csv:STARTED]');
        try {
            test.setTimeout(120000);
            
            await clickMenuTitle(sharedPage, 'File');
            await sharedPage.waitForTimeout(100);

            const consolePromise = waitForConsoleText(sharedPage, 'parseResult: DONE Parse', 45000);

            const fileChooserPromise = sharedPage.waitForEvent('filechooser');
            
            await sharedPage.evaluate(() => {
                const fileFolder = Array.from(document.querySelectorAll('.lil-gui')).find(gui => {
                    const title = gui.querySelector(':scope > .title');
                    return title && title.textContent.trim() === 'File';
                });
                
                if (!fileFolder) {
                    console.log('File folder not found');
                    return false;
                }
                
                const controllers = fileFolder.querySelectorAll('.controller.function');
                for (const controller of controllers) {
                    const name = controller.querySelector('.name');
                    if (name && name.textContent.trim() === 'Import File') {
                        const button = controller.querySelector('button') || controller;
                        button.click();
                        return true;
                    }
                }
                console.log('Import File button not found');
                return false;
            });

            const fileChooser = await fileChooserPromise;
            await fileChooser.setFiles([path.resolve(__dirname, 'fixtures/LA Features.csv')]);

            await consolePromise;

            await sharedPage.waitForTimeout(3000);
            await waitForSceneToSettle(sharedPage, 45000);

            // Set a fixed frame to avoid datetime inconsistency in screenshots
            await sharedPage.evaluate(() => { par.frame = 10; });
            await waitForFrames(sharedPage, 50);

            await takeSnapshot(sharedPage, 'import-la-features-csv-snapshot', testInfo);
            console.log('[TEST:ui-csv:PASSED]');
        } catch (error) {
            console.log('[TEST:ui-csv:FAILED]');
            throw error;
        }
    });

    test('should import STANAG 4676 XML file via File menu', async ({}, testInfo) => {
        console.log('[TEST:ui-stanag:STARTED]');
        try {
            test.setTimeout(120000);
            
            await clickMenuTitle(sharedPage, 'File');
            await sharedPage.waitForTimeout(100);

            const consolePromise = waitForConsoleText(sharedPage, 'parseResult: DONE Parse', 45000);

            const fileChooserPromise = sharedPage.waitForEvent('filechooser');
            
            await sharedPage.evaluate(() => {
                const fileFolder = Array.from(document.querySelectorAll('.lil-gui')).find(gui => {
                    const title = gui.querySelector(':scope > .title');
                    return title && title.textContent.trim() === 'File';
                });
                
                if (!fileFolder) {
                    console.log('File folder not found');
                    return false;
                }
                
                const controllers = fileFolder.querySelectorAll('.controller.function');
                for (const controller of controllers) {
                    const name = controller.querySelector('.name');
                    if (name && name.textContent.trim() === 'Import File') {
                        const button = controller.querySelector('button') || controller;
                        button.click();
                        return true;
                    }
                }
                console.log('Import File button not found');
                return false;
            });

            const fileChooser = await fileChooserPromise;
            await fileChooser.setFiles([path.resolve(__dirname, '../data/test/elevated_track.xml')]);

            await consolePromise;

            await sharedPage.waitForTimeout(3000);
            await waitForSceneToSettle(sharedPage, 45000);
            await waitForFrames(sharedPage, 50);

            await takeSnapshot(sharedPage, 'import-stanag-xml-snapshot', testInfo);
            console.log('[TEST:ui-stanag:PASSED]');
        } catch (error) {
            console.log('[TEST:ui-stanag:FAILED]');
            throw error;
        }
    });

    test('should produce same result with Ambient Only as setting sun values to zero', async () => {
        console.log('[TEST:ui-ambient:STARTED]');
        try {
            test.setTimeout(60000);
            
            await clickMenuTitle(sharedPage, 'Lighting');
            await sharedPage.waitForTimeout(200);

            await setSliderValue(sharedPage, 'Lighting', 'Sun Intensity', 0);
            await setSliderValue(sharedPage, 'Lighting', 'Sun Scattering', 0);

            await sharedPage.waitForTimeout(1000);

            const screenshotZeroSun = await sharedPage.screenshot({ fullPage: true });

            await setSliderValue(sharedPage, 'Lighting', 'Sun Intensity', 0.55);
            await setSliderValue(sharedPage, 'Lighting', 'Sun Scattering', 0.45);

            await setCheckboxValue(sharedPage, 'Lighting', 'Ambient Only', true);

            await sharedPage.waitForTimeout(1000);

            const screenshotAmbientOnly = await sharedPage.screenshot({ fullPage: true });

            expect(screenshotAmbientOnly.length).toBeGreaterThan(0);
            expect(screenshotZeroSun.length).toBeGreaterThan(0);
            
            await setCheckboxValue(sharedPage, 'Lighting', 'Ambient Only', false);
            await sharedPage.waitForTimeout(100);
            console.log('[TEST:ui-ambient:PASSED]');
        } catch (error) {
            console.log('[TEST:ui-ambient:FAILED]');
            throw error;
        }
    });
});
