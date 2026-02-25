// GPU Memory Monitor - Track WebGL/VRAM usage in real-time
// Displays texture, geometry, and total memory consumption
// Only active in local/dev mode - zero overhead in production

class GPUMemoryMonitor {
    constructor(renderer, scene = null) {
        this.renderer = renderer;
        this.scene = scene;
        this.enabled = false;
        this.updateInterval = 100; // Update every 100ms
        this.lastUpdate = 0;
        
        // Storage for metrics
        this.metrics = {
            geometries: 0,
            textures: 0,
            total: 0,
            timestamp: Date.now()
        };
        
        // History for graphing (keep last 60 samples)
        this.history = [];
        this.maxHistory = 60;
        
        // Cache for tracking
        this.textureCache = new Map();
        this.geometryCache = new Map();
        
        // GUI reference
        this.guiFolder = null;
        this.guiDebugMenu = null;
        this.displayControls = {};
        
        // Detect GPU memory extensions (Chrome-specific)
        this.gpuExtension = null;
        this.detectedGPUMemory = 0;
        this.initGPUExtension();
    }
    
    setScene(scene) {
        this.scene = scene;
    }
    
    initGPUExtension() {
        try {
            const gl = this.renderer.getContext();
            if (gl) {
                // Check for GPU memory info (Chrome-specific)
                this.gpuExtension = gl.getExtension('WEBGL_debug_renderer_info');
                if (this.gpuExtension) {
                    // Silently skip console output - only log if enabled in dev mode
                }
            }
        } catch (e) {
            // Silently ignore - no console spam in production
        }
    }
    
    /**
     * Debug method - logs all available renderer properties
     */
    debugProperties() {
        const props = this.renderer.properties;
        console.log('Renderer Properties available:', props);
        
        if (props.geometries) {
            console.log('Geometries count:', Object.keys(props.geometries).length);
            Object.entries(props.geometries).forEach(([key, geo], idx) => {
                if (idx < 3) { // Log first 3
                    console.log(`  Geometry ${key}:`, geo);
                }
            });
        }
        
        if (props.textures) {
            console.log('Textures count:', Object.keys(props.textures).length);
            Object.entries(props.textures).forEach(([key, tex], idx) => {
                if (idx < 3) { // Log first 3
                    console.log(`  Texture ${key}:`, tex);
                }
            });
        }
    }
    
    /**
     * Calculate geometry memory by scanning buffer size
     */
    calculateGeometryMemory() {
        let totalMemory = 0;
        let geometryCount = 0;
        const seenGeometries = new Set();
        
        try {
            // If scene is available, traverse and calculate
            if (this.scene) {
                this.scene.traverse(obj => {
                    if (obj.geometry && !seenGeometries.has(obj.geometry.uuid)) {
                        seenGeometries.add(obj.geometry.uuid);
                        geometryCount++;
                        
                        const geo = obj.geometry;
                        let geoSize = 0;
                        
                        // Count vertices - each attribute can be significant
                        if (geo.attributes) {
                            for (const [attrName, attr] of Object.entries(geo.attributes)) {
                                if (attr.array) {
                                    geoSize += attr.array.byteLength;
                                }
                            }
                        }
                        
                        // Count indices
                        if (geo.index && geo.index.array) {
                            geoSize += geo.index.array.byteLength;
                        }
                        
                        totalMemory += geoSize;
                    }
                });
                
                // Log breakdown if we found geometry
                if (geometryCount > 0) {
                    const geo_breakdown = this.getMemoryString(totalMemory);
                    // Optionally log: console.log(`Geometry: ${geometryCount} unique geometries, ${geo_breakdown} total`);
                }
                
                return totalMemory;
            }
            
            return 0;
        } catch (e) {
            // Silently ignore - this is only used in dev mode anyway
            return 0;
        }
    }
    
