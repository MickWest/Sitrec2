// Global Undo/Redo Manager
// Provides a generic undo/redo system that can be used across the application
// Actions are stored as { undo: function, redo: function, description: string }

import {setRenderOne} from "./Globals";

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
        if (this.isUndoing || this.isRedoing) {
            return;
        }
        
        if (!action.undo || !action.redo) {
            console.error("UndoManager: Action must have undo and redo functions", action);
            return;
        }
        
        // Add to undo stack
        this.undoStack.push(action);
        
        // Limit stack size
        if (this.undoStack.length > this.maxStackSize) {
            this.undoStack.shift();
        }
        
        // Clear redo stack when new action is added
        this.redoStack = [];
        
        console.log(`UndoManager: Added action "${action.description || 'unnamed'}". Undo stack: ${this.undoStack.length}`);
    }
    
    /**
     * Undo the last action
     */
    undo() {
        if (this.undoStack.length === 0) {
            console.log("UndoManager: Nothing to undo");
            return false;
        }
        
        const action = this.undoStack.pop();
        this.isUndoing = true;
        
        try {
            console.log(`UndoManager: Undoing "${action.description || 'unnamed'}"`);
            action.undo();
            this.redoStack.push(action);
            setRenderOne(true);
            return true;
        } catch (e) {
            console.error("UndoManager: Error during undo", e);
            // Put it back on the stack if undo failed
            this.undoStack.push(action);
            return false;
        } finally {
            this.isUndoing = false;
        }
    }
    
    /**
     * Redo the last undone action
     */
    redo() {
        if (this.redoStack.length === 0) {
            console.log("UndoManager: Nothing to redo");
            return false;
        }
        
        const action = this.redoStack.pop();
        this.isRedoing = true;
        
        try {
            console.log(`UndoManager: Redoing "${action.description || 'unnamed'}"`);
            action.redo();
            this.undoStack.push(action);
            setRenderOne(true);
            return true;
        } catch (e) {
            console.error("UndoManager: Error during redo", e);
            // Put it back on the stack if redo failed
            this.redoStack.push(action);
            return false;
        } finally {
            this.isRedoing = false;
        }
    }
    
    /**
     * Clear both stacks
     */
    clear() {
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