import {wheelZoomFactor} from "../GestureActions";
import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {guiMenus, NodeMan} from "../Globals";
import {t} from "../i18n";

export class CNodeViewDAG extends CNodeViewCanvas2D {
    constructor(v) {
        v.autoClear = true;
        v.autoFill = true;
        v.autoFillColor = v.autoFillColor ?? "#1a1a2e";
        v.draggable = v.draggable ?? true;
        v.resizable = v.resizable ?? true;
        // Drag + pop-out like the Notes view (CNodeNotes). poppable adds the ⧉ icon and wires
        // togglePopout()/popOut()/dockWindow() in the base class; dockable allows sidebar docking.
        v.poppable = v.poppable ?? true;
        v.dockable = v.dockable ?? true;
        // The DAG is a live per-frame 2D canvas, not static DOM, so unlike Notes it must keep
        // rendering while popped out (see indexRender.js render gate + adjustSize windowed branch).
        v.renderWhileWindowed = v.renderWhileWindowed ?? true;
        v.freeAspect = true;
        super(v);

        this.panX = 0;
        this.panY = 0;
        this.zoom = 1;
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.nodeWidth = 180;
        this.nodeBaseHeight = 40;
        this.inputLineHeight = 12;
        this.horizontalSpacing = 250;
        this.verticalSpacing = 20;

        this.nodePositions = {};
        this.layoutDirty = true;

        this.hiddenNodes = new Set();
        this.savedState = null;
        this.inactiveBranchColor = "#5a1f1f";
        this.inactiveBranchStrokeColor = "#7a2b2b";

        this.setupMouseHandlers();

        guiMenus.help.add(this, "recalculateLayout").name(t("misc.recalcNodeGraph.label"));
    }

    setupMouseHandlers() {
        this.unregisterInteraction = registerSurfaceInteraction(this.canvas, {
            model: this, view: this, profile: "graph", navigation: true, buttons: [0, 2],
            begin: e => { if (e.button === 0) this.onPointerDown(e); },
            move: e => this.onPointerMove(e), end: e => this.onPointerUp(e),
            wheel: e => this.onWheel(e), contextMenu: e => this.onPointerDown({button: 2, clientX: e.clientX, clientY: e.clientY}),
            snapshot: () => ({panX: this.panX, panY: this.panY, zoom: this.zoom}),
            restore: state => Object.assign(this, state),
        });
    }

    onWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const worldXBefore = (mouseX - this.panX) / this.zoom;
        const worldYBefore = (mouseY - this.panY) / this.zoom;

        const zoomFactor = wheelZoomFactor(e, "graph");
        if (zoomFactor === 1) return;
        this.zoom *= zoomFactor;
        this.zoom = Math.max(0.1, Math.min(5, this.zoom));

