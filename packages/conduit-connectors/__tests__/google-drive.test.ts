/**
 * Google Drive against a scripted stand-in for Google's OAuth and Drive
 * endpoints. Every request is recorded, so the tests assert what would go on
 * the wire — including the Drive queries built from plain fields and the
 * bytes of uploads and downloads.
 */
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '@aigntiq/conduit/schema';
import googleDrive from '@aigntiq/conduit-connectors/google-drive';
import { connect, json, last, scriptedHttp } from './support/stub';
import { renderPoll } from './support/triggers';

const FOLDER = 'application/vnd.google-apps.folder';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0a]);

const report = {
    id: 'f1',
    name: 'Report.pdf',
    mimeType: 'application/pdf',
    parents: ['folder-a'],
    size: '8',
    createdTime: '2026-05-01T08:00:00.000Z',
    modifiedTime: '2026-05-02T08:00:00.000Z',
    webViewLink: 'https://drive.google.com/file/d/f1/view',
    starred: false,
    trashed: false,
    owners: [{ emailAddress: 'ada@example.com' }]
};
const plan = { id: 'd1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', parents: ['folder-a'] };
const projects = { id: 'folder-a', name: 'Projects', mimeType: FOLDER, parents: ['root'] };

const bytes = (b: Uint8Array, type: string) => new Response(new Blob([b as Uint8Array<ArrayBuffer>]), { headers: { 'content-type': type } });

function driveStub() {
    return scriptedHttp({
        tokenEndpoint: 'oauth2.googleapis.com/token',
        revokeEndpoint: 'oauth2.googleapis.com/revoke',
        accessToken: 'ya29.drive',
        hosts: ['www.googleapis.com'],
        prefix: '/drive/v3',
        routes: ({ route, url, body, headers }) => {
            const q = url.searchParams.get('q') ?? '';
            switch (route) {
                case 'GET /about':
                    return json({ user: { emailAddress: 'ada@example.com', displayName: 'Ada Lovelace' } });
                case 'GET /files':
                    if (q.includes("name contains 'O\\'Brien'")) return json({ files: [] });
                    if (q.includes('bad query')) return json({ error: { code: 400, message: 'Invalid Value', errors: [{ reason: 'invalid', location: 'q', message: 'Invalid query' }] } }, 400);
                    if (q.startsWith(`mimeType = '${FOLDER}'`)) return json({ files: [{ id: 'folder-a', name: 'Projects' }, { id: 'folder-b', name: 'Receipts' }] });
                    if (!url.searchParams.get('pageToken')) return json({ files: [projects, report], nextPageToken: 'p2' });
                    return json({ files: [plan] });
                case 'GET /files/f1':
                    if (url.searchParams.get('alt') === 'media') return bytes(PDF, 'application/pdf');
                    return json(url.searchParams.get('fields') === 'parents' ? { parents: ['folder-a', 'folder-x'] } : report);
                case 'GET /files/d1':
                    return json(plan);
                case 'GET /files/big':
                    return json({ id: 'big', name: 'Huge deck', mimeType: 'application/vnd.google-apps.presentation' });
                case 'GET /files/big/export':
                    return new Response(JSON.stringify({ error: { code: 403, message: 'This file is too large to be exported.', errors: [{ reason: 'exportSizeLimitExceeded' }] } }), {
                        status: 403,
                        headers: { 'content-type': 'application/json' }
                    });
                case 'GET /files/folder-a':
                    if (url.searchParams.get('alt') === 'media') return json({ error: { code: 403, message: 'Only files with binary content can be downloaded.', errors: [{ reason: 'fileNotDownloadable' }] } }, 403);
                    return json(projects);
                case 'GET /files/folder-a/export':
                    return json({ error: { code: 400, message: 'Export only supports Docs Editors files.' } }, 400);
                case 'GET /files/locked':
                    if (url.searchParams.get('alt') === 'media') return json({ error: { code: 403, message: 'The user has not granted the app access.', errors: [{ reason: 'cannotDownloadFile' }] } }, 403);
                    return json({ id: 'locked', name: 'Locked.pdf', mimeType: 'application/pdf' });
                case 'GET /files/gone':
                    return json({ error: { code: 404, message: 'File not found: gone.' } }, 404);
                case 'GET /files/d1/export':
                    // A Doc can't become CSV (that's for Sheets).
                    if (url.searchParams.get('mimeType') === 'text/csv') return json({ error: { code: 400, message: 'The requested conversion is not supported.' } }, 400);
                    return bytes(new TextEncoder().encode(`exported as ${url.searchParams.get('mimeType')}`), url.searchParams.get('mimeType')!);
                case 'POST /files':
                    return json({ id: 'new-file', ...JSON.parse(body) });
                case 'PATCH /files/f1':
                    return json({ ...report, ...JSON.parse(body || '{}'), parents: url.searchParams.get('addParents') ? [url.searchParams.get('addParents')] : report.parents });
                case 'POST /files/f1/copy':
                    return json({ ...report, id: 'f1-copy', name: `Copy of ${report.name}`, ...JSON.parse(body) });
                case 'POST /files/f1/permissions':
                    return json({ id: 'perm-1', ...JSON.parse(body) });
                case 'PATCH /upload/drive/v3/files/new-file':
                    return json({ id: 'new-file', name: 'notes.txt', mimeType: headers.get('content-type'), parents: ['folder-a'], size: String(body.length) });
            }
            return undefined;
        }
    });
}