    /**
     * Calculate total triangle count from all geometries in the scene
     */
    calculateTriangleCount() {
        let totalTriangles = 0;
        const seenGeometries = new Set();
        
        try {
            if (this.scene) {
                this.scene.traverse(obj => {
                    if (obj.geometry && !seenGeometries.has(obj.geometry.uuid)) {
                        seenGeometries.add(obj.geometry.uuid);
                        const geo = obj.geometry;
                        
                        if (geo.index) {
                            // If indexed geometry, triangle count = index count / 3
                            totalTriangles += geo.index.count / 3;
                        } else if (geo.attributes.position) {
                            // If non-indexed, triangle count = vertex count / 3
                            totalTriangles += geo.attributes.position.count / 3;
                        }
                    }
                });
            }
            
            return Math.floor(totalTriangles);
        } catch (e) {
            console.warn('Error calculating triangle count:', e);
            return 0;
        }
    }
    
    /**
     * Calculate texture memory by summing all loaded textures
     */
    calculateTextureMemory() {
        let totalMemory = 0;
        
        try {
            // Traverse through the scene and calculate texture sizes
            if (this.scene) {
                const textureMap = new Map();
                const textureTypes = [
                    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 
                    'aoMap', 'emissiveMap', 'displacementMap', 'bumpMap',
                    'alphaMap', 'envMap', 'lightMap'
                ];
                
                this.scene.traverse(obj => {
                    if (obj.material) {
                        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
                        materials.forEach(mat => {
                            // Check all common texture properties
                            textureTypes.forEach(texType => {
                                if (mat[texType]) {
                                    this.addTextureSize(mat[texType], textureMap);
                                }
                            });
                        });
                    }
                });
                
                // Sum up all tracked textures
                for (const [tex, size] of textureMap.entries()) {
                    totalMemory += size;
                }
            }
            
            return totalMemory;
        } catch (e) {
            // Silently ignore - this is only used in dev mode anyway
            return 0;
        }
    }
    
    /**
     * Helper to calculate and track texture size
     */
    addTextureSize(texture, textureMap) {
        if (!texture || textureMap.has(texture)) return; // Already counted
        
        try {
            let size = 0;
            let width = 0;
            let height = 0;
            
            // Try multiple ways to get dimensions for different texture types
            
            // 1. For CanvasTexture - texture.image is the canvas
            if (texture.image && typeof texture.image.width !== 'undefined') {
                width = texture.image.width;
                height = texture.image.height;
            }
            // 2. For TextureLoader images
            else if (texture.source?.data?.width) {
                width = texture.source.data.width;
                height = texture.source.data.height;
            }
            // 3. Try direct source properties (some GPUs store here)
            else if (texture.source) {
                width = texture.source.width || texture.source.image?.width || 0;
                height = texture.source.height || texture.source.image?.height || 0;
            }
            
            // 4. Fallback: check if texture was rendered to target
            if ((!width || !height) && texture.isWebGLRenderTarget) {
                width = texture.width || 0;
                height = texture.height || 0;
            }
            
            if (width > 0 && height > 0) {
                // Determine bytes per pixel based on format
                let bytesPerPixel = 4; // Default RGBA
                
                if (texture.format) {
                    // Three.js format constants
                    if (texture.format === 1024) { // RGBFormat
                        bytesPerPixel = 3;
                    } else if (texture.format === 1026) { // LuminanceFormat
                        bytesPerPixel = 1;
                    } else if (texture.format === 1027) { // LuminanceAlphaFormat
                        bytesPerPixel = 2;
                    } else if (texture.format === 1023) { // RedFormat
                        bytesPerPixel = 1;
                    }
                    // Handle other common formats
                    else if (texture.format === 1025) { // RGFormat (if exists)
                        bytesPerPixel = 2;
                    }
                }
                
                // Calculate base size
                size = width * height * bytesPerPixel;
                
                // Account for mipmaps (roughly 1/3 extra memory)
                if (texture.mipmaps && texture.mipmaps.length > 0) {
                    size *= 1.33;
                }
            }
            
            if (size > 0) {
                textureMap.set(texture, size);
            }
        } catch (e) {
            // Silently ignore - texture doesn't have valid size info
        }
    }
    