        this.panX = mouseX - worldXBefore * this.zoom;
        this.panY = mouseY - worldYBefore * this.zoom;
    }

    onPointerDown(e) {
        if (e.button === 0) {
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
        } else if (e.button === 2) {
            const nodeId = this.getNodeAtPosition(e.clientX, e.clientY);
            if (nodeId) {
                this.toggleUnconnectedNodes(nodeId);
            } else if (this.hiddenNodes.size > 0) {
                this.showAllNodes();
            }
        }
    }

    onPointerMove(e) {
        if (this.isDragging) {
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.panX += dx;
            this.panY += dy;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        }
    }

    onPointerUp(e) {
        if (this.isDragging) {
            this.isDragging = false;
            this.canvas.style.cursor = 'grab';
        }
    }

    getNodeAtPosition(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = (clientX - rect.left - this.panX) / this.zoom;
        const mouseY = (clientY - rect.top - this.panY) / this.zoom;

        for (const [nodeId, pos] of Object.entries(this.nodePositions)) {
            const node = NodeMan.get(nodeId, false);
            if (!node) continue;
            const nodeHeight = this.getNodeHeight(node);
            if (mouseX >= pos.x && mouseX <= pos.x + this.nodeWidth &&
                mouseY >= pos.y && mouseY <= pos.y + nodeHeight) {
                return nodeId;
            }
        }
        return null;
    }

    getAncestorsAndDescendants(startNodeId) {
        const result = new Set();
        result.add(startNodeId);

        const getAncestors = (nodeId, visited) => {
            const node = NodeMan.get(nodeId, false);
            if (!node) return;
            for (let key in node.inputs) {
                const inputNode = node.inputs[key];
                if (inputNode && !visited.has(inputNode.id)) {
                    visited.add(inputNode.id);
                    result.add(inputNode.id);
                    getAncestors(inputNode.id, visited);
                }
            }
        };

        const getDescendants = (nodeId, visited) => {
            const node = NodeMan.get(nodeId, false);
            if (!node) return;
            for (const outputNode of node.outputs) {
                if (outputNode && !visited.has(outputNode.id)) {
                    visited.add(outputNode.id);
                    result.add(outputNode.id);
                    getDescendants(outputNode.id, visited);
                }
            }
        };

        getAncestors(startNodeId, new Set([startNodeId]));
        getDescendants(startNodeId, new Set([startNodeId]));

        return result;
    }

    toggleUnconnectedNodes(nodeId) {
        if (this.savedState) {
            this.restoreState();
        } else {
            this.isolateNode(nodeId);
        }
    }

    isolateNode(nodeId) {
        const connected = this.getAncestorsAndDescendants(nodeId);

        this.savedState = {
            nodePositions: JSON.parse(JSON.stringify(this.nodePositions)),
            panX: this.panX,
            panY: this.panY,
            zoom: this.zoom
        };

        NodeMan.iterate((id, node) => {
            if (!connected.has(id)) {
                this.hiddenNodes.add(id);
            }
        });

        this.layoutConnectedNodes(nodeId, connected);
    }

    layoutConnectedNodes(centerNodeId, connected) {
        const columns = new Map();
        
        for (const id of connected) {
            const pos = this.nodePositions[id];
            if (!pos) continue;
            const col = Math.round(pos.x / this.horizontalSpacing);
            if (!columns.has(col)) columns.set(col, []);
            columns.get(col).push(id);
        }

        const sortedCols = Array.from(columns.keys()).sort((a, b) => a - b);
        
        sortedCols.forEach((oldCol, newColIndex) => {
            const nodeIds = columns.get(oldCol);
            nodeIds.sort((a, b) => this.nodePositions[a].y - this.nodePositions[b].y);
            let currentY = 50;
            nodeIds.forEach((id) => {
                this.nodePositions[id].x = 50 + newColIndex * this.horizontalSpacing;
                this.nodePositions[id].y = currentY;
                const node = NodeMan.get(id, false);
                currentY += this.getNodeHeight(node) + this.verticalSpacing;
            });
        });
    }

    restoreState() {
        if (!this.savedState) return;

        this.nodePositions = this.savedState.nodePositions;
        this.panX = this.savedState.panX;
        this.panY = this.savedState.panY;
        this.zoom = this.savedState.zoom;
        this.savedState = null;
        this.hiddenNodes.clear();
    }

    recalculateLayout() {
        this.layoutDirty = true;
        this.nodePositions = {};
    }

    calculateLayout() {
        if (!this.layoutDirty) return;
        this.layoutDirty = false;

        const nodes = [];
        const nodeDepths = new Map();

        NodeMan.iterate((id, node) => {
            nodes.push(node);
        });

        const calculateDepth = (node, visited = new Set()) => {
            if (visited.has(node.id)) return 0;
            if (nodeDepths.has(node.id)) return nodeDepths.get(node.id);

            visited.add(node.id);
            let maxInputDepth = -1;

            for (let key in node.inputs) {
                const inputNode = node.inputs[key];
                if (inputNode) {
                    const inputDepth = calculateDepth(inputNode, new Set(visited));
                    maxInputDepth = Math.max(maxInputDepth, inputDepth);
                }
            }

            const depth = maxInputDepth + 1;
            nodeDepths.set(node.id, depth);
            return depth;
        };

        nodes.forEach(node => calculateDepth(node));

        const columns = new Map();
        const isolatedNodes = [];
        
        nodeDepths.forEach((depth, nodeId) => {
            const node = NodeMan.get(nodeId, false);
            const hasInputs = node && Object.keys(node.inputs).length > 0;
            const hasOutputs = node && node.outputs.length > 0;
            
            if (!hasInputs && !hasOutputs) {
                isolatedNodes.push(nodeId);
            } else {
                if (!columns.has(depth)) columns.set(depth, []);
                columns.get(depth).push(nodeId);
            }
        });

        const sortedDepths = Array.from(columns.keys()).sort((a, b) => a - b);
        let lastColY = 50;

        sortedDepths.forEach((depth, colIndex) => {
            const nodesInColumn = columns.get(depth);
            nodesInColumn.sort((aId, bId) => {
                const aNode = NodeMan.get(aId, false);
                const bNode = NodeMan.get(bId, false);
                const aHasVisibleDescendants = this.hasVisibleDescendants(aNode);
                const bHasVisibleDescendants = this.hasVisibleDescendants(bNode);

                if (aHasVisibleDescendants !== bHasVisibleDescendants) {
                    return aHasVisibleDescendants ? -1 : 1;
                }
                return 0;
            });
            let currentY = 50;
            nodesInColumn.forEach((nodeId) => {
                this.nodePositions[nodeId] = {
                    x: 50 + colIndex * this.horizontalSpacing,
                    y: currentY
                };
                const node = NodeMan.get(nodeId, false);
                currentY += this.getNodeHeight(node) + this.verticalSpacing;
            });
            if (colIndex === sortedDepths.length - 1) {
                lastColY = currentY;
            }
        });

        const lastColIndex = sortedDepths.length > 0 ? sortedDepths.length - 1 : 0;
        let isolatedY = lastColY + this.nodeBaseHeight + this.verticalSpacing;
        isolatedNodes.forEach((nodeId) => {
            this.nodePositions[nodeId] = {
                x: 50 + lastColIndex * this.horizontalSpacing,
                y: isolatedY
            };
            const node = NodeMan.get(nodeId, false);
            isolatedY += this.getNodeHeight(node) + this.verticalSpacing;
        });
    }

    renderCanvas(frame) {
        super.renderCanvas(frame);
        if (!this.visible) return;

        this.visibleOutputCache = new Map();
        this.visibleEdgeOutputCache = new Map();
        this.calculateLayout();

        const ctx = this.ctx;
        ctx.save();
        ctx.translate(this.panX, this.panY);
        ctx.scale(this.zoom, this.zoom);

        this.drawConnections(ctx);
        this.drawNodes(ctx);

        ctx.restore();
    }

    drawConnections(ctx) {
        ctx.lineWidth = 2 / this.zoom;

        NodeMan.iterate((id, node) => {
            if (this.hiddenNodes.has(id)) return;
            const toPos = this.nodePositions[id];
            if (!toPos) return;

            for (let key in node.inputs) {
                const inputNode = node.inputs[key];
                if (!inputNode) continue;
                if (this.hiddenNodes.has(inputNode.id)) continue;

                const fromPos = this.nodePositions[inputNode.id];
                if (!fromPos) continue;

                const fromNode = NodeMan.get(inputNode.id, false);
                const startX = fromPos.x + this.nodeWidth;
                const startY = fromPos.y + this.getNodeHeight(fromNode) / 2;
                const endX = toPos.x;
                const endY = this.getInputY(node, key);
                const inactiveEdge = this.countVisibleOutputsForEdge(inputNode, node, true) === 0;
                const edgeColor = inactiveEdge ? this.inactiveBranchColor : '#4a90d9';

                ctx.strokeStyle = edgeColor;
                ctx.beginPath();
                ctx.moveTo(startX, startY);

                const cpOffset = Math.abs(endX - startX) * 0.4;
                ctx.bezierCurveTo(
                    startX + cpOffset, startY,
                    endX - cpOffset, endY,
                    endX, endY
                );
                ctx.stroke();

                const arrowSize = 8 / this.zoom;
                const angle = Math.atan2(endY - startY, endX - startX);
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(endX - arrowSize * Math.cos(angle - 0.4), endY - arrowSize * Math.sin(angle - 0.4));
                ctx.lineTo(endX - arrowSize * Math.cos(angle + 0.4), endY - arrowSize * Math.sin(angle + 0.4));
                ctx.closePath();
                ctx.fillStyle = edgeColor;
                ctx.fill();
            }
        });
    }

    drawNodes(ctx) {
        NodeMan.iterate((id, node) => {
            if (this.hiddenNodes.has(id)) return;
            const pos = this.nodePositions[id];
            if (!pos) return;

            const nodeHeight = this.getNodeHeight(node);

            let bgColor = '#2d3748';
            if (node.isDisplayNode) bgColor = '#2d5748';
            else if (Object.keys(node.inputs).length === 0) bgColor = '#574832';
            const inactiveNode = !this.hasVisibleDescendants(node);
            if (inactiveNode) bgColor = this.inactiveBranchColor;

            ctx.fillStyle = bgColor;
            ctx.strokeStyle = inactiveNode ? this.inactiveBranchStrokeColor : '#4a5568';
            ctx.lineWidth = 2 / this.zoom;

            this.roundRect(ctx, pos.x, pos.y, this.nodeWidth, nodeHeight, 6);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#e2e8f0';
            ctx.font = `bold ${12 / this.zoom}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            const maxIdLen = 20;
            const displayId = id.length > maxIdLen ? id.substring(0, maxIdLen) + '...' : id;
            ctx.fillText(displayId, pos.x + 8, pos.y + 6);

            ctx.fillStyle = '#a0aec0';
            ctx.font = `${10 / this.zoom}px sans-serif`;
            const typeName = node.constructor.name.replace('CNode', '');
            ctx.fillText(typeName, pos.x + 8, pos.y + 22);

            const inputKeys = Object.keys(node.inputs);
            ctx.font = `${9 / this.zoom}px sans-serif`;
            inputKeys.forEach((key, index) => {
                ctx.fillStyle = '#63b3ed';
                const y = pos.y + this.nodeBaseHeight + index * this.inputLineHeight;
                ctx.fillText(key, pos.x + 8, y);
            });
        });
    }

    getNodeHeight(node) {
        const inputCount = Object.keys(node.inputs).length;
        return this.nodeBaseHeight + Math.max(0, inputCount) * this.inputLineHeight;
    }

    getInputY(node, inputKey) {
        const inputKeys = Object.keys(node.inputs);
        const index = inputKeys.indexOf(inputKey);
        const pos = this.nodePositions[node.id];
        if (!pos || index < 0) return pos ? pos.y + this.getNodeHeight(node) / 2 : 0;
        return pos.y + this.nodeBaseHeight + index * this.inputLineHeight + this.inputLineHeight / 2;
    }

    isNodeVisibleInDAG(node) {
        return node && node.visible && !this.hiddenNodes.has(node.id);
    }

    isVisibleDisplayNode(node) {
        return this.isNodeVisibleInDAG(node) && node.isDisplayNode;
    }

    hasVisibleDescendants(node) {
        return this.isVisibleDisplayNode(node) || this.countVisibleOutputs(node, true) > 0;
    }

    countVisibleOutputs(node, justDisplayNodes = false) {
        if (!node) return 0;

        const cacheKey = `${node.id}:${justDisplayNodes ? 1 : 0}`;
        if (this.visibleOutputCache.has(cacheKey)) {
            return this.visibleOutputCache.get(cacheKey);
        }

        let count = 0;
        for (const output of node.outputs) {
            count += this.countVisibleOutputsForEdge(node, output, justDisplayNodes);
        }

        this.visibleOutputCache.set(cacheKey, count);
        return count;
    }

    countVisibleOutputsForEdge(sourceNode, outputNode, justDisplayNodes = false) {
        if (!sourceNode || !outputNode || !this.isNodeVisibleInDAG(outputNode)) {
            return 0;
        }

        const cacheKey = `${sourceNode.id}->${outputNode.id}:${justDisplayNodes ? 1 : 0}`;
        if (this.visibleEdgeOutputCache.has(cacheKey)) {
            return this.visibleEdgeOutputCache.get(cacheKey);
        }

        let count = 0;
        if (outputNode.constructor.name === "CNodeSwitch") {
            if (outputNode.inputs[outputNode.choice] === sourceNode) {
                if (!justDisplayNodes) count++;
                count += this.countVisibleOutputs(outputNode, justDisplayNodes);
            }
        } else {
            if (!justDisplayNodes || outputNode.isDisplayNode) {
                count++;
            }
            count += this.countVisibleOutputs(outputNode, justDisplayNodes);
        }

        this.visibleEdgeOutputCache.set(cacheKey, count);
        return count;
    }

    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
}
