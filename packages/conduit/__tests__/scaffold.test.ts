import { describe, expect, it } from 'vitest';
import { SPEC_VERSION } from '@sigx/conduit';

describe('scaffold', () => {
    it('exposes the spec version', () => {
        expect(SPEC_VERSION).toBe('conduit/1');
    });
});
