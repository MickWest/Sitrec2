/**
 * Modern drag and resize utilities to replace jQuery UI functionality
 */

/**
 * Makes an element draggable
 * @param {HTMLElement} element - The element to make draggable
 * @param {Object} options - Configuration options
 * @param {HTMLElement|string} [options.handle] - Element or selector for drag handle
 * @param {Function} [options.onDrag] - Callback during drag
 * @param {Function} [options.onDragStart] - Callback when drag starts
 * @param {Function} [options.onDragEnd] - Callback when drag ends
 * @param {boolean} [options.shiftKey] - Whether to require shift key for dragging
 */
export function makeDraggable(element, options = {}) {
    if (!element) return;
    
    // Store the view instance on the element for callbacks
    const viewInstance = options.viewInstance;
    element._dragData = { viewInstance };
    
    let isDragging = false;
    let startX, startY;
    let startLeft, startTop;
    
    // Determine the handle element
    let handleElement = element;
    if (options.handle) {
        if (typeof options.handle === 'string') {
            handleElement = element.querySelector(options.handle);
        } else if (options.handle instanceof HTMLElement) {
            handleElement = options.handle;
        }
    }
    
    if (!handleElement) handleElement = element;
    
    // Add handle styling
    handleElement.style.cursor = 'move';
    
    const onMouseDown = (e) => {
        // Check if shift key is required and pressed
        if (options.shiftKey && !e.shiftKey) return;
        
        // Prevent default to avoid text selection during drag
        e.preventDefault();
        
        // Get initial positions
        startX = e.clientX;
        startY = e.clientY;
        
        const rect = element.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        
        isDragging = true;
        
        // Call onDragStart callback if provided
        if (options.onDragStart && typeof options.onDragStart === 'function') {
            options.onDragStart(e, { left: startLeft, top: startTop, element });
        }
        
        // Add global event listeners
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };
    
    const onMouseMove = (e) => {
        if (!isDragging) return;
        
        // Calculate new position
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        const newLeft = startLeft + dx;
        const newTop = startTop + dy;
        
        // Update element position
        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;
        
        // Call onDrag callback if provided
        if (options.onDrag && typeof options.onDrag === 'function') {
            const result = options.onDrag(e, { 
                left: newLeft, 
                top: newTop, 
                dx, 
                dy, 
                element,
                viewInstance: element._dragData.viewInstance
            });
            
            // If callback returns false, revert the position
            if (result === false) {
                element.style.left = `${startLeft}px`;
                element.style.top = `${startTop}px`;
            }
        }
    };
    
    const onMouseUp = (e) => {
        if (!isDragging) return;
        
        isDragging = false;
        
        // Call onDragEnd callback if provided
        if (options.onDragEnd && typeof options.onDragEnd === 'function') {
            options.onDragEnd(e, { 
                left: parseInt(element.style.left), 
                top: parseInt(element.style.top), 
                element,
                viewInstance: element._dragData.viewInstance
            });
        }
        
        // Remove global event listeners
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };
    
    // Add event listener to handle
    handleElement.addEventListener('mousedown', onMouseDown);
    
    // Store cleanup function on element
    element._dragCleanup = () => {
        handleElement.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        delete element._dragData;
        delete element._dragCleanup;
    };
    
    return element;
}

/**
 * Makes an element resizable
 * @param {HTMLElement} element - The element to make resizable
 * @param {Object} options - Configuration options
 * @param {boolean} [options.aspectRatio] - Whether to maintain aspect ratio
 * @param {string} [options.handles] - Which handles to show ('n,e,s,w,ne,se,sw,nw' or 'all')
 * @param {Function} [options.onResize] - Callback during resize
 * @param {Function} [options.onResizeStart] - Callback when resize starts
 * @param {Function} [options.onResizeEnd] - Callback when resize ends
 */
