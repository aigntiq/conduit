import { describe, expect, it } from 'vitest';
import { inProcessLocks, memoryAccounts, memoryTransient, webCryptoCipher } from '@sigx/conduit';
import { accountStoreConformance, lockProviderConformance, transientStoreConformance } from '@sigx/conduit/testing';

accountStoreConformance('memoryAccounts', () => memoryAccounts());
transientStoreConformance('memoryTransient', (clock) => memoryTransient({ now: () => clock.now }));
lockProviderConformance('inProcessLocks', () => inProcessLocks());

describe('webCryptoCipher', () => {
    const secret = 'a-very-long-secret-used-only-for-this-test-suite';

    it('round-trips, with a fresh IV every time', async () => {
        const cipher = webCryptoCipher(secret);
        const a = await cipher.seal('héllo {"x":1}');
        const b = await cipher.seal('héllo {"x":1}');
        expect(a).toMatch(/^v1\./);
        expect(a).not.toBe(b);
        expect(await cipher.open(a)).toBe('héllo {"x":1}');
    });

    it('detects tampering and wrong keys', async () => {
        const sealed = await webCryptoCipher(secret).seal('data');
        const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
        await expect(webCryptoCipher(secret).open(flipped)).rejects.toThrow(/could not be opened/);
        await expect(webCryptoCipher(`${secret}-other`).open(sealed)).rejects.toThrow(/could not be opened/);
        await expect(webCryptoCipher(secret).open('plain')).rejects.toThrow(/unrecognised/);
    });

    it('opens values sealed with a previous key during a rotation', async () => {
        const old = await webCryptoCipher(secret).seal('before rotation');
        const rotated = webCryptoCipher('the-new-secret-that-replaces-the-old-one!!', { previous: [secret] });
        expect(await rotated.open(old)).toBe('before rotation');
    });

    it('rejects short secrets', async () => {
        await expect(webCryptoCipher('short').seal('x')).rejects.toThrow(/at least 32/);
    });
});
