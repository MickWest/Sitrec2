import {expect, test} from '@playwright/test';

test.use({
    headless: false,
    launchOptions: {
        args: [
            '--ignore-gpu-blocklist',
            '--enable-webgl',
        ],
    },
});

function waitForSitrecReady(page, timeout = 60000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            page.off('console', handler);
            reject(new Error('Timeout waiting for No pending actions'));
        }, timeout);
        const handler = (msg) => {
            if (msg.text().includes('No pending actions')) {
                clearTimeout(timer);
                page.off('console', handler);
                resolve();
            }
        };
        page.on('console', handler);
    });
}

test.describe('Video Cache Gap Tests', () => {

    test('echo cache stability when paused', async ({ page }) => {
        test.setTimeout(120000);

        await page.setViewportSize({ width: 1920, height: 1080 });

        const browserLogs = [];
        page.on('console', msg => {
            const text = msg.text();
            browserLogs.push(text);
            if (text.includes('[PURGE]') || text.includes('[CACHE]') || text.includes('rror')) {
                console.log('BROWSER: ' + text);
            }
        });

        page.on('pageerror', err => console.log(`PAGE ERROR: ${err}`));

        const url = '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Small%20video%20cache%20issues%20ECHO%2072/20260215_112049.js&ignoreunload=1&regression=1';
        const ready = waitForSitrecReady(page);
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        await ready;
        console.log('Sitch loaded');

        const videoInfo = await page.evaluate(() => {
            const videoNode = window.NodeMan?.get('video', false);
            if (!videoNode || !videoNode.videoData) return null;
            const vd = videoNode.videoData;
            if (vd.decoder?.state === 'closed') return { closed: true };
            return {
                type: vd.constructor.name,
                chunks: vd.chunks?.length || 0,
                groups: vd.groups?.length || 0,
                decoderState: vd.decoder?.state,
                echoFramesNeeded: vd.echoFramesNeeded || 0,
            };
        });

        if (!videoInfo || videoInfo.closed) {
            console.log('SKIP: decoder closed or unavailable');
            test.skip();
            return;
        }

        console.log(`Video: ${videoInfo.type}, ${videoInfo.chunks} frames, ${videoInfo.groups} groups, echo=${videoInfo.echoFramesNeeded}`);

        await page.evaluate(() => {
            window.par.paused = true;
        });

        const targetFrame = Math.min(150, videoInfo.chunks - 1);
        await page.evaluate((f) => {
            window.par.frame = f;
        }, targetFrame);

        console.log(`Set frame to ${targetFrame}, paused`);

        await page.evaluate((f) => {
            const vd = window.NodeMan.get('video').videoData;
            vd.getImage(f);
        }, targetFrame);

        await page.waitForTimeout(3000);

        await page.evaluate(() => {
            const vd = window.NodeMan.get('video').videoData;
            window.__purgeLog = [];
            const origPurge = vd.purgeGroupsExcept.bind(vd);
            vd.purgeGroupsExcept = function(keep) {
                const before = vd.groups.map((g, i) => ({
                    idx: i, loaded: g.loaded, pending: g.pending
                }));
                origPurge(keep);
                const after = vd.groups.map((g, i) => ({
                    idx: i, loaded: g.loaded, pending: g.pending
                }));
                const purged = [];
                for (let i = 0; i < before.length; i++) {
                    if (before[i].loaded && !after[i].loaded) {
                        purged.push(i);
                    }
                }
                if (purged.length > 0) {
                    window.__purgeLog.push({
                        time: performance.now(),
                        purgedGroups: purged,
                        keepSize: keep instanceof Set ? keep.size : (Array.isArray(keep) ? keep.length : 0),
                    });
                    console.log(`[PURGE] Purged groups: ${purged.join(',')} keepSize=${keep instanceof Set ? keep.size : (Array.isArray(keep) ? keep.length : 0)}`);
                }
            };
        });

        for (let i = 0; i < 5; i++) {
            await page.evaluate((f) => {
                const vd = window.NodeMan.get('video').videoData;
                vd.getImage(f);
            }, targetFrame);
            await page.waitForTimeout(1000);
        }

        const result = await page.evaluate(() => {
            const vd = window.NodeMan.get('video').videoData;
            const groupStatus = vd.groups.map((g, i) => ({
                idx: i,
                frame: g.frame,
                length: g.length,
                loaded: g.loaded,
                pending: g.pending,
            }));
            return {
                purgeCount: window.__purgeLog.length,
                purgeLog: window.__purgeLog.slice(0, 20),
                groupStatus,
            };
        });

        console.log(`Purge events while paused: ${result.purgeCount}`);
        for (const p of result.purgeLog) {
            console.log(`  t=${p.time.toFixed(0)} purged=[${p.purgedGroups.join(',')}] keepSize=${p.keepSize}`);
        }
        console.log('Group status:');
        for (const g of result.groupStatus) {
            const status = g.loaded ? 'LOADED' : (g.pending > 0 ? `PENDING(${g.pending})` : 'empty');
            console.log(`  Group ${g.idx}: frame=${g.frame} len=${g.length} ${status}`);
        }

        expect(result.purgeCount).toBe(0);
    });

    test('diagnose dropped frames', async ({ page }) => {
        test.setTimeout(180000);

        await page.setViewportSize({ width: 1920, height: 1080 });

        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[DIAG') || text.includes('[DECODE]') || text.includes('rror')) {
                console.log('BROWSER: ' + text);
            }
        });

        page.on('pageerror', err => console.log(`PAGE ERROR: ${err}`));

        const url = '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Video%20Echo%20Test/&ignoreunload=1&regression=1';
        const ready = waitForSitrecReady(page);
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        await ready;
        console.log('Video loaded');

        const videoInfo = await page.evaluate(() => {
            const videoNode = window.NodeMan?.get('video', false);
            if (!videoNode || !videoNode.videoData) return null;
            const vd = videoNode.videoData;
            if (vd.decoder?.state === 'closed') return { closed: true };
            return {
                type: vd.constructor.name,
                chunks: vd.chunks?.length || 0,
                groups: vd.groups?.length || 0,
                decoderState: vd.decoder?.state,
            };
        });

        if (!videoInfo || videoInfo.closed) {
            console.log('SKIP: decoder closed or unavailable');
            test.skip();
            return;
        }

        console.log(`Video: ${videoInfo.type}, ${videoInfo.chunks} frames, ${videoInfo.groups} groups`);

        await page.evaluate(() => {
            const vd = window.NodeMan.get('video').videoData;
            window.__outputTimestamps = {};
            window.__outputOrder = {};

            const origProcess = vd.processDecodedFrame.bind(vd);
            vd.processDecodedFrame = function(frameNumber, videoFrame, group) {
                const groupIdx = vd.groups.indexOf(group);
                if (!window.__outputTimestamps[groupIdx]) {
                    window.__outputTimestamps[groupIdx] = [];
                    window.__outputOrder[groupIdx] = [];
                }
                window.__outputTimestamps[groupIdx].push(videoFrame.timestamp);
                window.__outputOrder[groupIdx].push(frameNumber);
                origProcess(frameNumber, videoFrame, group);
            };
        });

        const groupCount = await page.evaluate(() => window.NodeMan.get('video').videoData.groups.length);
        for (let g = 0; g < groupCount; g++) {
            await page.evaluate((gi) => {
                const vd = window.NodeMan.get('video').videoData;
                const group = vd.groups[gi];
                group.loaded = false;
                group.pending = 0;
                group.decodePending = 0;
                vd.flushing = false;
                vd.groupsPending = 0;
                vd.requestGroup(group);
            }, g);

            await page.waitForFunction((gi) => {
                const vd = window.NodeMan.get('video').videoData;
                return !vd.flushing;
            }, g, { timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(500);
        }

        const outputAnalysis = await page.evaluate(() => {
            const vd = window.NodeMan.get('video').videoData;
            const result = {};
            for (const [gi, timestamps] of Object.entries(window.__outputTimestamps)) {
                const group = vd.groups[parseInt(gi)];
                const chunkTimestamps = [];
                for (let i = group.frame; i < group.frame + group.length; i++) {
                    chunkTimestamps.push(vd.chunks[i].timestamp);
                }

                const outputSet = new Set(timestamps);
                const missingFromOutput = chunkTimestamps.filter(ts => !outputSet.has(ts));
                const extraInOutput = timestamps.filter(ts => !new Set(chunkTimestamps).has(ts));

                result[gi] = {
                    groupIdx: parseInt(gi),
                    frame: group.frame,
                    length: group.length,
                    chunksCount: chunkTimestamps.length,
                    outputCount: timestamps.length,
                    missingTimestamps: missingFromOutput,
                    extraTimestamps: extraInOutput,
                    pending: group.pending,
                    loaded: group.loaded,
                    decodePending: group.decodePending,
                };
            }
            return result;
        });

        const decodedGroups = Object.keys(outputAnalysis).length;
        console.log(`Decoded ${decodedGroups}/${groupCount} groups`);

        let totalMissing = 0;
        for (const [gi, data] of Object.entries(outputAnalysis)) {
            const status = data.loaded ? 'LOADED' : (data.pending > 0 ? 'PENDING' : 'IDLE');
            console.log(`Group ${gi}: chunks=${data.chunksCount} output=${data.outputCount} ${status} pending=${data.pending} decodePending=${data.decodePending}`);
            if (data.missingTimestamps.length > 0) {
                console.log(`  MISSING: ${JSON.stringify(data.missingTimestamps)}`);
                totalMissing += data.missingTimestamps.length;
            }
            if (data.extraTimestamps.length > 0) {
                console.log(`  EXTRA: ${JSON.stringify(data.extraTimestamps)}`);
            }
        }

        if (decodedGroups === 0) {
            console.log('No groups decoded - verifying openGopExtra is computed');
            const openGopInfo = await page.evaluate(() => {
                const vd = window.NodeMan.get('video').videoData;
                return vd.groups.map((g, i) => ({
                    idx: i,
                    frame: g.frame,
                    length: g.length,
                    openGopExtra: g.openGopExtra,
                    hasTimestampMap: vd.timestampToChunkIndex instanceof Map,
                    mapSize: vd.timestampToChunkIndex?.size || 0,
                }));
            });
            for (const g of openGopInfo) {
                console.log(`Group ${g.idx}: frame=${g.frame} len=${g.length} openGopExtra=${g.openGopExtra}`);
            }
            expect(openGopInfo[0].hasTimestampMap).toBe(true);
            expect(openGopInfo[0].mapSize).toBe(videoInfo.chunks);
            const totalOpenGop = openGopInfo.reduce((sum, g) => sum + g.openGopExtra, 0);
            console.log(`Total openGopExtra across all groups: ${totalOpenGop}`);
            expect(totalOpenGop).toBeGreaterThan(0);
        } else {
            const firstDecodedGroup = Math.min(...Object.keys(outputAnalysis).map(Number));
            let expectedMissing = 0;
            if (firstDecodedGroup > 0) {
                const prevGroup = await page.evaluate((gi) => {
                    const vd = window.NodeMan.get('video').videoData;
                    return vd.groups[gi]?.openGopExtra || 0;
                }, firstDecodedGroup - 1);
                expectedMissing = prevGroup;
            }
            console.log(`totalMissing=${totalMissing}, expectedMissing=${expectedMissing}`);
            expect(totalMissing).toBe(expectedMissing);
        }
    });
});