export function makeResizable(element, options = {}) {
    if (!element) return;
    
    // Store the view instance on the element for callbacks
    const viewInstance = options.viewInstance;
    element._resizeData = { viewInstance };
    
    // Set position to relative if not already absolute or fixed
    const computedStyle = window.getComputedStyle(element);
    if (computedStyle.position !== 'absolute' && computedStyle.position !== 'fixed') {
        element.style.position = 'relative';
    }
    
    // Determine which handles to create
    const handles = options.handles === 'all' ? 
        ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] : 
        (options.handles || 'se').split(',').map(h => h.trim());
    
    // Create resize handles
    const handleElements = {};
    handles.forEach(dir => {
        const handle = document.createElement('div');
        handle.className = `resize-handle resize-handle-${dir}`;
        handle.style.position = 'absolute';
        handle.style.width = '10px';
        handle.style.height = '10px';
        handle.style.backgroundColor = 'transparent';
        handle.style.zIndex = '1000';
        // Add subtle hover effect to make handles more discoverable
        handle.style.transition = 'background-color 0.2s ease';
        handle.addEventListener('mouseenter', () => {
            handle.style.backgroundColor = 'rgba(100, 150, 255, 0.3)';
        });
        handle.addEventListener('mouseleave', () => {
            handle.style.backgroundColor = 'transparent';
        });
        
        // Position the handle
        switch (dir) {
            case 'n':
                handle.style.top = '0px';
                handle.style.left = '50%';
                handle.style.transform = 'translateX(-50%)';
                handle.style.cursor = 'n-resize';
                handle.style.width = '100%';
                handle.style.height = '10px';
                break;
            case 'e':
                handle.style.top = '50%';
                handle.style.right = '0px';
                handle.style.transform = 'translateY(-50%)';
                handle.style.cursor = 'e-resize';
                handle.style.width = '10px';
                handle.style.height = '100%';
                break;
            case 's':
                handle.style.bottom = '0px';
                handle.style.left = '50%';
                handle.style.transform = 'translateX(-50%)';
                handle.style.cursor = 's-resize';
                handle.style.width = '100%';
                handle.style.height = '10px';
                break;
            case 'w':
                handle.style.top = '50%';
                handle.style.left = '0px';
                handle.style.transform = 'translateY(-50%)';
                handle.style.cursor = 'w-resize';
                handle.style.width = '10px';
                handle.style.height = '100%';
                break;
            case 'ne':
                handle.style.top = '0px';
                handle.style.right = '0px';
                handle.style.cursor = 'ne-resize';
                break;
            case 'se':
                handle.style.bottom = '0px';
                handle.style.right = '0px';
                handle.style.cursor = 'se-resize';
                break;
            case 'sw':
                handle.style.bottom = '0px';
                handle.style.left = '0px';
                handle.style.cursor = 'sw-resize';
                break;
            case 'nw':
                handle.style.top = '0px';
                handle.style.left = '0px';
                handle.style.cursor = 'nw-resize';
                break;
        }
        
        element.appendChild(handle);
        handleElements[dir] = handle;
        
        // Add resize event listeners
        let isResizing = false;
        let startX, startY;
        let startWidth, startHeight, startLeft, startTop;
        let aspectRatio;
        
        const onMouseDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = element.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            startLeft = rect.left;
            startTop = rect.top;
            
            if (options.aspectRatio) {
                aspectRatio = startWidth / startHeight;
            }
            
            // Call onResizeStart callback if provided
            if (options.onResizeStart && typeof options.onResizeStart === 'function') {
                options.onResizeStart(e, { 
                    width: startWidth, 
                    height: startHeight, 
                    left: startLeft, 
                    top: startTop, 
                    element,
                    direction: dir,
                    viewInstance: element._resizeData.viewInstance
                });
            }
            
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };
        
        const onMouseMove = (e) => {
            if (!isResizing) return;
            
            let newWidth = startWidth;
            let newHeight = startHeight;
            let newLeft = startLeft;
            let newTop = startTop;
            
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            
            // Calculate new dimensions based on handle direction
            switch (dir) {
                case 'n':
                    newHeight = startHeight - dy;
                    newTop = startTop + dy;
                    if (options.aspectRatio) {
                        newWidth = newHeight * aspectRatio;
                    }
                    break;
                case 'e':
                    newWidth = startWidth + dx;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 's':
                    newHeight = startHeight + dy;
                    if (options.aspectRatio) {
                        newWidth = newHeight * aspectRatio;
                    }
                    break;
                case 'w':
                    newWidth = startWidth - dx;
                    newLeft = startLeft + dx;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 'ne':
                    newWidth = startWidth + dx;
                    newHeight = startHeight - dy;
                    newTop = startTop + dy;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                        newTop = startTop + (startHeight - newHeight);
                    }
                    break;
                case 'se':
                    newWidth = startWidth + dx;
                    newHeight = startHeight + dy;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 'sw':
                    newWidth = startWidth - dx;
                    newHeight = startHeight + dy;
                    newLeft = startLeft + dx;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                    }
                    break;
                case 'nw':
                    newWidth = startWidth - dx;
                    newHeight = startHeight - dy;
                    newLeft = startLeft + dx;
                    newTop = startTop + dy;
                    if (options.aspectRatio) {
                        newHeight = newWidth / aspectRatio;
                        newTop = startTop + (startHeight - newHeight);
                    }
                    break;
            }
            
            // Enforce minimum size
            const minWidth = 20;
            const minHeight = 20;
            
            if (newWidth < minWidth) {
                newWidth = minWidth;
                if (options.aspectRatio) {
                    newHeight = newWidth / aspectRatio;
                }
            }
            
            if (newHeight < minHeight) {
                newHeight = minHeight;
                if (options.aspectRatio) {
                    newWidth = newHeight * aspectRatio;
                }
            }
            
            // Update element dimensions
            element.style.width = `${newWidth}px`;
            element.style.height = `${newHeight}px`;
            
            // Update position for handles that affect position
            if (['n', 'w', 'nw', 'ne', 'sw'].includes(dir)) {
                element.style.left = `${newLeft}px`;
                element.style.top = `${newTop}px`;
            }
            
            // Call onResize callback if provided
            if (options.onResize && typeof options.onResize === 'function') {
                const result = options.onResize(e, { 
                    width: newWidth, 
                    height: newHeight, 
                    left: newLeft, 
                    top: newTop, 
                    element,
                    direction: dir,
                    viewInstance: element._resizeData.viewInstance
                });
                
                // If callback returns false, revert the dimensions
                if (result === false) {
                    element.style.width = `${startWidth}px`;
                    element.style.height = `${startHeight}px`;
                    element.style.left = `${startLeft}px`;
                    element.style.top = `${startTop}px`;
                }
            }
        };
        
        const onMouseUp = (e) => {
            if (!isResizing) return;
            
            isResizing = false;
            
            // Call onResizeEnd callback if provided
            if (options.onResizeEnd && typeof options.onResizeEnd === 'function') {
                options.onResizeEnd(e, { 
                    width: parseInt(element.style.width), 
                    height: parseInt(element.style.height), 
                    left: parseInt(element.style.left), 
                    top: parseInt(element.style.top), 
                    element,
                    direction: dir,
                    viewInstance: element._resizeData.viewInstance
                });
            }
            
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        
        handle.addEventListener('mousedown', onMouseDown);
        handle._resizeCleanup = () => {
            handle.removeEventListener('mousedown', onMouseDown);
        };
    });
    
    // Store cleanup function on element
    element._resizeCleanup = () => {
        handles.forEach(dir => {
            const handle = handleElements[dir];
            if (handle && handle._resizeCleanup) {
                handle._resizeCleanup();
                element.removeChild(handle);
            }
        });
        delete element._resizeData;
        delete element._resizeCleanup;
    };
    
    return element;
}

/**
 * Removes draggable functionality from an element
 * @param {HTMLElement} element - The element to remove draggable from
 */
export function removeDraggable(element) {
    if (element && element._dragCleanup) {
        element._dragCleanup();
    }
}

/**
 * Removes resizable functionality from an element
 * @param {HTMLElement} element - The element to remove resizable from
 */
export function removeResizable(element) {
    if (element && element._resizeCleanup) {
        element._resizeCleanup();
    }
}

/**
 * Makes an element both draggable and resizable
 * @param {HTMLElement} element - The element to make draggable and resizable
 * @param {Object} options - Combined options for both functionalities
 */
export function makeDraggableAndResizable(element, options = {}) {
    makeDraggable(element, options);
    makeResizable(element, options);
    
    return element;
}