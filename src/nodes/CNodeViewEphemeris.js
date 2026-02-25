import {CNodeViewText} from "./CNodeViewText.js";
import {altitudeAboveSphere, getAzElFromPositionAndForward} from "../SphericalMath";
import {NodeMan} from "../Globals";
import {Raycaster, Sphere, Vector3} from "three";
import {intersectSphere2} from "../threeUtils";
import {wgs84} from "../LLA-ECEF-ENU";
import {bestSat} from "../TLEUtils";

export class CNodeViewEphemeris extends CNodeViewText {
    constructor(v) {
        v.title = 'Satellite Ephemeris';
        v.idPrefix = 'ephemeris-view';
        v.hideOnFileDrop = false;
        v.maxMessages = 0;
        v.manualScroll = true;

        super(v);

        this.lastUpdateTime = 0;
        this.updateInterval = 1000;

        this.nightSkyNode = v.nightSkyNode;
    }

    getOutputAreaHeight() {
        return 'calc(100% - 40px)';
    }

    addTabButtons() {
        // Add "Only Visible" checkbox to filter satellites
        const checkboxContainer = document.createElement('label');
        checkboxContainer.style.cssText = `
            position: absolute;
            top: 30px;
            right: 18px;
            font-size: 12px;
            cursor: pointer;
            user-select: none;
            color: var(--cnodeview-tab-color);
        `;
        
        this.onlyVisibleCheckbox = document.createElement('input');
        this.onlyVisibleCheckbox.type = 'checkbox';
        this.onlyVisibleCheckbox.checked = true; // Checked by default
        this.onlyVisibleCheckbox.style.marginRight = '4px';
        this.onlyVisibleCheckbox.style.cursor = 'pointer';
        
        const checkboxLabel = document.createElement('span');
        checkboxLabel.textContent = 'Only VIS';
        
        checkboxContainer.appendChild(this.onlyVisibleCheckbox);
        checkboxContainer.appendChild(checkboxLabel);
        this.div.appendChild(checkboxContainer);
    }

    update(f) {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateInterval) {
            return;
        }
        this.lastUpdateTime = now;

        if (!this.visible) {
            return;
        }

