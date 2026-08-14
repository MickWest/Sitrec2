// Mock IndexedDBManager before importing BYOKKeyStore so the store uses the mock.
jest.mock('../src/IndexedDBManager', () => {
    const store = new Map();
    return {
        indexedDBManager: {
            async getSetting(key) { return store.has(key) ? store.get(key) : null; },
            async setSetting(key, value) { store.set(key, value); },
            async deleteSetting(key) { store.delete(key); },
            async getAllSettings() {
                const obj = {};
                for (const [k, v] of store.entries()) obj[k] = v;
                return obj;
            },
            _reset() { store.clear(); },
            _internal: store,
        },
    };
});

import { indexedDBManager } from '../src/IndexedDBManager';
import {
    getKey, setKey, deleteKey, getAllProviders, hasAnyKey,
    primeKeyCache, getCachedKey, hasCachedKey,
} from '../src/BYOKKeyStore';

beforeEach(() => {
    indexedDBManager._reset();
});

// Obfuscation at rest. This is explicitly NOT security — the passphrase ships in the
// public bundle — so these tests assert the two things it genuinely buys: a stored value
// is not casually readable, and an existing plaintext key keeps working.
describe('BYOKKeyStore obfuscation at rest', () => {
    test('the stored value does not contain the key in plain text', async () => {
        await setKey('anthropic', 'sk-ant-SUPERSECRET-abcdef123456');
        const stored = indexedDBManager._internal.get('byok_anthropic');
        expect(typeof stored).toBe('string');
        expect(stored).not.toContain('sk-ant-SUPERSECRET-abcdef123456');
        expect(stored).not.toContain('SUPERSECRET');
        expect(stored.startsWith('sitrec-obf-v1:')).toBe(true);
    });

    test('round-trips a key unchanged', async () => {
        await setKey('anthropic', 'sk-ant-round-trip-test');
        expect(await getKey('anthropic')).toBe('sk-ant-round-trip-test');
    });

    test('round-trips a username/password credential', async () => {
        // Space-Track uses a pair rather than a single key, so the envelope has to carry
        // an object, not just a string.
        await setKey('spacetrack', {username: 'someone', password: 'p@ss word'});
        expect(await getKey('spacetrack')).toEqual({username: 'someone', password: 'p@ss word'});
    });

    test('two saves of the same key produce different ciphertext', async () => {
        await setKey('anthropic', 'sk-ant-same');
        const first = indexedDBManager._internal.get('byok_anthropic');
        await setKey('anthropic', 'sk-ant-same');
        const second = indexedDBManager._internal.get('byok_anthropic');
        // A fresh random IV per write, so identical keys are not recognisable as identical.
        expect(first).not.toBe(second);
        expect(await getKey('anthropic')).toBe('sk-ant-same');
    });

    test('a key stored before obfuscation existed still works', async () => {
        // Written the old way, straight into the store with no envelope.
        await indexedDBManager.setSetting('byok_anthropic', 'sk-ant-legacy-plaintext');
        expect(await getKey('anthropic')).toBe('sk-ant-legacy-plaintext');
        expect(await hasAnyKey()).toBe(true);
    });

    test('a corrupted stored value reads as unset rather than as garbage', async () => {
        // Better to tell the user no key is set than to send a mangled string to a provider.
        await indexedDBManager.setSetting('byok_anthropic', 'sitrec-obf-v1:bm90:cmVhbGx5');
        expect(await getKey('anthropic')).toBeNull();
    });

    test('the primed cache holds usable plaintext', async () => {
        await setKey('google-maps', 'AIza-test-key');
        await primeKeyCache();
        expect(getCachedKey('google-maps')).toBe('AIza-test-key');
        expect(hasCachedKey('google-maps')).toBe(true);
        expect(getCachedKey('mapbox')).toBeNull();
    });
});

describe('BYOKKeyStore', () => {
    test('getKey returns null for unknown provider', async () => {
        expect(await getKey('anthropic')).toBeNull();
    });

    test('setKey and getKey round-trip', async () => {
        await setKey('anthropic', 'sk-ant-test-123');
        expect(await getKey('anthropic')).toBe('sk-ant-test-123');
    });

    test('setKey stores under byok_ prefix (not in the general settings namespace)', async () => {
        await setKey('anthropic', 'sk-ant-xyz');
        expect(indexedDBManager._internal.has('byok_anthropic')).toBe(true);
        expect(indexedDBManager._internal.has('anthropic')).toBe(false);
        expect(indexedDBManager._internal.has('chatModel')).toBe(false);
    });

    test('deleteKey removes the stored key', async () => {
        await setKey('anthropic', 'sk-ant-xyz');
        expect(await getKey('anthropic')).toBe('sk-ant-xyz');
        await deleteKey('anthropic');
        expect(await getKey('anthropic')).toBeNull();
    });

    test('getAllProviders lists only byok_ keys with non-empty values', async () => {
        await setKey('anthropic', 'sk-ant-xyz');
        await setKey('openai', 'sk-openai-abc');
        // Simulate an unrelated setting stored by the regular settings path
        await indexedDBManager.setSetting('chatModel', 'server:anthropic:claude');
        // Simulate an empty BYOK key (should be filtered)
        await indexedDBManager.setSetting('byok_empty', '');

        const providers = await getAllProviders();
        expect(providers.sort()).toEqual(['anthropic', 'openai']);
    });

    test('hasAnyKey reflects current key presence', async () => {
        expect(await hasAnyKey()).toBe(false);
        await setKey('anthropic', 'sk-ant-xyz');
        expect(await hasAnyKey()).toBe(true);
        await deleteKey('anthropic');
        expect(await hasAnyKey()).toBe(false);
    });

    test('getKey with empty provider returns null without throwing', async () => {
        expect(await getKey('')).toBeNull();
        expect(await getKey(null)).toBeNull();
        expect(await getKey(undefined)).toBeNull();
    });

    test('setKey with empty provider throws', async () => {
        await expect(setKey('', 'key')).rejects.toThrow('provider required');
    });
});