    /**
     * Update memory metrics by manually calculating from renderer properties
     */
    updateMetrics() {
        const now = Date.now();
        if (now - this.lastUpdate < this.updateInterval) {
            return; // Don't update more frequently than interval
        }
        this.lastUpdate = now;
        
        // Always calculate actual memory from scene - don't rely on renderer.info.memory
        // which may not report actual bytes
        let geometryMemory = this.calculateGeometryMemory();
        let textureMemory = this.calculateTextureMemory();
        
        // Fallback to renderer.info if calculations returned 0 and info is available
        const info = this.renderer.info;
        if (geometryMemory === 0 && textureMemory === 0 && info.memory) {
            geometryMemory = info.memory.geometries || 0;
            textureMemory = info.memory.textures || 0;
        }
        
        const total = geometryMemory + textureMemory;
        
        // Calculate total triangles in scene (not just rendered this frame)
        const totalTriangles = this.calculateTriangleCount();
        
        this.metrics = {
            geometries: geometryMemory,
            textures: textureMemory,
            total,
            timestamp: now,
            triangles: {
                total: totalTriangles,  // All triangles in scene
                rendered: info.render?.triangles || 0  // Triangles rendered this frame
            },
            render: {
                calls: info.render?.calls || 0,
                triangles: info.render?.triangles || 0,
                points: info.render?.points || 0,
                lines: info.render?.lines || 0
            }
        };
        
        // Add to history
        this.history.push({
            total,
            geometries: geometryMemory,
            textures: textureMemory,
            timestamp: now
        });
        
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
    }
    
    /**
     * Get detailed debug information about what's available in renderer.info
     */
    getDebugInfo() {
        const info = this.renderer.info;
        const result = {
            infoObject: {},
            memory: info.memory ? Object.assign({}, info.memory) : 'Not available',
            render: info.render ? Object.assign({}, info.render) : 'Not available',
            sceneAvailable: !!this.scene,
            sceneType: this.scene ? this.scene.constructor.name : 'N/A',
            geometriesCalculated: 0,
            texturesCalculated: 0
        };
        
        if (info.memory) {
            result.memoryAvailable = true;
            result.memoryKeys = Object.keys(info.memory);
            result.memoryValues = {};
            // Log each key with its value
            for (const [key, value] of Object.entries(info.memory)) {
                result.memoryValues[key] = value;
            }
        }
        
        // Count objects in scene for debugging
        if (this.scene) {
            let objectCount = 0;
            let geometryCount = 0;
            let materialCount = 0;
            let textureCount = 0;
            
            this.scene.traverse(obj => {
                objectCount++;
                if (obj.geometry) geometryCount++;
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        materialCount += obj.material.length;
                    } else {
                        materialCount++;
                    }
                }
            });
            