async function setup() {
    const stub = driveStub();
    return { ...(await connect('google-drive', stub.http)), seen: stub.seen };
}

describe('Google Drive: connecting', () => {
    it('asks for the drive scope and identifies the account from about.user', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive');
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'ada@example.com', displayName: 'Ada Lovelace' });
    });
});

describe('Google Drive: finding files', () => {
    it('builds the Drive query from plain fields, across shared drives and pages', async () => {
        const { conduit, account, seen } = await setup();
        const { output, pages } = await conduit.execute({ connector: 'google-drive', operation: 'search-files', account, inputs: { name: 'Rep', folderId: 'folder-a', type: 'pdf' } });
        expect(pages).toBe(2);
        const params = seen.find((s) => s.url.pathname === '/drive/v3/files')!.url.searchParams;
        expect(params.get('q')).toBe("name contains 'Rep' and 'folder-a' in parents and mimeType = 'application/pdf' and trashed = false");
        expect(Object.fromEntries(params)).toMatchObject({ supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', orderBy: 'folder,modifiedTime desc' });
        expect(output).toEqual([
            { id: 'folder-a', name: 'Projects', mimeType: FOLDER, folder: true, googleDoc: false, parents: ['root'] },
            {
                id: 'f1',
                name: 'Report.pdf',
                mimeType: 'application/pdf',
                folder: false,
                googleDoc: false,
                parents: ['folder-a'],
                size: 8,
                createdTime: '2026-05-01T08:00:00.000Z',
                modifiedTime: '2026-05-02T08:00:00.000Z',
                webViewLink: 'https://drive.google.com/file/d/f1/view',
                starred: false,
                trashed: false,
                owner: 'ada@example.com'
            },
            { id: 'd1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', folder: false, googleDoc: true, parents: ['folder-a'] }
        ]);
    });

    it('quotes values, so a name cannot break out of the query', async () => {
        const { conduit, account, seen } = await setup();
        await conduit.execute({ connector: 'google-drive', operation: 'search-files', account, inputs: { name: "O'Brien", includeTrashed: true } });
        expect(last(seen, 'GET', /\/files$/).url.searchParams.get('q')).toBe("name contains 'O\\'Brien'");
    });

    it('adds a raw query in parentheses, and puts a bad one on its field', async () => {
        const { conduit, account, seen } = await setup();
        await conduit.execute({ connector: 'google-drive', operation: 'search-files', account, inputs: { type: 'image', query: "modifiedTime > '2026-01-01T00:00:00'" } });
        expect(last(seen, 'GET', /\/files$/).url.searchParams.get('q')).toBe("mimeType contains 'image/' and trashed = false and (modifiedTime > '2026-01-01T00:00:00')");
        const err = await conduit.execute({ connector: 'google-drive', operation: 'search-files', account, inputs: { query: 'bad query' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.query', code: 'remote' }] });
    });

    it('offers My Drive and the folders, and only folders when searching', async () => {
        const { conduit, account, seen } = await setup();
        expect(await conduit.options({ connector: 'google-drive', operation: 'list-folders', account })).toEqual([
            { label: 'My Drive', value: 'root' },
            { label: 'Projects', value: 'folder-a' },
            { label: 'Receipts', value: 'folder-b' }
        ]);
        const found = await conduit.options({ connector: 'google-drive', operation: 'list-folders', account, inputs: { query: 'Pro' } });
        expect(found[0]).toEqual({ label: 'Projects', value: 'folder-a' });
        expect(last(seen, 'GET', /\/files$/).url.searchParams.get('q')).toBe(`mimeType = '${FOLDER}' and trashed = false and name contains 'Pro'`);
    });

    it('reports a missing file on the field', async () => {
        const { conduit, account } = await setup();
        const err = await conduit.execute({ connector: 'google-drive', operation: 'get-file', account, inputs: { fileId: 'gone' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.fileId', code: 'remote' }] });
    });
});

describe('Google Drive: downloading', () => {
    it('downloads a binary file as a file value with the exact bytes', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'f1' } });
        expect(output).toEqual({ filename: 'Report.pdf', contentType: 'application/pdf', base64: Buffer.from(PDF).toString('base64'), size: PDF.length });
        expect(Object.fromEntries(seen.at(-1)!.url.searchParams)).toEqual({ alt: 'media', supportsAllDrives: 'true' });
    });

    it('exports a Google Doc, PDF by default, adding the extension, from shared drives too', async () => {
        const { conduit, account, seen } = await setup();
        const pdf = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'd1' } });
        expect(Object.fromEntries(last(seen, 'GET', /\/export$/).url.searchParams)).toEqual({ mimeType: 'application/pdf', supportsAllDrives: 'true' });
        expect(pdf.output).toMatchObject({ filename: 'Plan.pdf', contentType: 'application/pdf' });
        expect(Buffer.from(pdf.output.base64, 'base64').toString()).toBe('exported as application/pdf');
        const docx = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'd1', exportAs: 'docx' } });
        expect(docx.output).toMatchObject({ filename: 'Plan.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    });

    it('refuses to download a folder, on the file field, without trying an export', async () => {
        const { conduit, account, seen } = await setup();
        const err = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'folder-a' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.fileId', message: 'A folder has no contents to download' }] });
        expect(seen.some((s) => s.url.pathname.endsWith('/export'))).toBe(false);
    });

    it('puts a file that cannot be downloaded on the file field, and a bad export format on its field', async () => {
        const { conduit, account } = await setup();
        const locked = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'locked' } }).catch((e: unknown) => e);
        expect(locked).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.fileId', message: 'This file cannot be downloaded' }] });
        const csv = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'd1', exportAs: 'csv' } }).catch((e: unknown) => e);
        expect(csv).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.exportAs', message: 'This file cannot be exported in that format' }] });
    });

    it('explains an export over Google’s size limit, though the error arrived as bytes', async () => {
        const { conduit, account } = await setup();
        const err = await conduit.execute({ connector: 'google-drive', operation: 'download-file', account, inputs: { fileId: 'big' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.fileId', message: 'The file is too large to export (Google’s limit is 10 MB)' }] });
    });
});

describe('Google Drive: writing', () => {
    it('uploads in two calls: metadata into the folder, then the bytes', async () => {
        const { conduit, account, seen } = await setup();
        const content = 'hello drive ✓';
        const { output } = await conduit.execute({
            connector: 'google-drive',
            operation: 'upload-file',
            account,
            inputs: { file: { filename: 'notes.txt', contentType: 'text/plain', base64: Buffer.from(content).toString('base64') }, folderId: 'folder-a' }
        });
        const create = last(seen, 'POST', /\/drive\/v3\/files$/);
        expect(JSON.parse(create.body)).toEqual({ name: 'notes.txt', parents: ['folder-a'], mimeType: 'text/plain' });
        const upload = last(seen, 'PATCH', /\/upload\/drive\/v3\/files\/new-file$/);
        expect(upload.url.searchParams.get('uploadType')).toBe('media');
        expect(upload.headers.get('content-type')).toBe('text/plain');
        expect(upload.body).toBe(content);
        expect(output).toMatchObject({ id: 'new-file', name: 'notes.txt', parents: ['folder-a'] });
    });

    it('creates a folder, in My Drive unless told otherwise', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-drive', operation: 'create-folder', account, inputs: { name: 'Invoices' } });
        expect(JSON.parse(last(seen, 'POST', /\/files$/).body)).toEqual({ name: 'Invoices', mimeType: FOLDER });
        expect(output).toMatchObject({ id: 'new-file', folder: true });
    });

    it('moves a file by swapping all its parents, and renames without a lookup', async () => {
        const { conduit, account, seen } = await setup();
        await conduit.execute({ connector: 'google-drive', operation: 'update-file', account, inputs: { fileId: 'f1', moveTo: 'folder-b' } });
        const move = last(seen, 'PATCH', /\/files\/f1$/);
        expect(Object.fromEntries(move.url.searchParams)).toMatchObject({ addParents: 'folder-b', removeParents: 'folder-a,folder-x' });

        const before = seen.length;
        const { output } = await conduit.execute({ connector: 'google-drive', operation: 'update-file', account, inputs: { fileId: 'f1', name: 'Final.pdf', starred: true } });
        expect(seen.length).toBe(before + 1);
        const rename = last(seen, 'PATCH', /\/files\/f1$/);
        expect(rename.url.searchParams.has('addParents')).toBe(false);
        expect(JSON.parse(rename.body)).toEqual({ name: 'Final.pdf', starred: true });
        expect(output).toMatchObject({ name: 'Final.pdf', starred: true });
    });

    it('copies into another folder', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-drive', operation: 'copy-file', account, inputs: { fileId: 'f1', folderId: 'folder-b' } });
        expect(JSON.parse(last(seen, 'POST', /copy$/).body)).toEqual({ parents: ['folder-b'] });
        expect(output).toMatchObject({ id: 'f1-copy' });
    });

    it('shares with a person by email, or with anyone without one', async () => {
        const { conduit, account, seen } = await setup();
        const person = await conduit.execute({ connector: 'google-drive', operation: 'share-file', account, inputs: { fileId: 'f1', emailAddress: 'grace@example.com', role: 'writer', message: 'Have a look' } });
        const sent = last(seen, 'POST', /permissions$/);
        expect(JSON.parse(sent.body)).toEqual({ type: 'user', role: 'writer', emailAddress: 'grace@example.com' });
        expect(Object.fromEntries(sent.url.searchParams)).toMatchObject({ sendNotificationEmail: 'true', emailMessage: 'Have a look' });
        expect(person.output).toEqual({ permissionId: 'perm-1', type: 'user', role: 'writer' });

        await conduit.execute({ connector: 'google-drive', operation: 'share-file', account, inputs: { fileId: 'f1', type: 'anyone' } });
        const link = last(seen, 'POST', /permissions$/);
        expect(JSON.parse(link.body)).toEqual({ type: 'anyone', role: 'reader' });
        expect(link.url.searchParams.has('sendNotificationEmail')).toBe(false);
    });

    it('needs an email address to share with a person', async () => {
        const { conduit, account, seen } = await setup();
        const before = seen.length;
        const err = await conduit.execute({ connector: 'google-drive', operation: 'share-file', account, inputs: { fileId: 'f1' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ issues: [{ path: 'inputs.emailAddress', code: 'required' }] });
        expect(seen.length).toBe(before);
    });

    it('trashes, marked destructive', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-drive', operation: 'trash-file', account, inputs: { fileId: 'f1' } });
        expect(JSON.parse(last(seen, 'PATCH', /\/files\/f1$/).body)).toEqual({ trashed: true });
        expect(output).toMatchObject({ trashed: true });
    });
});

