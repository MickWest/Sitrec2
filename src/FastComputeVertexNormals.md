# Fast Compute Vertex Normals

This module provides an optimized version of Three.js's `computeVertexNormals()` method that significantly improves performance by avoiding function call overhead and working directly with typed arrays.

## Performance Improvements

The optimized version provides the following benefits:

1. **Direct Array Access**: Works directly with `Float32Array` instead of using BufferAttribute getter/setter methods
2. **No Normalization Checks**: Assumes non-normalized attributes (which is the common case)
3. **Reduced Function Calls**: Eliminates the overhead of method calls in tight loops
4. **Optimized Math**: Uses efficient cross product calculations without temporary Vector3 objects
5. **Cache-Friendly**: Better memory access patterns for improved CPU cache utilization

## Usage

### Basic Usage

```javascript
import { fastComputeVertexNormals } from './FastComputeVertexNormals.js';

// Instead of:
geometry.computeVertexNormals();

// Use:
fastComputeVertexNormals(geometry);
```

### Patch Individual Geometry

```javascript
import { patchGeometryComputeVertexNormals } from './FastComputeVertexNormals.js';

// Replace the method on a specific geometry instance
patchGeometryComputeVertexNormals(geometry);

// Now the geometry uses the fast version
geometry.computeVertexNormals(); // Uses optimized version
```

### Global Patch (Use with Caution)

```javascript
import { patchAllGeometriesComputeVertexNormals } from './FastComputeVertexNormals.js';

// Replace the method globally for all BufferGeometry instances
patchAllGeometriesComputeVertexNormals();

// Now all geometries use the fast version
anyGeometry.computeVertexNormals(); // Uses optimized version
```

## Algorithm Details

### For Indexed Geometries
1. Iterate through all faces (triangles)
2. For each face, calculate the face normal using cross product
3. Add the face normal to each vertex's accumulated normal
4. Normalize all vertex normals at the end

### For Non-Indexed Geometries
1. Iterate through vertices in groups of 3 (triangles)
2. Calculate face normal for each triangle
3. Set the same face normal for all 3 vertices of that triangle
4. Normalize all vertex normals at the end

## Performance

The implementation is intended for the large terrain and merged-object geometries where
avoiding accessor calls and temporary vectors matters most. Measure it with representative
Sitrec geometry before treating any speed-up as a fixed ratio; the result depends on vertex
count, indexing, browser engine, and hardware.

## Compatibility

- ✅ Works with indexed and non-indexed geometries
- ✅ Produces identical results to the original method
- ✅ Compatible with all Three.js geometry types
- ✅ Handles edge cases (zero-length normals, degenerate triangles)
- ⚠️ Assumes non-normalized buffer attributes (standard case)

## Verification

There is no standalone `FastComputeVertexNormalsTest.js` harness. Run the repository unit
tests and a development build after changing the implementation:

```bash
npm test
npm run build
```

For performance work, profile terrain generation in the browser with the same geometry
before and after the change.

## Implementation Notes

### Key Optimizations

1. **Direct Array Indexing**: Instead of `geometry.getAttribute('position').getX(i)`, uses `positions[i * 3]`
2. **Inline Math**: Cross product calculations are inlined rather than using Vector3 methods
3. **Single Pass Normalization**: All normals are normalized in one final pass
4. **Minimal Allocations**: Reuses temporary variables instead of creating new objects

### Memory Usage

The optimized version uses slightly less memory by avoiding temporary Vector3 objects and working directly with the underlying arrays.

### Thread Safety

The function is thread-safe as it doesn't modify any global state, only the geometry's normal attribute.

## Integration in Sitrec

This optimization has been integrated into the Sitrec codebase in the following files:

- `src/QuadTreeTile.js`: synchronous and asynchronous terrain-normal generation
- `src/TilesTreeFlatten.js`: normals for flattened and merged tile geometry
- `src/nodes/CNode3DObject.js`: normals for imported object geometry

`src/FastComputeVertexNormalsAsync.js` is the yielding counterpart used where terrain work
must avoid monopolising the main thread.

The integration provides significant performance improvements for terrain tile generation and 3D object normal computation.
