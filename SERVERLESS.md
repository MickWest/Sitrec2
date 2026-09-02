# Sitrec Serverless - No PHP Required! 🚀

Welcome to the serverless version of Sitrec! This is a fully functional build that runs completely in the browser with **zero backend dependencies**.

## What is Serverless?

Serverless means no PHP backend server is required. All data storage happens locally in your browser using IndexedDB and LocalStorage.

**Note:** You still need a simple static file server (like the included `standalone-serverless.js`) to serve the files. This is because browsers can't load JavaScript modules directly from the filesystem (`file://` URLs) due to CORS security restrictions. The server does no processing - it just serves static files. For production, you can deploy to any static hosting (S3, GitHub Pages, Netlify) with no server-side code.

It's perfect for:

- ✅ **Offline-first usage** - Works completely without internet
- ✅ **Demos & testing** - No infrastructure setup needed
- ✅ **Privacy-focused** - Data never leaves your machine
- ✅ **Easy deployment** - Just copy HTML/JS files anywhere
- ✅ **Educational use** - Great for learning and experimentation

## Quick Start

### Build the Serverless Version

```bash
npm run build-serverless
```

Or for development with debug output:

```bash
npm run build-serverless-debug
```

### Start the Server

```bash
npm run start-serverless
```

Then open your browser to:
```
http://localhost:3000/sitrec
```

### One-Step Development

Build and start together:

```bash
npm run dev-serverless
```

## Features

### ✅ What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Load available sitches | ✅ | Built-in sitches from `/data` folder |
| Create custom sitches | ✅ | Create new sitch from scratch |
| Import files | ✅ | Drag & drop local files (tracks, KML, etc.) |
| Local save | ✅ | Save to IndexedDB (survives browser restart) |
| Local load | ✅ | Load previous sessions from IndexedDB |
| Settings | ✅ | Stored locally in IndexedDB |
| Offline mode | ✅ | Works completely offline |
| All visualization | ✅ | All 3D/2D visualization features |
| Analysis tools | ✅ | Track analysis, calculations, etc. |

### ❌ What Doesn't Work

| Feature | Limitation | Why |
|---------|-----------|-----|
| Server-side file hosting | ❌ | No backend to rehost files |
| Cloud user accounts | ❌ | No authentication system |
| Settings sync | ❌ | Settings only stored locally |
| AI Chat | ❌ | Requires OpenAI backend |
| S3 uploads | ❌ | No credentials to access cloud |

## Architecture

### Data Storage

All data is stored in your browser:

```
IndexedDB (SitrecDB)
├── settings      - User settings (maxDetails, etc.)
├── files         - Saved sitch files
└── cache         - Cached data (TLE, etc.)
```

### File Storage Limits

Browser storage is limited (varies by browser):

- **Chrome/Firefox**: ~50GB
- **Safari**: ~50GB
- **Edge**: ~50GB

For typical Sitrec usage (a few sitches + files), you'll have **plenty of space**.

## Usage Examples

### Loading Built-in Sitches

1. Start the server: `npm run dev-serverless`
2. Open `http://localhost:3000/sitrec`
3. Click **"File → New Sitch"** to see available sitches
4. Select a sitch (e.g., "29palms", "gimbal", etc.)
5. The sitch will load with all its data

### Saving Your Work

1. Make changes to a sitch
2. Click **"File → Local → Save Local Sitch File"**
3. Your changes are automatically saved to IndexedDB
4. Even if you close the browser, your session is preserved
5. Click **"Load Local Sitch Folder"** to restore

### Importing Your Own Files

1. Prepare your files (KML, CSV tracks, video, etc.)
2. In Sitrec, **drag & drop** the files into the window
3. Or use **"File → Import File"**
4. Sitrec will auto-detect and parse the files

## API Endpoints (for debugging)

The serverless server includes debug endpoints:

```
GET /api/health          - Check if server is running
GET /api/manifest        - List available sitches
GET /api/debug/status    - Server status and environment
GET /api/debug/files     - List all files in build
```

Example:
```bash
curl http://localhost:3000/api/health
```

## Configuration

Default configuration is in `src/config.default.js`. Key sections:

```javascript
export const CONFIG = {
    storage: {
        indexedDB: { enabled: true, dbName: 'SitrecDB', dbVersion: 1 },
        localStorage: { enabled: true, prefix: 'sitrec_' }
    },
    features: {
        serverUpload: false,    // disabled — no backend to rehost files
        serverSettings: false,  // disabled — no cloud settings sync
        aiChat: false,          // disabled — requires backend
        authentication: false,  // disabled — no user login
        s3Storage: false        // disabled — no cloud storage
    },
    enabledFeatures: {
        localSave: true,        // Save to IndexedDB
        localLoad: true,        // Load from IndexedDB
        offline: true,          // Offline-first
        dataCaching: true,      // Cache data in IndexedDB
        manifestLoading: true   // Load available sitches from manifest
    },
    // ... plus api, ui, and cache sections — see file for full details
};
```

## Troubleshooting

### "Build directory not found"

**Problem**: `Error: Build directory not found`

**Solution**: 
```bash
npm run build-serverless
```

### Settings not persisting

**Problem**: Settings disappear after reload

**Solution**: 
- Check browser console for errors
- Verify IndexedDB is enabled (not in private mode)
- Try clearing cache: `npm run build-serverless`

### Files larger than browser limit

**Problem**: Can't save large files

**Solution**:
- Chrome/Firefox/Edge allow ~50GB
- Use compressed formats for very large files
- For production, use Phase 2 with Firebase/S3

### Port already in use

