import {CNodeTabbedCanvasView} from "./CNodeTabbedCanvasView";

export class CNodeSkyPlotView extends CNodeTabbedCanvasView {
    constructor(v) {
        v.menuName = 'Sky Plot';
        super(v);

        this.nightSkyNode = v.nightSkyNode;
        this.lastUpdateTime = 0;
        this.updateInterval = 1000;
    }

    update(f) {
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateInterval) {
            return;
        }
        this.lastUpdateTime = now;
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        
        if (!this.visible) return;
        if (!this.nightSkyNode || !this.nightSkyNode.satellites || !this.nightSkyNode.satellites.TLEData) {
            return;
        }

        const ctx = this.ctx;
        // CSS units, not canvas.width: the base class scales the backing store AND the
        // context by devicePixelRatio, so drawing in backing pixels lands everything at
        // 2x on a high-DPI display - the plot's centre ends up at the bottom-right corner.
        const width = this.widthPx;
        const height = this.heightPx;
        
        // Clear canvas
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        
        // Calculate center and radius for polar plot
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) * 0.45;
        
        // Draw polar grid
        this.drawPolarGrid(ctx, centerX, centerY, radius);
        
        // Plot satellites
        this.plotSatellites(ctx, centerX, centerY, radius);
    }

    drawPolarGrid(ctx, centerX, centerY, radius) {
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        
        // Draw concentric circles for elevation (0°, 30°, 60°, 90°)
        // Center = zenith (90°), outer = horizon (0°)
        const elevations = [0, 30, 60, 90]; // degrees from horizon
        
        for (const el of elevations) {
            const r = radius * (1 - el / 90);
            ctx.beginPath();
            ctx.arc(centerX, centerY, r, 0, 2 * Math.PI);
            ctx.stroke();
            
            // Label elevation (skip 0° to avoid clutter)
            if (el > 0) {
                ctx.fillStyle = '#00ff00';
                ctx.font = '14px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${el}°`, centerX, centerY - r - 5);
            }
        }
        
        // Draw radial lines for azimuth (every 45°)
        const azimuths = [0, 45, 90, 135, 180, 225, 270, 315];
        const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        
        for (let i = 0; i < azimuths.length; i++) {
            const az = azimuths[i];
            const angleRad = (az - 90) * Math.PI / 180; // Rotate so N is up
            
            const x1 = centerX;
            const y1 = centerY;
            const x2 = centerX + radius * Math.cos(angleRad);
            const y2 = centerY + radius * Math.sin(angleRad);
            
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            
            // Label azimuth outside the circle
            const labelDist = radius + 20;
            const labelX = centerX + labelDist * Math.cos(angleRad);
            const labelY = centerY + labelDist * Math.sin(angleRad);
            
            ctx.fillStyle = '#00ff00';
            ctx.font = '14px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labels[i], labelX, labelY);
        }
    }

    plotSatellites(ctx, centerX, centerY, radius) {
        // Get the filtered satellite list from the ephemeris view. That view only refreshes
        // itself while VISIBLE, so ask it to refresh on its own throttle - otherwise this plot
        // is empty (or frozen) unless the ephemeris table happens to be open.
        const ephemerisView = this.nightSkyNode.ephemerisView;
        if (!ephemerisView) {
            return;
        }
        ephemerisView.ensureSatData();
        if (!ephemerisView.filteredSatData) {
            return;
        }

        const filteredSatData = ephemerisView.filteredSatData;

        for (const sat of filteredSatData) {
            const az = sat.az;
            const el = sat.el;
            
            // Convert az/el to polar coordinates
            // Elevation: 0° = radius, 90° = center
            const r = radius * (1 - el / 90);
            
            // Azimuth: 0° = North (up), measured clockwise
            // Rotate by -90° so North is at top
            const angleRad = (az - 90) * Math.PI / 180;
            
            const x = centerX + r * Math.cos(angleRad);
            const y = centerY + r * Math.sin(angleRad);
            
            // Draw satellite as green circle (8px diameter = 4px radius)
            ctx.fillStyle = '#00ff00';
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, 2 * Math.PI);
            ctx.fill();
            
            // Draw satellite name in white
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(sat.name, x + 6, y);
        }
    }
}