describe('Google Drive: new-file trigger', () => {
    it('asks for files created since the cursor (inclusive), never folders, optionally in one folder', async () => {
        const before = new Date().toISOString();
        const first = await renderPoll(googleDrive, 'new-file');
        const q = String((first.request as { query: { q: string } }).query.q);
        const since = /^createdTime >= '([^']+)' and mimeType != 'application\/vnd\.google-apps\.folder' and trashed = false$/.exec(q)?.[1];
        expect(since! >= before.slice(0, 16)).toBe(true);
        expect(first.request).toMatchObject({ query: { orderBy: 'createdTime', supportsAllDrives: true, includeItemsFromAllDrives: true } });

        const inFolder = await renderPoll(googleDrive, 'new-file', { inputs: { folderId: 'folder-a' }, state: { cursor: '2026-05-01T08:00:00.000Z' } });
        expect((inFolder.request as { query: { q: string } }).query.q).toBe(
            "createdTime >= '2026-05-01T08:00:00.000Z' and mimeType != 'application/vnd.google-apps.folder' and trashed = false and 'folder-a' in parents"
        );
        const newer = { ...plan, id: 'd2', createdTime: '2026-05-03T08:00:00.000Z' };
        const seen = await inFolder.answer({ files: [report, newer] });
        expect([seen.keys, seen.cursor]).toEqual([['f1', 'd2'], '2026-05-03T08:00:00.000Z']);
        expect(seen.events[0]).toMatchObject({ id: 'f1', name: 'Report.pdf', size: 8, folder: false });
        expect((await inFolder.answer({ files: [] })).cursor).toBe('2026-05-01T08:00:00.000Z');
    });
});

describe('Google Drive: intent and typing', () => {
    it('marks the pure reads readOnly and only trash destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.describe('google-drive')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual(['search-files', 'get-file', 'download-file', 'list-folders', 'new-file']);
        expect(ops.filter((o) => o.destructive).map((o) => o.id)).toEqual(['trash-file']);
        const tools = toolDefinitions(await conduit.connectors.describe('google-drive'));
        expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"x-/);
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not a Google Drive operation
        void (() => conduit.execute({ connector: 'google-drive', operation: 'empty-trash', account }));
        // @ts-expect-error — role is reader | commenter | writer
        void (() => conduit.execute({ connector: 'google-drive', operation: 'share-file', account, inputs: { fileId: 'f', role: 'owner' } }));
    });
});
