import {sanitizeSettings} from '../src/SettingsManager';

describe('sanitizeSettings', () => {
    test('accepts namespaced OpenRouter model slugs and rejects malformed variants', () => {
        expect(sanitizeSettings({
            chatModel: 'byok-openrouter:openai/gpt-5-mini',
        }).chatModel).toBe('byok-openrouter:openai/gpt-5-mini');
        expect(sanitizeSettings({chatModel: 'byok-openrouter:/gpt-5-mini'}).chatModel).toBeUndefined();
        expect(sanitizeSettings({chatModel: 'byok-openrouter:openai//gpt-5-mini'}).chatModel).toBeUndefined();
        expect(sanitizeSettings({chatModel: 'byok-openrouter:openai/gpt?key=x'}).chatModel).toBeUndefined();
    });

    test('should sanitize centerSidebar as boolean true', () => {
        const result = sanitizeSettings({ centerSidebar: true });
        expect(result.centerSidebar).toBe(true);
    });

    test('should sanitize centerSidebar as boolean false', () => {
        const result = sanitizeSettings({ centerSidebar: false });
        expect(result.centerSidebar).toBe(false);
    });

    test.each([1, 0, '1', '0', 'true', 'false'])(
        'should reject non-boolean centerSidebar value %p',
        value => expect(sanitizeSettings({centerSidebar: value}).centerSidebar).toBeUndefined(),
    );

    test('should not include centerSidebar when not provided', () => {
        const result = sanitizeSettings({});
        expect(result.centerSidebar).toBeUndefined();
    });

    test('should strip unknown settings', () => {
        const result = sanitizeSettings({ centerSidebar: true, unknownSetting: 'bad' });
        expect(result.centerSidebar).toBe(true);
        expect(result.unknownSetting).toBeUndefined();
    });

    test('should sanitize showAttribution as boolean', () => {
        expect(sanitizeSettings({ showAttribution: true }).showAttribution).toBe(true);
        expect(sanitizeSettings({ showAttribution: false }).showAttribution).toBe(false);
    });

    test('all boolean settings accept only JSON booleans', () => {
        const keys = [
            'enableOldAIModels', 'byokSitrecFocused', 'centerSidebar', 'showAttribution', 'showFilename',
            'startupLocation', 'startupBuildings',
        ];
        for (const key of keys) {
            expect(sanitizeSettings({[key]: true})[key]).toBe(true);
            expect(sanitizeSettings({[key]: false})[key]).toBe(false);
            for (const invalid of [1, 0, '1', '0', 'true', 'false']) {
                expect(sanitizeSettings({[key]: invalid})[key]).toBeUndefined();
            }
        }
    });

    test('should not include showAttribution when not provided', () => {
        expect(sanitizeSettings({}).showAttribution).toBeUndefined();
    });
});

describe('sanitizeSettings - new sitch startup preferences', () => {
    test('accepts the four unit systems and rejects anything else', () => {
        expect(sanitizeSettings({startupUnits: 'nautical'}).startupUnits).toBe('nautical');
        expect(sanitizeSettings({startupUnits: 'imperial'}).startupUnits).toBe('imperial');
        expect(sanitizeSettings({startupUnits: 'metric'}).startupUnits).toBe('metric');
        expect(sanitizeSettings({startupUnits: 'feet'}).startupUnits).toBe('feet');
        expect(sanitizeSettings({startupUnits: 'furlongs'}).startupUnits).toBeUndefined();
    });

    test('unit system is case insensitive, since sitches spell it "Nautical"', () => {
        expect(sanitizeSettings({startupUnits: 'Nautical'}).startupUnits).toBe('nautical');
    });

    test('startupLocation accepts a boolean', () => {
        expect(sanitizeSettings({startupLocation: true}).startupLocation).toBe(true);
        expect(sanitizeSettings({startupLocation: false}).startupLocation).toBe(false);
    });

    test('latitude and longitude are clamped to the globe', () => {
        expect(sanitizeSettings({startupLat: 34.05}).startupLat).toBeCloseTo(34.05);
        expect(sanitizeSettings({startupLat: 200}).startupLat).toBe(90);
        expect(sanitizeSettings({startupLat: -200}).startupLat).toBe(-90);
        expect(sanitizeSettings({startupLon: -118.24}).startupLon).toBeCloseTo(-118.24);
        expect(sanitizeSettings({startupLon: 400}).startupLon).toBe(180);
        expect(sanitizeSettings({startupLon: -400}).startupLon).toBe(-180);
    });

    test('non-numeric coordinates are dropped rather than stored as NaN', () => {
        expect(sanitizeSettings({startupLat: 'north'}).startupLat).toBeUndefined();
        expect(sanitizeSettings({startupLon: 'west'}).startupLon).toBeUndefined();
    });

    test('altitude is metres above ground, so it cannot go negative', () => {
        expect(sanitizeSettings({startupAlt: 0}).startupAlt).toBe(0);
        expect(sanitizeSettings({startupAlt: 1.5}).startupAlt).toBeCloseTo(1.5);
        expect(sanitizeSettings({startupAlt: -100}).startupAlt).toBe(0);
        expect(sanitizeSettings({startupAlt: 1e9}).startupAlt).toBe(100000);
        expect(sanitizeSettings({startupAlt: 'high'}).startupAlt).toBeUndefined();
    });

    test('startupBuildings accepts a boolean', () => {
        expect(sanitizeSettings({startupBuildings: true}).startupBuildings).toBe(true);
        expect(sanitizeSettings({startupBuildings: false}).startupBuildings).toBe(false);
    });

    test('none of them appear when not provided', () => {
        const result = sanitizeSettings({});
        for (const key of ['startupUnits', 'startupLocation', 'startupLat',
                           'startupLon', 'startupAlt', 'startupBuildings']) {
            expect(result[key]).toBeUndefined();
        }
    });
});
