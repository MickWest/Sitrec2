import {setRenderOne} from "./Globals";

class CLoadingManagerClass {
    constructor() {
        this.loadingTasks = new Map();
        this.loadingDiv = null;
        this.title = "Loading";
    }

    registerLoading(taskId, name, category = "General") {
        const entry = {
            name: this.getShortName(name),
            fullName: name,
            category: category,
            progress: 0,
            startTime: Date.now(),
        };
        this.loadingTasks.set(taskId, entry);
        this.updateUI();
        return entry;
    }

    updateProgress(taskId, progress) {
        const entry = this.loadingTasks.get(taskId);
        if (entry) {
            entry.progress = Math.min(100, Math.max(0, progress));
            this.updateUI();
            setRenderOne(true);
        }
    }

    completeLoading(taskId) {
        this.loadingTasks.delete(taskId);
        this.updateUI();
        setRenderOne(true);
    }

    isLoading(taskId) {
        return this.loadingTasks.has(taskId);
    }

    getLoadingCount() {
        return this.loadingTasks.size;
    }

    getShortName(name) {
        if (!name) return "Unknown";
        let shortName = name;
        if (shortName.includes('/')) {
            shortName = shortName.split('/').pop();
        }
        if (shortName.length > 40) {
            shortName = shortName.substring(0, 37) + "...";
        }
        return shortName;
    }

    ensureUIExists() {
        if (this.loadingDiv) return;

        this.loadingDiv = document.createElement('div');
        this.loadingDiv.id = 'loadingIndicator';
        this.loadingDiv.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            background: rgba(26, 26, 46, 0.95);
            border: 1px solid #4a4a6a;
            border-radius: 8px;
            padding: 12px 16px;
            color: #f0f000;
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 13px;
            z-index: 10000;
            min-width: 200px;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            display: none;
        `;
        document.body.appendChild(this.loadingDiv);
    }

    updateUI() {
        this.ensureUIExists();

        if (this.loadingTasks.size === 0) {
            this.loadingDiv.style.display = 'none';
            return;
        }

        this.loadingDiv.style.display = 'block';

        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const categories = new Map();
        for (const [taskId, entry] of this.loadingTasks) {
            if (!categories.has(entry.category)) {
                categories.set(entry.category, []);
            }
            categories.get(entry.category).push({ taskId, entry });
        }

        let html = `<div style="font-weight: bold; margin-bottom: 8px; color: #fff;">
            ${this.title} (${this.loadingTasks.size})
        </div>`;

        for (const [category, tasks] of categories) {
            if (categories.size > 1) {
                html += `<div style="color: #aaa; font-size: 11px; margin-top: 6px; margin-bottom: 2px;">${esc(category)}</div>`;
            }

            for (const { taskId, entry } of tasks) {
                const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
                const progressPercent = Math.round(entry.progress);

                html += `<div style="margin: 6px 0; padding: 6px; background: rgba(74, 74, 106, 0.3); border-radius: 4px;">
                    <div style="color: #aaa; font-size: 11px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${esc(entry.name)}
                    </div>
                    <div style="background: #2a2a4a; border-radius: 3px; height: 6px; overflow: hidden;">
                        <div style="background: linear-gradient(90deg, #4a9eff, #00d4aa); width: ${progressPercent}%; height: 100%; transition: width 0.3s;"></div>
                    </div>
                    <div style="color: #666; font-size: 10px; margin-top: 2px;">
                        ${progressPercent > 0 ? progressPercent + '%' : 'Starting...'} ${elapsed > 0 ? '(' + elapsed + 's)' : ''}
                    </div>
                </div>`;
            }
        }

        this.loadingDiv.innerHTML = html;
    }

    createLoadingImage(width = 640, height = 480, text = "Loading...") {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, width, height);

        const centerX = width / 2;
        const centerY = height / 2;

        ctx.strokeStyle = '#4a4a6a';
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.arc(centerX, centerY - 30, 20 + i * 15, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.fillStyle = '#f0f000';
        ctx.font = 'bold 32px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, centerX, centerY + 40);

        ctx.fillStyle = '#888888';
        ctx.font = '16px sans-serif';
        ctx.fillText("Please wait...", centerX, centerY + 80);

        return canvas;
    }

    dispose() {
        if (this.loadingDiv && this.loadingDiv.parentNode) {
            this.loadingDiv.parentNode.removeChild(this.loadingDiv);
            this.loadingDiv = null;
        }
        this.loadingTasks.clear();
    }
}

export const LoadingManager = new CLoadingManagerClass();