        this.updateEphemeris();
    }

    namePad = 20;
    azPad = 5;
    elPad = 5;
    rangePad = 6;
    altPad = 7;
    visPad = 6;
    nextEventPad = 14;

    totalPad = this.namePad + this.azPad + this.elPad + this.rangePad + this.altPad + this.visPad + this.nextEventPad;

    // Calculate visibility state based on sun position and satellite illumination
    // VISIBLE: Satellite is lit by sun and observer is in darkness (sun elevation < -6°)
    // DAYLIGHT: Satellite is lit but observer has daylight (sun elevation >= -6°)
    // ECLIPSED: Satellite is in Earth's shadow
    // HOR: Satellite is below horizon (elevation < 0)
    calculateVisibilityState(satPos, cameraPos, date, el, toSun) {
        if (el < 0) {
            return 'HOR';
        }

        // Create Earth globe for shadow calculations (same as in CNodeDisplayNightSky)
        const globe = new Sphere(new Vector3(0, 0, 0), wgs84.POLAR_RADIUS);
        
        // Check if satellite is in Earth's shadow by casting ray from satellite to sun
        const raycaster = new Raycaster();
        raycaster.set(satPos, toSun);
        
        const hitPoint = new Vector3();
        const hitPoint2 = new Vector3();
        
        // If ray from satellite to sun intersects Earth, satellite is in shadow
        const inShadow = intersectSphere2(raycaster.ray, globe, hitPoint, hitPoint2);
        
        if (inShadow) {
            return 'ECL'; // Eclipsed - in Earth's shadow
        }
        
        // Calculate sun elevation at observer position
        const earthCenter = new Vector3(0, 0, 0);
        const observerFromCenter = cameraPos.clone().sub(earthCenter).normalize();
        const sunDir = toSun.clone().normalize();
        
        // Angle between observer position vector and sun direction vector
        const angle = Math.acos(Math.max(-1, Math.min(1, observerFromCenter.dot(sunDir))));
        
        // Sun elevation = 90° - angle
        // When angle is 0° (observer and sun in same direction), elevation is 90° (sun overhead)
        // When angle is 90° (perpendicular), elevation is 0° (sun at horizon)
        // When angle is 180° (opposite), elevation is -90° (sun below)
        const sunElevationAngle = Math.PI / 2 - angle;
        
        // Civil twilight threshold: sun elevation < -6° (-6° * π/180 = -0.1047 radians)
        if (sunElevationAngle < -0.1047) {
            return 'VIS'; // Visible - satellite lit and observer in darkness
        }
        
        return 'DAY'; // Daylight - satellite lit but too bright outside
    }

    // Predict next event (rise/set) for a satellite
    // Returns string like "AOS 5m 23s" (Acquisition of Signal) or "LOS 3m 45s" (Loss of Signal)
    // Based on C++ pass predictor which uses 2-minute steps and looks for horizon crossings
    predictNextEvent(sat, currentDate, currentEl, lookCamera) {
        // Cache predictions to avoid recalculating every frame
        const now = Date.now();
        if (sat.lastPredictionTime && (now - sat.lastPredictionTime) < 10000) {
            return sat.cachedNextEvent || '---';
        }
        
        const satellites = this.nightSkyNode.satellites;
        
        // Get the appropriate satrec for this satellite and date
        const satrec = bestSat(sat.satrecs, currentDate);
        if (!satrec) {
            sat.cachedNextEvent = '---';
            sat.lastPredictionTime = now;
            return '---';
        }
        
        // Search forward in time to find next horizon crossing
        // C++ code uses 2-minute steps and searches up to 120 minutes by default
        const searchMinutes = 120; // Look ahead 2 hours
        const stepSeconds = 30; // Use 30-second steps for better accuracy
        
        let searchTime = new Date(currentDate.getTime());
        let prevEl = currentEl;
        const cameraPos = lookCamera.camera.position;
        
        // Sample at current time first to get accurate starting elevation
        const currentSatrec = bestSat(sat.satrecs, currentDate);
        if (currentSatrec) {
            const currentSatEus = satellites.calcSatEUS(currentSatrec, currentDate);
            if (currentSatEus) {
                const currentToSat = currentSatEus.clone().sub(cameraPos);
                const currentForward = currentToSat.clone().normalize();
                const [currentAz, currentElev] = getAzElFromPositionAndForward(cameraPos, currentForward);
                prevEl = currentElev;
            }
        }
        
        for (let i = 1; i <= (searchMinutes * 60 / stepSeconds); i++) {
            searchTime = new Date(currentDate.getTime() + i * stepSeconds * 1000);
            
            // Get satrec for the search time (in case satellite has multiple TLEs)
            const searchSatrec = bestSat(sat.satrecs, searchTime);
            if (!searchSatrec) continue;
            
            const satEus = satellites.calcSatEUS(searchSatrec, searchTime);
            if (!satEus) continue;
            
            const toSat = satEus.clone().sub(cameraPos);
            const forward = toSat.clone().normalize();
            
            const [az, el] = getAzElFromPositionAndForward(cameraPos, forward);
            
            // Check for horizon crossing (elevation crossing 0°)
            // We check if the sign changed between prevEl and current el
            // For satellites currently above horizon (prevEl > 0), we're looking for LOS (el < 0)
            // For satellites currently below horizon (prevEl < 0), we're looking for AOS (el > 0)
            if ((prevEl < 0 && el >= 0) || (prevEl >= 0 && el < 0)) {
                const isRising = el > prevEl;
                const diffMs = searchTime.getTime() - currentDate.getTime();
                const diffSec = Math.floor(diffMs / 1000);
                const minutes = Math.floor(diffSec / 60);
                const seconds = diffSec % 60;
                
                const result = `${isRising ? 'AOS' : 'LOS'} ${minutes}m ${seconds}s`;
                
                // Cache the result
                sat.cachedNextEvent = result;
                sat.lastPredictionTime = now;
                
                return result;
            }
            
            prevEl = el;
        }
        
        // No horizon crossing found in search window
        // For debug: show ">2h" to indicate satellite stays visible longer than search window
        // In production C++ code, this would show the actual time or keep searching
        const result = prevEl > 0 ? '>2h' : '---';
        sat.cachedNextEvent = result;
        sat.lastPredictionTime = now;
        return result;
    }

    updateEphemeris() {
        if (!this.nightSkyNode || !this.nightSkyNode.satellites || !this.nightSkyNode.satellites.TLEData) {
            return;
        }

        const satellites = this.nightSkyNode.satellites;
        const tleData = satellites.TLEData;
        const lookCamera = NodeMan.get("lookCamera", false);
        
        if (!lookCamera) {
            return;
        }

        const cameraPos = lookCamera.camera.position;
        const currentDate = new Date();
        const satData = [];
        
        // Get sun direction vector from satellites (same as used in main rendering)
        const toSun = satellites.toSun;

        for (let i = 0; i < tleData.satData.length; i++) {
            const sat = tleData.satData[i];
            
            if (!sat.visible || !sat.eus) {
                continue;
            }

            const satPos = sat.eus;
            const toSat = satPos.clone().sub(cameraPos);
            const range = toSat.length();
            const forward = toSat.clone().normalize();

            const [az, el] = getAzElFromPositionAndForward(cameraPos, forward);
            
            // Skip satellites below horizon for display
            // But note: in C++ code, predictions happen for all satellites
            // that pass the initial filter, not just above horizon
            if (el < 0) {
                continue;
            }

            const altitude = altitudeAboveSphere(satPos);
            
            // Calculate visibility state
            const visState = this.calculateVisibilityState(satPos, cameraPos, currentDate, el, toSun);
            
            // Predict next event - pass the current elevation we just calculated
            // This should predict when the satellite will SET (LOS) since it's currently above horizon
            const nextEvent = this.predictNextEvent(sat, currentDate, el, lookCamera);

            satData.push({
                name: sat.name || `SAT ${sat.number}`,
                az: az,
                el: el,
                range: range / 1000,
                altitude: altitude / 1000,
                visState: visState,
                nextEvent: nextEvent,
                satObject: sat
            });
        }

        satData.sort((a, b) => b.el - a.el);

        // Filter based on "Only Visible" checkbox
        let filteredData = satData;
        if (this.onlyVisibleCheckbox && this.onlyVisibleCheckbox.checked) {
            filteredData = satData.filter(sat => sat.visState === 'VIS');
        }

        const top100 = filteredData.slice(0, 100);
        
        // Store filtered data for use by other views (e.g., Sky Plot)
        this.filteredSatData = top100;

        this.clearOutput();

        const header = this.formatRow("Name", "Az", "El", "Range", "Alt", "Vis", "Next Event");
        const separator = "─".repeat(this.totalPad);

        this.addMessage(header, '#00ff00');
        this.addMessage(separator, '#00ff00');

        for (const sat of top100) {
            const row = this.formatRow(
                sat.name.substring(0, this.namePad-1).trim(),
                sat.az.toFixed(1),
                sat.el.toFixed(1),
                sat.range.toFixed(0),
                sat.altitude.toFixed(0),
                sat.visState,
                sat.nextEvent
            );
            this.addMessage(row);
        }
    }

    formatRow(name, az, el, range, alt, vis, nextEvent) {
        const nameStr = String(name).padEnd(this.namePad, '\u00A0');
        const azStr = String(az).padStart(this.azPad, '\u00A0');
        const elStr = String(el).padStart(this.elPad, '\u00A0');
        const rangeStr = String(range).padStart(this.rangePad, '\u00A0');
        const altStr = String(alt).padStart(this.altPad, '\u00A0');
        const visStr = String(vis || '---').padStart(this.visPad, '\u00A0');
        const nextEventStr = String(nextEvent || '---').padStart(this.nextEventPad, '\u00A0');

        return `${nameStr}${azStr}${elStr}${rangeStr}${altStr}${visStr}${nextEventStr}`;
    }
}