            result.sceneStats = {
                objects: objectCount,
                geometries: geometryCount,
                materials: materialCount
            };
        }
        
        // Also run calculations and show results
        const geoMem = this.calculateGeometryMemory();
        const texMem = this.calculateTextureMemory();
        const triCount = this.calculateTriangleCount();
        result.geometriesCalculated = geoMem || 0;
        result.texturesCalculated = texMem || 0;
        result.totalCalculated = (geoMem || 0) + (texMem || 0);
        result.trianglesCalculated = triCount;
        
        // Format for display
        result.formatted = {
            geometries: this.getMemoryString(geoMem || 0),
            textures: this.getMemoryString(texMem || 0),
            total: this.getMemoryString((geoMem || 0) + (texMem || 0)),
            triangles: triCount.toLocaleString(),
            renderedTriangles: (info.render?.triangles || 0).toLocaleString()
        };
        
        // Detailed texture info for debugging
        result.textureDetails = this.getDetailedTextureInfo();
        
        return result;
    }
    
    /**
     * Get detailed texture information for debugging
     */
    getDetailedTextureInfo() {
        const textures = [];
        const textureMap = new Map();
        
        try {
            if (this.scene) {
                const textureTypes = [
                    'map', 'normalMap', 'roughnessMap', 'metalnessMap',
                    'aoMap', 'emissiveMap', 'displacementMap', 'bumpMap',
                    'alphaMap', 'envMap', 'lightMap'
                ];
                
                this.scene.traverse(obj => {
                    if (obj.material) {
                        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
                        materials.forEach(mat => {
                            textureTypes.forEach(texType => {
                                if (mat[texType]) {
                                    const tex = mat[texType];
                                    if (!textureMap.has(tex)) {
                                        let width = 0, height = 0;
                                        
                                        // Try to get dimensions
                                        if (tex.image && typeof tex.image.width !== 'undefined') {
                                            width = tex.image.width;
                                            height = tex.image.height;
                                        } else if (tex.source?.data?.width) {
                                            width = tex.source.data.width;
                                            height = tex.source.data.height;
                                        } else if (tex.source) {
                                            width = tex.source.width || tex.source.image?.width || 0;
                                            height = tex.source.height || tex.source.image?.height || 0;
                                        }
                                        
                                        let size = 0;
                                        if (width > 0 && height > 0) {
                                            let bytesPerPixel = 4;
                                            if (tex.format) {
                                                if (tex.format === 1024) bytesPerPixel = 3;
                                                else if (tex.format === 1026 || tex.format === 1023) bytesPerPixel = 1;
                                                else if (tex.format === 1027 || tex.format === 1025) bytesPerPixel = 2;
                                            }
                                            size = width * height * bytesPerPixel;
                                            if (tex.mipmaps && tex.mipmaps.length > 0) {
                                                size *= 1.33;
                                            }
                                        }
                                        
                                        textureMap.set(tex, {
                                            width,
                                            height,
                                            size,
                                            type: tex.constructor.name,
                                            format: tex.format
                                        });
                                        
                                        textures.push({
                                            width,
                                            height,
                                            size: this.getMemoryString(size),
                                            sizeBytes: size,
                                            type: tex.constructor.name,
                                            format: tex.format
                                        });
                                    }
                                }
                            });
                        });
                    }
                });
            }
        } catch (e) {
            // Silently ignore - this is only used in dev mode anyway
        }
        
        return {
            count: textures.length,
            totalSize: this.getMemoryString(textures.reduce((sum, t) => sum + t.sizeBytes, 0)),
            textures: textures.slice(0, 10) // Show first 10
        };
    }
    
    /**
     * Get formatted memory string
     */
    getMemoryString(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }
    
    /**
     * Get memory stats as formatted object
     */
    getStats() {
        this.updateMetrics();
        return {
            geometries: this.getMemoryString(this.metrics.geometries),
            textures: this.getMemoryString(this.metrics.textures),
            total: this.getMemoryString(this.metrics.total),
            geometriesBytes: this.metrics.geometries,
            texturesBytes: this.metrics.textures,
            totalBytes: this.metrics.total,
            triangles: {
                total: this.metrics.triangles.total.toLocaleString(),  // Format with commas
                rendered: this.metrics.triangles.rendered.toLocaleString()
            },
            render: this.metrics.render
        };
    }
    
    /**
     * Get peak memory usage from history
     */
    getPeakMemory() {
        if (this.history.length === 0) return 0;
        return Math.max(...this.history.map(h => h.total));
    }
    
    /**
     * Get average memory usage from history
     */
    getAverageMemory() {
        if (this.history.length === 0) return 0;
        const sum = this.history.reduce((a, b) => a + b.total, 0);
        return sum / this.history.length;
    }
    
    /**
     * Reset memory history
     */
    reset() {
        this.history = [];
    }
    
    /**
     * Setup GUI folder for monitoring
     */
    setupGUI(guiMenus) {
        if (!guiMenus || !guiMenus.debug) {
            console.warn('GPUMemoryMonitor: guiMenus.debug not available');
            return;
        }
        
        this.guiDebugMenu = guiMenus.debug;
        this.guiFolder = guiMenus.debug.addFolder('GPU Memory Monitor');
        
        // Add display object for stats
        this.displayControls = {
            enabled: true,
            total: '0 MB',
            geometries: '0 MB',
            textures: '0 MB',
            peak: '0 MB',
            average: '0 MB',
            reset: () => this.reset()
        };
        
        this.guiFolder.add(this.displayControls, 'enabled').name('Monitor Enabled');
        this.guiFolder.add(this.displayControls, 'total').name('Total Memory').listen().disable();
        this.guiFolder.add(this.displayControls, 'geometries').name('Geometries').listen().disable();
        this.guiFolder.add(this.displayControls, 'textures').name('Textures').listen().disable();
        this.guiFolder.add(this.displayControls, 'peak').name('Peak Memory').listen().disable();
        this.guiFolder.add(this.displayControls, 'average').name('Average Memory').listen().disable();
        this.guiFolder.add(this.displayControls, 'reset').name('Reset History');
        
        this.enabled = true;
    }
    
    /**
     * Update GUI display values
     */
    updateGUI() {
        if (!this.displayControls.enabled || !this.guiFolder) {
            return;
        }

        if ((this.guiDebugMenu && this.guiDebugMenu._closed) || this.guiFolder._closed) {
            return;
        }
        
        const stats = this.getStats();
        this.displayControls.total = stats.total;
        this.displayControls.geometries = stats.geometries;
        this.displayControls.textures = stats.textures;
        this.displayControls.peak = this.getMemoryString(this.getPeakMemory());
        this.displayControls.average = this.getMemoryString(this.getAverageMemory());
        
        // Note: .listen() on GUI controllers handles automatic updates
        // so updateDisplay() is no longer needed here
    }
    
    /**
     * Log stats to console (useful for debugging)
     */
    logStats() {
        const stats = this.getStats();
        const peak = this.getMemoryString(this.getPeakMemory());
        const average = this.getMemoryString(this.getAverageMemory());
        console.log(
            `GPU Memory - Total: ${stats.total} | Geo: ${stats.geometries} | Tex: ${stats.textures} | Peak: ${peak} | Avg: ${average}`
        );
    }
    
    /**
     * Log detailed debug information to console
     */
    logDebugInfo() {
        const debug = this.getDebugInfo();
        console.log('=== GPU MEMORY MONITOR DEBUG ===');
        console.log('Scene Info:');
        console.log('  Available:', debug.sceneAvailable);
        console.log('  Type:', debug.sceneType);
        
        if (debug.sceneStats) {
            console.log('  Objects in scene:', debug.sceneStats.objects);
            console.log('  Geometries found:', debug.sceneStats.geometries);
            console.log('  Materials found:', debug.sceneStats.materials);
        }
        
        console.log('\nRenderer Info:');
        console.log('  Memory Available:', debug.memoryAvailable);
        if (debug.memoryValues && Object.keys(debug.memoryValues).length > 0) {
            console.log('  Memory Values:', debug.memoryValues);
        }
        if (debug.render && typeof debug.render === 'object') {
            console.log('  Render Info:', debug.render);
        }
        
        console.log('\nCalculated Memory:');
        console.log('  Geometries:', debug.formatted.geometries, `(${debug.geometriesCalculated} bytes)`);
        console.log('  Textures:', debug.formatted.textures, `(${debug.texturesCalculated} bytes)`);
        console.log('  Total:', debug.formatted.total, `(${debug.totalCalculated} bytes)`);
        console.log('=================================');
    }
    
    /**
     * Get JSON representation of current stats for external monitoring
     */
    toJSON() {
        const stats = this.getStats();
        return {
            timestamp: Date.now(),
            total: stats.totalBytes,
            geometries: stats.geometriesBytes,
            textures: stats.texturesBytes,
            peak: this.getPeakMemory(),
            average: this.getAverageMemory(),
            renderInfo: stats.render,
            formatted: {
                total: stats.total,
                geometries: stats.geometries,
                textures: stats.textures,
                peak: this.getMemoryString(this.getPeakMemory()),
                average: this.getMemoryString(this.getAverageMemory())
            }
        };
    }
}

export { GPUMemoryMonitor };