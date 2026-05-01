export const TEST_REGISTRY = [
    { id: 'testquick', name: 'TestQuick', group: 'Visual', file: 'regression.test.js', grep: 'testquick', snapshot: 'testquick-snapshot', url: '?testAll=2' },
    { id: 'default', name: 'Default', group: 'Visual', file: 'regression.test.js', grep: 'default', snapshot: 'default-snapshot', url: '?action=new&frame=10' },
   // { id: 'wmts', name: 'WMTS', group: 'Visual', file: 'regression.test.js', grep: 'WMTS', snapshot: 'WMTS-snapshot' },
    { id: 'agua', name: 'Agua', group: 'Visual', file: 'regression.test.js', grep: 'agua', snapshot: 'agua-snapshot', url: '?sitch=agua&frame=10' },
    { id: 'ocean', name: 'Ocean', group: 'Visual', file: 'regression.test.js', grep: 'ocean surface', snapshot: 'ocean-surface-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/REGRESSION%20TEST%20_%20Ocean%20Surface/20251114_234141.js&frame=10&mapType=OceanSurface' },
    { id: 'gimbal', name: 'Gimbal', group: 'Visual', file: 'regression.test.js', grep: 'gimbal', snapshot: 'gimbal-snapshot', url: '?sitch=gimbal&frame=10' },
    { id: 'starlink', name: 'Starlink', group: 'Visual', file: 'regression.test.js', grep: 'starlink', snapshot: 'starlink-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Stalink%20Names/20250218_060544.js' },
    { id: 'potomac', name: 'Potomac', group: 'Visual', file: 'regression.test.js', grep: 'potomac', snapshot: 'potomac-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Potomac/20250204_203812.js&frame=10' },
    { id: 'orion', name: 'Orion', group: 'Visual', file: 'regression.test.js', grep: 'orion', snapshot: 'orion-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Orion%20in%20Both%20views%20for%20Label%20Check/20251127_200130.js&frame=10' },
    { id: 'bledsoe', name: 'Bledsoe', group: 'Visual', file: 'regression.test.js', grep: 'bledsoe', snapshot: 'bledsoe-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/15857/BledsoeZoom/20250623_153507.js&frame=10' },
    { id: 'mosul', name: 'Mosul', group: 'Visual', file: 'regression.test.js', grep: 'mosul', snapshot: 'mosul-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Mosul%20Orb/20250707_055311.js&frame=62' },
    { id: 'nightsky-permalink', name: 'NightSky Permalink', group: 'Visual', file: 'regression.test.js', grep: 'nightsky permalink', snapshot: 'nightsky permalink-snapshot', url: '?sitch=nightsky&data=~(olat~51.48~olon~-3.16~lat~34.376627662040825~lon~-84.00309157040817~alt~36971.33215490772~startTime~%272023-02-28T00*3a45*3a41.276Z~az~-177.37058519694682~el~7.572727018255932~fov~48.170999999999985~roll~0~p~(x~-12526146.672264077~y~95667.1964429412~z~-1873477.710260879)~u~(x~0.05837430502341399~y~0.7414944410493608~z~0.6684148669845169)~q~(x~-0.39473570622715626~y~-0.6187577123399634~z~0.053388772167075584~w~0.6771057928091114)~f~526~pd~true~ssa~true~sfr~false~sfb~true~ssn~true~spd~29.3~rehostedFiles~(~%27https*3a*2f*2fsitrec.s3.us-west-2.amazonaws.com*2f15857*2fG6-1-6a5ed9b876ea212544084f48a933bcae.txt~%27https*3a*2f*2fsitrec.s3.us-west-2.amazonaws.com*2f15857*2fN230FR-track-press_alt_uncorrected*2520*25281*2529-fef762b490d1e988d0811bfb68a42273.kml)~rhs~true)_' },
    { id: 'demo-truck', name: 'Demo Truck', group: 'Visual', file: 'regression.test.js', grep: 'demo truck', snapshot: 'demo truck-snapshot', url: '?custom=https://sitrec.s3.us-west-2.amazonaws.com/1/Demo%20Truck%20With%203D%20buildings%20and%20video%20on%20Ground/20260307_002836.js&frame=660' },

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