**Problem**: `Error: Port 3000 already in use`

**Solution**:
```bash
SITREC_PORT=3001 npm run start-serverless
```

## Development

### Adding New Features

To add serverless-specific features:

1. Edit `src/IndexedDBManager.js` for storage logic
2. Update `SettingsManager.js` for new settings
3. Modify `src/config.default.js` for configuration
4. Test with `npm run dev-serverless`

### Building for Production

For production deployment (e.g., static hosting):

```bash
npm run build-serverless
# Then copy dist-serverless/ to your web server
```

Deploy to:
- AWS S3 + CloudFront
- GitHub Pages
- Netlify
- Vercel
- Any static file hosting

The build is about 141 MB in 478 files, and the largest single file is 12 MB.

### Serving from a subdirectory

The build works from any path, not only from the root of a domain. `SITREC_APP` is derived
from `window.location.pathname` at run time (`src/configUtils.js`), and webpack's
`publicPath: 'auto'` makes the script tags relative. Nothing is baked in.

Two things need attention on a host that publishes one directory and nothing above it:

- **Terrain.** `filterSourcesForServerless()` (`src/terrainSourceUtils.js`) removes every map
  and elevation source that is not marked `allowInServerless`. That removes all the built-in
  internet providers, and leaves "Local", which reads tiles from `SITREC_TERRAIN` — by default
  `../sitrec-terrain/`, a **sibling** of the app directory. A subdirectory-only host cannot
  serve that, so every tile 404s. Fix it in one of two ways:
  - Define your own sources with `SITREC_CUSTOM_MAP_<NAME>_*` and
    `SITREC_CUSTOM_ELEVATION_<NAME>_*` in `config/shared.env`. Sources built from those
    variables **do** carry `allowInServerless`, so they survive the filter. ESRI World Imagery
    and AWS Terrarium both need no API key and allow cross-origin requests. Then set
    `DEFAULT_MAP_TYPE=CustomMap_<NAME>` and `DEFAULT_ELEVATION_TYPE=CustomElevation_<NAME>`.
  - Or copy a tile mirror into the published directory and set
    `SITREC_TERRAIN_URL=./sitrec-terrain/`. Imagery z0-6 plus elevation z0-5 is about 136 MB.
- **A `.nojekyll` file**, but only if the host runs Jekyll over what you give it — that is,
  GitHub Pages in "deploy from a branch" mode, which processes the branch before serving it.
  A GitHub Actions deployment serves the artifact as-is, with no Jekyll involved, so it needs
  no marker. Note that `actions/upload-pages-artifact` strips dotfiles from the tarball by
  default, so adding one there does nothing anyway.

### GitHub Pages

`.github/workflows/pages.yml` does all of the above and publishes the result. It is manual
(`workflow_dispatch`) by default; uncomment its `push` trigger to deploy from `main`.

**The Pages source must be set to "GitHub Actions"** in the repository settings. A repository
that still has the older "deploy from a branch" setting will run the build and then fail at
the deploy step. Switching is also what keeps the build out of git: the artifact goes to
Actions storage and then to the Pages CDN, and nothing is committed. Publishing to a
`gh-pages` branch instead writes the whole build into the repository history on every deploy,
permanently.

Before it publishes, `postbuild-serverless` runs `scripts/auditBundleSecrets.js` over the
output, so a leaked key fails the job rather than reaching the web.

## Want Cloud Features?

For user accounts, cloud sync, AI chat, and server-side saves, use the **Standalone** or **Full Server** build instead. See `docs/dev/Installing-and-configuring.md` for setup instructions.

## Limitations & Constraints

### Browser-Specific

- **Private/Incognito mode**: IndexedDB may not persist
- **Mobile**: Works on mobile browsers but with storage limits
- **Cross-origin**: Can't fetch from different domains (CORS)
- **Large videos**: Stored locally, not accessible via URLs

### Design Constraints

- No user authentication
- No cloud backup
- Single-device only
- No real-time collaboration
- Settings shared per browser/device

## FAQ

**Q: Can I convert my serverless session to a server-based setup?**
A: Export your sitch as JSON (File → Download), then import it into a Standalone or Full Server installation.

**Q: Will my data be deleted?**
A: Only if you clear browser data manually. IndexedDB persists like cookies.

**Q: Can I run this on my own server?**
A: Yes! Just copy `dist-serverless/` to your web server. Use `standalone-serverless.js` as a reference Node.js server.

**Q: How much storage do I get?**
A: Depends on browser (typically 50GB+). For Sitrec, you'll have plenty.

**Q: Can I export my data?**
A: Yes! Download individual sitches or use browser DevTools to export IndexedDB data.

## Performance

- **Load time**: ~2-3 seconds (all JavaScript in browser)
- **Render**: Real-time 60fps for 3D/2D visualization
- **Storage**: Instant (IndexedDB is optimized for this)
- **Memory**: ~50-100MB typical usage

## Support & Issues

Found a bug? Have suggestions?

1. Check console for errors: `F12` → Console tab
2. Check `/api/debug/status` for server status
3. Try `npm run build-serverless` to rebuild
4. Clear browser cache and try again

## Next Steps

- For cloud features (user accounts, AI chat, S3 storage), see the [Standalone](docs/dev/Installing-and-configuring.md#standalone-nodejs-server) or [Full Server](docs/dev/Installing-and-configuring.md#local-web-server-installation) builds.
- For production deployment of the serverless build, copy `dist-serverless/` to any static hosting provider.

---

**Happy analyzing!** 🎉

For full installation documentation, see `docs/dev/Installing-and-configuring.md`.