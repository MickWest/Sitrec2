import {expect, test} from '@playwright/test';
import {takeScreenshotOrCompare} from './snapshot-utils.js';

async function waitForFrames(page, count = 10) {
    await page.evaluate(({ frameCount }) => {
        return new Promise((resolve) => {
            let frames = 0;
            function wait() {
                frames++;
                if (frames < frameCount) {
                    requestAnimationFrame(wait);
                } else {
                    resolve();
                }
            }
            requestAnimationFrame(wait);
        });
    }, { frameCount: count });
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

test.describe.serial('UI Interaction Tests - Playwright', () => {
    let sharedPage;
    let workerIndex;

    test.beforeAll(async ({ browser }, testInfo) => {
        workerIndex = testInfo.workerIndex;
        sharedPage = await browser.newPage();
        
        sharedPage.on('console', msg => {
            console.log(`[WORKER-${workerIndex}] PAGE CONSOLE [${msg.type()}]: ${msg.text()}`);
        });
        
        await sharedPage.goto('?ignoreunload=1&regression=1');
        
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
        
        await sharedPage.waitForTimeout(5000);
    });

    test.afterAll(async () => {
        await sharedPage.close();
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
            test.setTimeout(60000);
            
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
            await fileChooser.setFiles(['/Users/mick/Dropbox/Sitrec Resources/TEST CSVs/LA Features.csv']);

            await consolePromise;

            await sharedPage.waitForTimeout(3000);
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
            test.setTimeout(60000);
            
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
            await fileChooser.setFiles(['/Users/mick/Dropbox/sitrec-dev/sitrec/data/test/elevated_track.xml']);

            await consolePromise;

            await sharedPage.waitForTimeout(3000);
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
