/**
 * A binary response mapped to a file value — the shape a "download file"
 * operation returns — end to end through `execute`.
 */
import { describe, expect, it } from 'vitest';
import { createConduit, memorySource, type ConnectorSpec, type HttpClient } from '@aigntiq/conduit';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x80]);

const spec: ConnectorSpec = {
    spec: 'conduit/1',
    id: 'files',
    name: 'Files',
    version: '1.0.0',
    http: { baseUrl: 'https://files.example' },
    operations: [
        {
            id: 'download',
            kind: 'action',
            label: 'Download',
            request: { url: '/report', responseType: 'binary' },
            output: {
                filename: 'report.pdf',
                contentType: "{{default(response.headers['content-type'], 'application/octet-stream')}}",
                base64: '{{base64(response.body)}}',
                size: '{{length(response.body)}}'
            }
        }
    ]
};

describe('binary responses', () => {
    it('map to a file value with the exact bytes', async () => {
        const http: HttpClient = async () => new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
        const conduit = createConduit({ sources: memorySource([spec]), secret: 'binary-response-tests-secret-long-enough', http });
        const { output } = await conduit.execute({ connector: 'files', operation: 'download' });
        expect(output).toEqual({ filename: 'report.pdf', contentType: 'application/pdf', base64: Buffer.from(PDF).toString('base64'), size: PDF.length });
        expect(new Uint8Array(Buffer.from((output as { base64: string }).base64, 'base64'))).toEqual(PDF);
    });
});
