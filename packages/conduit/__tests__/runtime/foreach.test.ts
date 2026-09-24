/**
 * A step with `forEach` runs once per item: here, an upload session filled
 * in byte ranges, the way Graph and Drive take large files.
 */
import { describe, expect, it } from 'vitest';
import { createConduit, memorySource, type ConnectorSpec, type HttpClient } from '@aigntiq/conduit';

const FILE = Buffer.from('0123456789');

const spec = (step: Record<string, unknown> = {}): ConnectorSpec => ({
    spec: 'conduit/1',
    id: 'uploads',
    name: 'Uploads',
    version: '1.0.0',
    http: { baseUrl: 'https://api.example', allowHosts: ['upload.example'] },
    auth: [{ id: 'key', type: 'bearer' }],
    operations: [
        {
            id: 'upload',
            kind: 'action',
            label: 'Upload',
            inputs: { type: 'object', properties: { file: { type: 'object' } }, required: ['file'] },
            steps: [
                { name: 'session', method: 'POST', url: '/sessions', output: '{{response.body.uploadUrl}}' },
                {
                    name: 'parts',
                    forEach: '{{chunks(inputs.file.base64, 3)}}',
                    method: 'PUT',
                    url: '{{steps.session}}',
                    auth: false,
                    headers: { 'Content-Range': 'bytes {{each.start}}-{{each.end}}/{{each.total}}' },
                    body: '{{each.base64}}',
                    encoding: 'binary',
                    output: '{{ {index, status: response.status} }}',
                    ...step
                }
            ],
            request: { method: 'POST', url: '/sessions/done', body: { parts: '{{length(steps.parts)}}' } },
            output: '{{ {parts: steps.parts, done: response.body.ok} }}'
        }
    ]
});

function stub() {
    const puts: { range: string | null; auth: string | null; bytes: Buffer }[] = [];
    const http: HttpClient = async (request) => {
        const url = new URL(request.url);
        if (url.host === 'upload.example') {
            puts.push({ range: request.headers.get('content-range'), auth: request.headers.get('authorization'), bytes: Buffer.from(await request.arrayBuffer()) });
            return new Response(null, { status: puts.length === 4 ? 201 : 200 });
        }
        if (url.pathname === '/sessions') return Response.json({ uploadUrl: 'https://upload.example/s/1' });
        return Response.json({ ok: true });
    };
    return { http, puts };
}

async function run(step?: Record<string, unknown>) {
    const s = stub();
    const conduit = createConduit({ sources: memorySource([spec(step)]), secret: 'foreach-tests-secret-long-enough-for-it', http: s.http });
    const account = await conduit.auth.connect({ connector: 'uploads', method: 'key', owner: 'u1', inputs: { token: 't0k' } });
    const result = conduit.execute({ connector: 'uploads', operation: 'upload', account: account.id, inputs: { file: { filename: 'f', base64: FILE.toString('base64') } } });
    return { result, puts: s.puts };
}

describe('steps with forEach', () => {
    it('run once per item, in order, with each and index, and collect their outputs', async () => {
        const { result, puts } = await run();
        const { output } = await result;
        expect(puts.map((p) => p.range)).toEqual(['bytes 0-2/10', 'bytes 3-5/10', 'bytes 6-8/10', 'bytes 9-9/10']);
        expect(Buffer.concat(puts.map((p) => p.bytes))).toEqual(FILE);
        expect(puts.every((p) => p.auth === null)).toBe(true);
        expect(output).toEqual({
            parts: [
                { index: 0, status: 200 },
                { index: 1, status: 200 },
                { index: 2, status: 200 },
                { index: 3, status: 201 }
            ],
            done: true
        });
    });

    it('evaluate when per item, keeping the outputs aligned with the list', async () => {
        const { result, puts } = await run({ when: '{{index != 1}}' });
        const { output } = (await result) as { output: { parts: unknown[] } };
        expect(puts).toHaveLength(3);
        expect(output.parts).toEqual([{ index: 0, status: 200 }, null, { index: 2, status: 200 }, { index: 3, status: 200 }]);
    });

    it('refuse a forEach that is not a list, or longer than maxIterations, before any call', async () => {
        const notList = await run({ forEach: '{{inputs.file}}' });
        await expect(notList.result).rejects.toMatchObject({ code: 'step_foreach_invalid' });
        const tooMany = await run({ maxIterations: 3 });
        await expect(tooMany.result).rejects.toMatchObject({ code: 'step_foreach_invalid', message: expect.stringMatching(/4 items.*at most 3/) });
        expect([notList.puts, tooMany.puts]).toEqual([[], []]);
    });
});
