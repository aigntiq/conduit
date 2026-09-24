/**
 * Google Sheets against a scripted stand-in for Google's OAuth, Sheets and
 * Drive endpoints. Every request is recorded, so the tests assert the A1
 * ranges and row bodies that would go on the wire as well as the mapping.
 */
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '@aigntiq/conduit/schema';
import sheets from '@aigntiq/conduit-connectors/google-sheets';
import { renderPoll } from './support/triggers';
import { connect, json, last, scriptedHttp } from './support/stub';

const TABLE = [
    ['Name', 'Email', 'Age'],
    ['Ada', 'ada@example.com', '36'],
    ['Grace', 'grace@example.com']
];

/** The decoded A1 range of a values request. */
const rangeOf = (url: URL) => decodeURIComponent(url.pathname.split('/values/')[1]!.replace(/:(append|clear)$/, ''));

function sheetsStub() {
    return scriptedHttp({
        tokenEndpoint: 'oauth2.googleapis.com/token',
        revokeEndpoint: 'oauth2.googleapis.com/revoke',
        accessToken: 'ya29.sheets',
        hosts: ['sheets.googleapis.com', 'www.googleapis.com'],
        prefix: '/v4',
        routes: ({ route, url, body }) => {
            if (url.host === 'www.googleapis.com') {
                if (route === 'GET /drive/v3/about') return json({ user: { emailAddress: 'ada@example.com', displayName: 'Ada Lovelace' } });
                if (route === 'GET /drive/v3/files') return json({ files: [{ id: 'ss1', name: 'Team roster' }, { id: 'ss2', name: 'Budget' }] });
                return undefined;
            }
            if (route.startsWith('GET /spreadsheets/missing')) return json({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404);
            if (route.includes('/values/') && rangeOf(url).startsWith("'Nope'")) {
                return json({ error: { code: 400, message: `Unable to parse range: ${rangeOf(url)}`, status: 'INVALID_ARGUMENT' } }, 400);
            }
            switch (route) {
                case 'GET /spreadsheets/ss1':
                    return json({
                        spreadsheetId: 'ss1',
                        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/ss1/edit',
                        properties: { title: 'Team roster', locale: 'en_GB', timeZone: 'Europe/Stockholm' },
                        sheets: [
                            { properties: { sheetId: 7, title: "Q1 '24", index: 1, gridProperties: { rowCount: 100, columnCount: 5 } } },
                            { properties: { sheetId: 0, title: 'People', index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } }
                        ]
                    });
                case 'POST /spreadsheets': {
                    const sent = JSON.parse(body);
                    return json({
                        spreadsheetId: 'ss-new',
                        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/ss-new/edit',
                        properties: sent.properties,
                        sheets: sent.sheets ?? [{ properties: { title: 'Sheet1' } }]
                    });
                }
                case 'POST /spreadsheets/ss1:batchUpdate': {
                    const title = JSON.parse(body).requests[0].addSheet.properties.title;
                    if (title === 'People') return json({ error: { code: 400, message: 'Invalid requests[0].addSheet: A sheet with the name "People" already exists.' } }, 400);
                    return json({ spreadsheetId: 'ss1', replies: [{ addSheet: { properties: { sheetId: 42, title, index: 2, sheetType: 'GRID' } } }] });
                }
                case 'GET /spreadsheets/ss1/values:batchGet':
                    return json({ spreadsheetId: 'ss1', valueRanges: [{ values: [TABLE[0]] }, { values: [['Linus', 'linus@example.com', '54']] }] });
            }
            if (route.startsWith('GET /spreadsheets/ss1/values/')) {
                const range = rangeOf(url);
                if (range.endsWith('!1:1')) return json({ range, values: [TABLE[0]] });
                return json({ range: range.includes('!') ? range : `${range}!A1:C3`, majorDimension: 'ROWS', values: TABLE });
            }
            if (route.startsWith('POST /spreadsheets/ss1/values/') && route.endsWith(':append')) {
                const rows = JSON.parse(body).values as unknown[][];
                return json({ spreadsheetId: 'ss1', updates: { updatedRange: `'People'!A4:C${3 + rows.length}`, updatedRows: rows.length, updatedCells: rows.flat().length } });
            }
            if (route.startsWith('PUT /spreadsheets/ss1/values/')) {
                const rows = JSON.parse(body).values as unknown[][];
                return json({ spreadsheetId: 'ss1', updatedRange: rangeOf(url), updatedRows: rows.length, updatedCells: rows.flat().length });
            }
            if (route.startsWith('POST /spreadsheets/ss1/values/') && route.endsWith(':clear')) return json({ spreadsheetId: 'ss1', clearedRange: rangeOf(url) });
            return undefined;
        }
    });
}

async function setup() {
    const stub = sheetsStub();
    return { ...(await connect('google-sheets', stub.http)), seen: stub.seen };
}

const where = { spreadsheetId: 'ss1', sheet: 'People' };

describe('Google Sheets: connecting', () => {
    it('asks for the sheets and Drive metadata scopes and identifies the account through Drive', async () => {
        const { conduit, account, authorizeUrl } = await setup();
        expect(authorizeUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly');
        expect(await conduit.accounts.get(account)).toMatchObject({ externalId: 'ada@example.com', displayName: 'Ada Lovelace' });
    });
});

describe('Google Sheets: spreadsheets and sheets', () => {
    it('offers spreadsheets from Drive, searchable, and the sheets of one in tab order', async () => {
        const { conduit, account, seen } = await setup();
        expect(await conduit.options({ connector: 'google-sheets', operation: 'list-spreadsheets', account, inputs: { query: "Q1 '24" } })).toEqual([
            { label: 'Team roster', value: 'ss1' },
            { label: 'Budget', value: 'ss2' }
        ]);
        expect(last(seen, 'GET', /\/drive\/v3\/files$/).url.searchParams.get('q')).toBe(
            "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name contains 'Q1 \\'24'"
        );
        expect(await conduit.options({ connector: 'google-sheets', operation: 'list-sheets', account, inputs: { spreadsheetId: 'ss1' } })).toEqual([
            { label: 'People', value: 'People' },
            { label: "Q1 '24", value: "Q1 '24" }
        ]);
    });

    it('makes the sheet picker depend on the spreadsheet', async () => {
        const { conduit } = await setup();
        const form = await conduit.connectors.form('google-sheets', { operation: 'get-values' });
        const sheet = form.groups.flatMap((g) => g.fields).find((f) => f.name === 'sheet')!;
        expect(sheet.options).toEqual({ operation: 'list-sheets', inputs: { spreadsheetId: '{{inputs.spreadsheetId}}' }, dependsOn: ['spreadsheetId'] });
    });

    it('describes a spreadsheet', async () => {
        const { conduit, account } = await setup();
        const { output } = await conduit.execute({ connector: 'google-sheets', operation: 'get-spreadsheet', account, inputs: { spreadsheetId: 'ss1' } });
        expect(output).toEqual({
            id: 'ss1',
            title: 'Team roster',
            url: 'https://docs.google.com/spreadsheets/d/ss1/edit',
            locale: 'en_GB',
            timeZone: 'Europe/Stockholm',
            sheets: [
                { sheetId: 7, title: "Q1 '24", index: 1, rowCount: 100, columnCount: 5 },
                { sheetId: 0, title: 'People', index: 0, rowCount: 1000, columnCount: 26 }
            ]
        });
        const err = await conduit.execute({ connector: 'google-sheets', operation: 'get-spreadsheet', account, inputs: { spreadsheetId: 'missing' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'notFound', issues: [{ path: 'inputs.spreadsheetId', code: 'remote' }] });
    });

    it('creates a spreadsheet with named tabs, and adds a sheet', async () => {
        const { conduit, account, seen } = await setup();
        const created = await conduit.execute({ connector: 'google-sheets', operation: 'create-spreadsheet', account, inputs: { title: 'Plan', sheets: ['Tasks', 'Notes'] } });
        expect(JSON.parse(last(seen, 'POST', /\/spreadsheets$/).body)).toEqual({ properties: { title: 'Plan' }, sheets: [{ properties: { title: 'Tasks' } }, { properties: { title: 'Notes' } }] });
        expect(created.output).toEqual({ id: 'ss-new', title: 'Plan', url: 'https://docs.google.com/spreadsheets/d/ss-new/edit', sheets: ['Tasks', 'Notes'] });

        const added = await conduit.execute({ connector: 'google-sheets', operation: 'add-sheet', account, inputs: { spreadsheetId: 'ss1', title: 'Archive' } });
        expect(added.output).toEqual({ sheetId: 42, title: 'Archive', index: 2 });
        const err = await conduit.execute({ connector: 'google-sheets', operation: 'add-sheet', account, inputs: { spreadsheetId: 'ss1', title: 'People' } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.title', code: 'remote' }] });
    });
});

describe('Google Sheets: reading values', () => {
    it('returns rows as objects keyed by the header row, missing cells empty', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({ connector: 'google-sheets', operation: 'get-values', account, inputs: where });
        expect(rangeOf(last(seen, 'GET', /\/values\//).url)).toBe("'People'");
        expect(output).toEqual({
            range: "'People'!A1:C3",
            headers: ['Name', 'Email', 'Age'],
            rows: [
                { Name: 'Ada', Email: 'ada@example.com', Age: '36' },
                { Name: 'Grace', Email: 'grace@example.com', Age: '' }
            ]
        });
    });

    it('returns plain lists without a header row, quoting the sheet name and passing the range', async () => {
        const { conduit, account, seen } = await setup();
        const { output } = await conduit.execute({
            connector: 'google-sheets',
            operation: 'get-values',
            account,
            inputs: { spreadsheetId: 'ss1', sheet: "Q1 '24", range: 'A1:C3', headerRow: false, formatted: false }
        });
        const request = last(seen, 'GET', /\/values\//);
        expect(rangeOf(request.url)).toBe("'Q1 ''24'!A1:C3");
        expect(request.url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
        expect(output.rows).toEqual(TABLE);
        expect(output).not.toHaveProperty('headers');
    });

    it('puts an unparsable range on the range field when one was given, and on the sheet otherwise', async () => {
        const { conduit, account } = await setup();
        const sheet = await conduit.execute({ connector: 'google-sheets', operation: 'get-values', account, inputs: { spreadsheetId: 'ss1', sheet: 'Nope' } }).catch((e: unknown) => e);
        expect(sheet).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.sheet', code: 'remote', message: 'That sheet does not exist' }] });
        for (const operation of ['get-values', 'clear-values'] as const) {
            const range = await conduit.execute({ connector: 'google-sheets', operation, account, inputs: { spreadsheetId: 'ss1', sheet: 'Nope', range: 'A1:ZZZZ9' } }).catch((e: unknown) => e);
            expect(range, operation).toMatchObject({ kind: 'validation', issues: [{ path: 'inputs.range', code: 'remote', message: 'That sheet or range does not exist' }] });
        }
    });
});

describe('Google Sheets: writing values', () => {
    it('appends lists as they are, entered as if typed, without reading the header', async () => {
        const { conduit, account, seen } = await setup();
        const before = seen.length;
        const { output } = await conduit.execute({ connector: 'google-sheets', operation: 'append-rows', account, inputs: { ...where, rows: [['Linus', 'linus@example.com', 54]] } });
        expect(seen.length).toBe(before + 1);
        const append = last(seen, 'POST', /:append$/);
        expect(rangeOf(append.url)).toBe("'People'");
        expect(Object.fromEntries(append.url.searchParams)).toEqual({ valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
        expect(JSON.parse(append.body)).toEqual({ majorDimension: 'ROWS', values: [['Linus', 'linus@example.com', 54]] });
        expect(output).toEqual({ spreadsheetId: 'ss1', updatedRange: "'People'!A4:C4", updatedRows: 1, updatedCells: 3 });
    });

    it('puts object rows in header order, ignoring unknown keys and leaving missing cells empty', async () => {
        const { conduit, account, seen } = await setup();
        await conduit.execute({
            connector: 'google-sheets',
            operation: 'append-rows',
            account,
            inputs: { ...where, rows: [{ Email: 'linus@example.com', Name: 'Linus', Shoe: 44 }, ['Ken', 'ken@example.com'], { Age: 70 }], valueInputOption: 'RAW' }
        });
        expect(rangeOf(last(seen, 'GET', /\/values\//).url)).toBe("'People'!1:1");
        const append = last(seen, 'POST', /:append$/);
        expect(append.url.searchParams.get('valueInputOption')).toBe('RAW');
        expect(JSON.parse(append.body).values).toEqual([
            ['Linus', 'linus@example.com', ''],
            ['Ken', 'ken@example.com'],
            ['', '', 70]
        ]);
    });

    it('updates a range and clears one, clearing marked destructive', async () => {
        const { conduit, account, seen } = await setup();
        const updated = await conduit.execute({ connector: 'google-sheets', operation: 'update-values', account, inputs: { ...where, range: 'B2', rows: [['ada@new.example']] } });
        const put = last(seen, 'PUT', /\/values\//);
        expect(rangeOf(put.url)).toBe("'People'!B2");
        expect(JSON.parse(put.body)).toEqual({ majorDimension: 'ROWS', values: [['ada@new.example']] });
        expect(updated.output).toMatchObject({ updatedRows: 1, updatedCells: 1 });

        const cleared = await conduit.execute({ connector: 'google-sheets', operation: 'clear-values', account, inputs: { ...where, range: 'A2:C' } });
        expect(cleared.output).toEqual({ spreadsheetId: 'ss1', clearedRange: "'People'!A2:C" });
        expect((await conduit.connectors.describe('google-sheets')).operations.find((o) => o.id === 'clear-values')).toMatchObject({ destructive: true });
    });
});

describe('Google Sheets: new-row trigger', () => {
    it('reads the header and everything from row 2 at first, then only past the cursor', async () => {
        const first = await renderPoll(sheets, 'new-row', { inputs: { spreadsheetId: 'ss1', sheet: 'People' } });
        expect(first.request).toMatchObject({ url: '/spreadsheets/ss1/values:batchGet', query: { ranges: ["'People'!1:1", "'People'!A2:ZZZ"] } });
        const seen = await first.answer({ valueRanges: [{ values: [TABLE[0]] }, { values: TABLE.slice(1) }] });
        const url = new URL(seen.response.url);
        expect(url.origin + url.pathname).toBe('https://sheets.googleapis.com/v4/spreadsheets/ss1/values:batchGet');
        expect(url.searchParams.getAll('ranges')).toEqual(["'People'!1:1", "'People'!A2:ZZZ"]);
        expect(seen.keys).toEqual(['2', '3']);
        expect(seen.cursor).toBe('3');
        expect(seen.events[1]).toEqual({ row: 3, values: ['Grace', 'grace@example.com'], record: { Name: 'Grace', Email: 'grace@example.com', Age: '' } });

        const next = await renderPoll(sheets, 'new-row', { inputs: { spreadsheetId: 'ss1', sheet: 'People' }, state: { cursor: '3' } });
        expect(next.request).toMatchObject({ query: { ranges: ["'People'!1:1", "'People'!A4:ZZZ"] } });
        const added = await next.answer({ valueRanges: [{ values: [TABLE[0]] }, { values: [['Linus', 'linus@example.com', '54']] }] });
        expect([added.keys, added.cursor]).toEqual([['4'], '4']);
        expect(added.events[0]).toMatchObject({ row: 4, record: { Name: 'Linus', Age: '54' } });

        const quiet = await next.answer({ valueRanges: [{ values: [TABLE[0]] }, {}] });
        expect([quiet.items, quiet.cursor]).toEqual([[], '3']);
    });
});

describe('Google Sheets: intent and typing', () => {
    it('marks the pure reads readOnly and only clear destructive', async () => {
        const { conduit } = await setup();
        const ops = (await conduit.connectors.describe('google-sheets')).operations;
        expect(ops.filter((o) => o.readOnly).map((o) => o.id)).toEqual(['list-spreadsheets', 'list-sheets', 'get-spreadsheet', 'get-values', 'new-row']);
        expect(ops.filter((o) => o.destructive).map((o) => o.id)).toEqual(['clear-values']);
        const tools = toolDefinitions(await conduit.connectors.describe('google-sheets'));
        expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"x-/);
    });

    it('types every operation through the catalog', async () => {
        const { conduit, account } = await setup();
        // @ts-expect-error — not a Google Sheets operation
        void (() => conduit.execute({ connector: 'google-sheets', operation: 'delete-spreadsheet', account }));
        // @ts-expect-error — range is required when updating
        void (() => conduit.execute({ connector: 'google-sheets', operation: 'update-values', account, inputs: { spreadsheetId: 's', sheet: 'x', rows: [] } }));
    });
});
