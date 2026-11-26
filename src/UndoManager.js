// Global Undo/Redo Manager
// Provides a generic undo/redo system that can be used across the application
// Actions are stored as { undo: function, redo: function, description: string }

import {Globals, markSitchDirty, setRenderOne} from "./Globals";

class UndoManager {
    constructor() {
        this.undoStack = [];
        this.redoStack = [];
        this.maxStackSize = 100; // Limit stack size to prevent memory issues
        this.isUndoing = false;
        this.isRedoing = false;
    }
    
    /**
     * Add an undoable action to the stack
     * @param {Object} action - { undo: function, redo: function, description: string }
     */
    add(action) {
        // Don't add actions while we're undoing/redoing
        if (this.isUndoing || this.isRedoing || Globals?.disposing || Globals?.deserializing) {
            return;
        }
        
        if (typeof action.undo !== "function" || typeof action.redo !== "function") {
            console.error("UndoManager: Action must have undo and redo functions", action);
            return;
        }
        
        if (this.groupActions) {
            this.groupActions.push(action);
            return;
        }
        // Add to undo stack
        this.undoStack.push(action);
        markSitchDirty?.();
        
        // Limit stack size
        if (this.undoStack.length > this.maxStackSize) {
            this.undoStack.shift();
        }
        
        // Clear redo stack when new action is added
        this.redoStack = [];
        
//        console.log(`UndoManager: Added action "${action.description || 'unnamed'}". Undo stack: ${this.undoStack.length}`);
    }
    
    // A synchronous bulk command can reuse the individual commands, including
    // ones that skip invalid items. Only its completed edits enter history.
    group(description, edit) {
        if (this.groupActions) return edit();
        const actions = this.groupActions = [];
        try {
            return edit();
        } finally {
            this.groupActions = null;
            let applied = actions.length;
            if (applied) this.add({
                description,
                undo: () => {
                    while (applied > 0) {
                        actions[applied - 1].undo();
                        applied--;
                    }
                },
                redo: () => {
                    while (applied < actions.length) {
                        actions[applied].redo();
                        applied++;
                    }
                },
            });
        }
    }

    // Both snapshots must be detached, JSON-compatible edit state.
    recordState(description, before, after, restore) {
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        this.add({description, undo: () => restore(before), redo: () => restore(after)});
    }

    undo() {
        return this.replay("undo", this.undoStack, this.redoStack);
    }

    redo() {
        return this.replay("redo", this.redoStack, this.undoStack);
    }

    replay(direction, source, destination) {
        if (this.isUndoing || this.isRedoing || this.groupActions || !source.length) return false;
        const action = source[source.length - 1];
        this.isUndoing = direction === "undo";
        this.isRedoing = direction === "redo";
        try {
            action[direction]();
        } catch (error) {
            console.error(`UndoManager: Could not ${direction} "${action.description ?? "unnamed"}"`, error);
            return false;
        } finally {
            this.isUndoing = this.isRedoing = false;
        }

        // A load during replay replaced both stacks. Nothing from the old
        // sitch should be reachable from the new one.
        if (source !== (direction === "undo" ? this.undoStack : this.redoStack)) return false;
        source.pop();
        destination.push(action);
        markSitchDirty?.();
        setRenderOne(true);
        return true;
    }

    /**
     * Clear both stacks
     */
    clear() {
        if (this.groupActions) this.groupActions.length = 0;
        this.undoStack = [];
        this.redoStack = [];
        console.log("UndoManager: Stacks cleared");
    }
    
    /**
     * Check if undo is available
     */
    canUndo() {
        return this.undoStack.length > 0;
    }
    
    /**
     * Check if redo is available
     */
    canRedo() {
        return this.redoStack.length > 0;
    }
    
    /**
     * Get description of the next action that would be undone
     */
    getUndoDescription() {
        if (this.undoStack.length === 0) return null;
        return this.undoStack[this.undoStack.length - 1].description;
    }
    
    /**
     * Get description of the next action that would be redone
     */
    getRedoDescription() {
        if (this.redoStack.length === 0) return null;
        return this.redoStack[this.redoStack.length - 1].description;
    }
    
    /**
     * Get current stack sizes for debugging
     */
    getStatus() {
        return {
            undoCount: this.undoStack.length,
            redoCount: this.redoStack.length,
            nextUndo: this.getUndoDescription(),
            nextRedo: this.getRedoDescription()
        };
    }
}

// Create and export a singleton instance
export const undoManager = new UndoManager();

// Export the class as well in case someone wants to create their own instance
export { UndoManager };
