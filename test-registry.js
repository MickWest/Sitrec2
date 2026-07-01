export const TEST_REGISTRY = [

    // Save -> Load round trip of the default custom sitch. Self-comparing
    // (screenshot before save vs after reload), so it has no committed baseline.
    { id: 'save-load-roundtrip', name: 'Save/Load RoundTrip', group: 'Visual', file: 'save-load-roundtrip.test.js', grep: 'save -> load round trip', url: '?action=new&frame=10' },

    { id: 'ui-lighting', name: 'UI-Light', group: 'UI', file: 'ui-playwright.test.js', grep: 'Lighting ambient', snapshot: 'lighting-ambient-intensity-1.5-snapshot' },
    { id: 'ui-csv', name: 'UI-CSV', group: 'UI', file: 'ui-playwright.test.js', grep: 'LA Features CSV', snapshot: 'import-la-features-csv-snapshot' },
    { id: 'ui-stanag', name: 'UI-STANAG', group: 'UI', file: 'ui-playwright.test.js', grep: 'STANAG 4676', snapshot: 'import-stanag-xml-snapshot' },
    { id: 'ui-ambient', name: 'UI-Ambient', group: 'UI', file: 'ui-playwright.test.js', grep: 'same result with Ambient Only' },
    { id: 'ui-menu-sweep', name: 'UI-MenuSweep', group: 'UI', file: 'ui-menu-sweep.test.js', grep: 'menu control smoke sweep', url: '?action=new&frame=10' },
    
    { id: 'video-load', name: 'VideoLoad', group: 'Video', file: 'video-loading.test.js', grep: 'multiple video types', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/with%201/20260119_081547.js' },
    { id: 'webm', name: 'WebM', group: 'Video', file: 'webm-video-export.test.js', grep: 'valid WebM video' },
    
    { id: 'opencv', name: 'OpenCV', group: 'Motion', file: 'motion-analysis.test.js', grep: 'diagonal motion' },
    { id: 'motion-acc', name: 'MotionAcc', group: 'Motion', file: 'motion-accumulation.test.js', grep: 'Linear Tracklet' },
    { id: 'motion-acc2', name: 'MotionAcc2', group: 'Motion', file: 'motion-accumulation.test.js', grep: 'real video analysis' },
    
    { id: 'satellite', name: 'Satellite', group: 'Other', file: 'satellite-label-visibility.test.js', grep: 'Label Look Visible', url: '?sitch=nightsky' },
    { id: 'mobile', name: 'Mobile', group: 'Other', file: 'mobile-viewport.test.js', grep: 'iPhone-sized viewport' },

    { id: 'ai-tab', name: 'AI-Tab', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'open chat with Tab' },
    { id: 'ai-math', name: 'AI-Math', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'simple math' },
    { id: 'ai-heli', name: 'AI-Heli', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'helicopter model' },
    { id: 'ai-ambient', name: 'AI-Ambient', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'change lighting to ambient' },
    { id: 'ai-drone', name: 'AI-Drone', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'use a drone' },
    { id: 'ai-time', name: 'AI-Time', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'colloquial time' },
    { id: 'ai-zoom', name: 'AI-Zoom', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'zoom in' },
    { id: 'ai-stars', name: 'AI-Stars', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'partial menu' },
    { id: 'ai-plane', name: 'AI-Plane', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'small plane' },
    { id: 'ai-egg', name: 'AI-Egg', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'superegg' },
    { id: 'ai-spheres', name: 'AI-Spheres', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'all objects use spheres' },
    { id: 'ai-box', name: 'AI-Box', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'box shape' },
    { id: 'ai-geom', name: 'AI-Geom', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'geometry instead' },
    { id: 'ai-737', name: 'AI-737', group: 'AI', file: 'chatbot-playwright.test.js', grep: '737s' },
    { id: 'ai-skinny', name: 'AI-Skinny', group: 'AI', file: 'chatbot-playwright.test.js', grep: 'skinny cuboids' },

    { id: 'docker-smoke', name: 'Docker Smoke', group: 'Docker', file: 'docker-smoke.test.js', grep: 'loads and renders without errors', snapshot: 'docker-smoke-snapshot', url: '?action=new&frame=10' },

    { id: 'nitf-nc', name: 'NITF-NC', group: 'NITF', file: 'nitf-decode.test.js', grep: 'NC uncompressed' },
    { id: 'nitf-c3', name: 'NITF-C3', group: 'NITF', file: 'nitf-decode.test.js', grep: 'C3 JPEG' },
    { id: 'nitf-c8', name: 'NITF-C8', group: 'NITF', file: 'nitf-decode.test.js', grep: 'C8 JPEG 2000' },
    { id: 'nitf-nsif', name: 'NITF-NSIF', group: 'NITF', file: 'nitf-decode.test.js', grep: 'NSIF file' },
];

export function getTestById(id) {
    return TEST_REGISTRY.find(t => t.id === id);
}

export function getTestByGrep(grep) {
    return TEST_REGISTRY.find(t => grep.includes(t.grep) || t.grep.includes(grep));
}
