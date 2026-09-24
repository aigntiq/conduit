/**
 * Google Sheets — read and write cell values, and create spreadsheets and
 * sheets.
 *
 * Values live at A1 ranges (`'Sheet 1'!A2:C`); the connector takes a sheet
 * name and an optional range and quotes them. Most sheets are tables with a
 * header row, so reads can return rows as objects keyed by the header, and
 * appends accept objects, matched to the header's columns.
 */
import {
    $,
    action,
    array,
    boolean,
    connector,
    expr,
    integer,
    json,
    object,
    options,
    pollTrigger,
    select,
    string,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { googleOAuth, googleRetry, googleSetup } from '../_shared/google';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.metadata.readonly'];

// ── Shared pieces ───────────────────────────────────────────────────────

const spreadsheetField = () => string({ title: 'Spreadsheet', options: { operation: 'list-spreadsheets', search: 'query' } });

const sheetField = () =>
    string({
        title: 'Sheet',
        options: { operation: 'list-sheets', inputs: { spreadsheetId: '{{inputs.spreadsheetId}}' }, dependsOn: ['spreadsheetId'] }
    });

const valueInput = select(
    { USER_ENTERED: 'As if typed (formulas, numbers and dates are parsed)', RAW: 'Exactly as given' },
    { title: 'Values are', default: 'USER_ENTERED', advanced: true }
);

/** `/spreadsheets/<id>[suffix]`, encoded. */
function sheetUrl(spreadsheetId: Ref, suffix = '') {
    return $`/spreadsheets/${expr`urlEncode(${spreadsheetId})`}${suffix}`;
}

/** `/spreadsheets/<id>/values/<A1 range>[suffix]`, the range quoted and encoded. */
function valuesUrl(spreadsheetId: Ref, sheet: Ref, range?: unknown, suffix = '') {
    return $`/spreadsheets/${expr`urlEncode(${spreadsheetId})`}/values/${expr`urlEncode(a1(${sheet}, ${range}))`}${suffix}`;
}

const rowsInput = json<unknown[]>({
    type: 'array',
    title: 'Rows',
    description: 'A list of rows. Each row is a list of cell values, or an object whose keys match the header row.',
    examples: [[['Ada', 'ada@example.com', 36]], [{ Name: 'Ada', Email: 'ada@example.com' }]]
});

function notFound(response: Ref): ErrorRuleDef {
    return { when: expr`${response.status} == 404`, error: 'notFound', field: 'spreadsheetId', message: 'That spreadsheet does not exist, or is not shared with this account' };
}

/** Sheets reports an unknown sheet or a bad range as a 400 "Unable to parse range". */
function badRange(response: Ref, field = 'sheet'): ErrorRuleDef {
    return {
        when: expr`${response.status} == 400 && contains(default(${response.body.error.message}, ''), 'Unable to parse range')`,
        error: 'validation',
        field,
        message: 'That sheet or range does not exist'
    };
}

const updateOutput = object({ spreadsheetId: string(), updatedRange: string().optional(), updatedRows: integer(), updatedCells: integer() });

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'google-sheets',
    name: 'Google Sheets',
    version: '1.0.0',
    description: 'Read, append, update and clear rows in Google Sheets, and create spreadsheets and sheets.',
    categories: ['spreadsheets', 'productivity'],
    brandColor: '#188038',
    homepage: 'https://sheets.google.com',
    helpUrl: 'https://developers.google.com/sheets/api',
    config: { baseUrl: 'https://sheets.googleapis.com/v4', driveUrl: 'https://www.googleapis.com/drive/v3' },
    functions: {
        quote: {
            params: ['s'],
            description: 'A Drive query string literal: single-quoted, with quotes and backslashes escaped.',
            body: String.raw`"'" + replace(replace(string(s), "\\", "\\\\"), "'", "\\'") + "'"`
        },
        a1: {
            params: ['sheet', 'range'],
            description: "An A1 range on a sheet, the sheet name quoted: 'Q1 ''24'!A2:C.",
            body: "\"'\" + replace(string(sheet), \"'\", \"''\") + \"'\" + (isEmpty(range) ? '' : '!' + range)"
        },
        recordOf: {
            params: ['headers', 'row'],
            description: 'A row as an object keyed by the header row.',
            body: 'fromEntries(map(headers, (h, i) => [h, default(row[i], "")]))'
        },
        rowOf: {
            params: ['headers', 'row'],
            description: 'A row to write: a list as it is, or an object put in header order.',
            body: "type(row) == 'array' ? row : map(headers, h => default(row[h], ''))"
        }
    },
    http: ({ config }) => ({
        baseUrl: config.baseUrl,
        headers: { Accept: 'application/json' },
        retry: googleRetry,
        // Drive (config.driveUrl) lists spreadsheets and identifies the account.
        allowHosts: ['www.googleapis.com']
    }),
    auth: [
        googleOAuth(({ response, config }) => ({
            scopes: SCOPES,
            // Sheets has no "me"; Drive's about does, under the metadata scope.
            identity: {
                request: { url: $`${config.driveUrl}/about`, query: { fields: 'user' } },
                id: response.body.user.emailAddress,
                name: expr`default(${response.body.user.displayName}, ${response.body.user.emailAddress})`
            },
            test: { url: $`${config.driveUrl}/about`, query: { fields: 'user' } },
            helpUrl: 'https://developers.google.com/sheets/api/scopes',
            setup: googleSetup('Google Sheets API and the Google Drive API', 'google-sheets', SCOPES, [
                'The Drive API lists spreadsheets for the pickers; `drive.metadata.readonly` sees names only, never contents.'
            ])
        }))
    ],
    operations: [
        options('list-spreadsheets', {
            label: 'Spreadsheets',
            readOnly: true,
            inputs: { query: string({ title: 'Search' }).optional() },
            request: ({ inputs, config }) => ({
                url: $`${config.driveUrl}/files`,
                query: {
                    q: expr`"mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false" + (isEmpty(${inputs.query}) ? '' : ' and name contains ' + quote(${inputs.query}))`,
                    fields: 'files(id,name)',
                    orderBy: 'modifiedTime desc',
                    pageSize: 100,
                    includeItemsFromAllDrives: true,
                    supportsAllDrives: true
                }
            }),
            output: ({ response }) => expr`map(default(${response.body.files}, []), f => {label: f.name, value: f.id})`
        }),

        options('list-sheets', {
            label: 'Sheets',
            readOnly: true,
            inputs: { spreadsheetId: string({ title: 'Spreadsheet' }) },
            request: ({ inputs }) => ({ url: sheetUrl(inputs.spreadsheetId), query: { fields: 'sheets.properties(title,index)' } }),
            errors: ({ response }) => [notFound(response)],
            output: ({ response }) => expr`default(${response.body.sheets}, []) | sortBy('properties.index') | map(s => {label: s.properties.title, value: s.properties.title})`
        }),

        action('get-spreadsheet', {
            label: 'Get spreadsheet',
            description: 'Title, locale, time zone and the sheets with their sizes.',
            group: 'Spreadsheets',
            readOnly: true,
            inputs: { spreadsheetId: spreadsheetField() },
            outputs: object({
                id: string(),
                title: string(),
                url: string(),
                locale: string().optional(),
                timeZone: string().optional(),
                sheets: array(object({ sheetId: integer(), title: string(), index: integer(), rowCount: integer().optional(), columnCount: integer().optional() }))
            }),
            request: ({ inputs }) => ({
                url: sheetUrl(inputs.spreadsheetId),
                query: { fields: 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))' }
            }),
            errors: ({ response }) => [notFound(response)],
            output: ({ response }) =>
                expr`{
                    id: ${response.body.spreadsheetId},
                    title: ${response.body.properties.title},
                    url: ${response.body.spreadsheetUrl},
                    locale: ${response.body.properties.locale},
                    timeZone: ${response.body.properties.timeZone},
                    sheets: map(default(${response.body.sheets}, []), s => compactObject({
                        sheetId: s.properties.sheetId, title: s.properties.title, index: s.properties.index,
                        rowCount: s.properties.gridProperties.rowCount, columnCount: s.properties.gridProperties.columnCount
                    }))
                } | compactObject`
        }),

        action('create-spreadsheet', {
            label: 'Create spreadsheet',
            group: 'Spreadsheets',
            inputs: {
                title: string({ title: 'Title' }),
                sheets: array(string(), { title: 'Sheets', description: 'Names of the tabs to start with. Default: one called Sheet1.' }).optional()
            },
            outputs: object({ id: string(), title: string(), url: string(), sheets: array(string()) }),
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/spreadsheets',
                body: { properties: { title: inputs.title }, sheets: expr`${inputs.sheets} == undefined ? undefined : map(${inputs.sheets}, title => {properties: {title}})` }
            }),
            output: ({ response }) => ({
                id: response.body.spreadsheetId,
                title: response.body.properties.title,
                url: response.body.spreadsheetUrl,
                sheets: expr`map(default(${response.body.sheets}, []), s => s.properties.title)`
            })
        }),

        action('add-sheet', {
            label: 'Add sheet',
            group: 'Spreadsheets',
            inputs: { spreadsheetId: spreadsheetField(), title: string({ title: 'Sheet name' }) },
            outputs: object({ sheetId: integer(), title: string(), index: integer() }),
            request: ({ inputs }) => ({
                method: 'POST',
                url: sheetUrl(inputs.spreadsheetId, ':batchUpdate'),
                body: { requests: [{ addSheet: { properties: { title: inputs.title } } }] }
            }),
            errors: ({ response }) => [
                notFound(response),
                {
                    when: expr`${response.status} == 400 && contains(default(${response.body.error.message}, ''), 'already exists')`,
                    error: 'validation',
                    field: 'title',
                    message: 'A sheet with that name already exists'
                }
            ],
            output: ({ response }) => expr`first(${response.body.replies}).addSheet.properties | pick('sheetId', 'title', 'index')`
        }),

        action('get-values', {
            label: 'Get rows',
            description: 'The values in a sheet or range — as objects keyed by the header row, or as plain lists.',
            group: 'Values',
            readOnly: true,
            inputs: {
                spreadsheetId: spreadsheetField(),
                sheet: sheetField(),
                range: string({ title: 'Range', description: 'A1 notation within the sheet, e.g. A1:D50. Default: the whole sheet.', placeholder: 'A1:D50' }).optional(),
                headerRow: boolean({ title: 'First row is a header', description: 'Return the other rows as objects keyed by it.', default: true }).optional(),
                formatted: boolean({ title: 'Formatted values', description: 'As shown in the sheet (“$1,000.00”) rather than raw (1000).', default: true, advanced: true }).optional()
            },
            // rows: header-keyed objects, or lists of cells with headerRow: false.
            outputs: object({ range: string(), headers: array(string()).optional(), rows: json<Record<string, unknown>[] | unknown[][]>({ type: 'array' }) }),
            request: ({ inputs }) => ({
                url: valuesUrl(inputs.spreadsheetId, inputs.sheet, inputs.range),
                query: { valueRenderOption: expr`${inputs.formatted} == false ? 'UNFORMATTED_VALUE' : 'FORMATTED_VALUE'`, majorDimension: 'ROWS' }
            }),
            errors: ({ response }) => [notFound(response), badRange(response)],
            output: ({ response, inputs }) =>
                expr`${inputs.headerRow} == false
                    ? {range: ${response.body.range}, rows: default(${response.body.values}, [])}
                    : {
                        range: ${response.body.range},
                        headers: default(first(default(${response.body.values}, [])), []),
                        rows: map(slice(default(${response.body.values}, []), 1), r => recordOf(first(${response.body.values}), r))
                    }`
        }),

        action('append-rows', {
            label: 'Append rows',
            description: 'Add rows below the last row of the table. Objects are matched to the header row; keys it lacks are ignored.',
            group: 'Values',
            inputs: { spreadsheetId: spreadsheetField(), sheet: sheetField(), rows: rowsInput, valueInputOption: valueInput.optional() },
            outputs: updateOutput,
            // Only rows given as objects need the header row.
            steps: ({ inputs, response }) => [
                {
                    name: 'header',
                    when: expr`some(${inputs.rows}, r => type(r) == 'object')`,
                    url: valuesUrl(inputs.spreadsheetId, inputs.sheet, '1:1'),
                    output: { headers: expr`default(first(default(${response.body.values}, [])), [])` }
                }
            ],
            request: ({ inputs, steps }) => ({
                method: 'POST',
                url: valuesUrl(inputs.spreadsheetId, inputs.sheet, undefined, ':append'),
                query: { valueInputOption: expr`default(${inputs.valueInputOption}, 'USER_ENTERED')`, insertDataOption: 'INSERT_ROWS' },
                body: { majorDimension: 'ROWS', values: expr`map(${inputs.rows}, r => rowOf(default(${steps.header.headers}, []), r))` }
            }),
            errors: ({ response }) => [notFound(response), badRange(response)],
            output: ({ response }) => ({
                spreadsheetId: response.body.spreadsheetId,
                updatedRange: response.body.updates.updatedRange,
                updatedRows: expr`default(${response.body.updates.updatedRows}, 0)`,
                updatedCells: expr`default(${response.body.updates.updatedCells}, 0)`
            })
        }),

        action('update-values', {
            label: 'Update cells',
            description: 'Write rows of values over a range, starting at its top-left cell.',
            group: 'Values',
            inputs: {
                spreadsheetId: spreadsheetField(),
                sheet: sheetField(),
                range: string({ title: 'Range', description: 'Where to write, in A1 notation — e.g. B2, or A2:C10.', placeholder: 'A2' }),
                rows: json<unknown[][]>({ type: 'array', title: 'Rows', description: 'A list of rows, each a list of cell values.', examples: [[['Ada', 36]]] }),
                valueInputOption: valueInput.optional()
            },
            outputs: updateOutput,
            request: ({ inputs }) => ({
                method: 'PUT',
                url: valuesUrl(inputs.spreadsheetId, inputs.sheet, inputs.range),
                query: { valueInputOption: expr`default(${inputs.valueInputOption}, 'USER_ENTERED')` },
                body: { majorDimension: 'ROWS', values: inputs.rows }
            }),
            errors: ({ response }) => [notFound(response), badRange(response, 'range')],
            output: ({ response }) => ({
                spreadsheetId: response.body.spreadsheetId,
                updatedRange: response.body.updatedRange,
                updatedRows: expr`default(${response.body.updatedRows}, 0)`,
                updatedCells: expr`default(${response.body.updatedCells}, 0)`
            })
        }),

        action('clear-values', {
            label: 'Clear cells',
            description: 'Empty the cells of a range (or the whole sheet), keeping their formatting.',
            group: 'Values',
            destructive: true,
            inputs: {
                spreadsheetId: spreadsheetField(),
                sheet: sheetField(),
                range: string({ title: 'Range', description: 'Default: the whole sheet.', placeholder: 'A2:D' }).optional()
            },
            outputs: object({ spreadsheetId: string(), clearedRange: string() }),
            request: ({ inputs }) => ({ method: 'POST', url: valuesUrl(inputs.spreadsheetId, inputs.sheet, inputs.range, ':clear'), body: {} }),
            errors: ({ response }) => [notFound(response), badRange(response)],
            output: ({ response }) => ({ spreadsheetId: response.body.spreadsheetId, clearedRange: response.body.clearedRange })
        }),

        pollTrigger('new-row', {
            label: 'New row',
            description: 'Fires for each row added below the last one seen, with its values keyed by the header row.',
            group: 'Triggers',
            readOnly: true,
            intervalSec: 120,
            inputs: { spreadsheetId: spreadsheetField(), sheet: sheetField() },
            outputs: object({ row: integer(), values: json<unknown[]>({ type: 'array' }), record: json<Record<string, unknown>>() }),
            // The header row and everything from the first unseen row, in one
            // call. Data starts on row 2; the cursor is the last row seen.
            request: ({ inputs, state }) => ({
                url: sheetUrl(inputs.spreadsheetId, '/values:batchGet'),
                query: {
                    ranges: expr`[a1(${inputs.sheet}, '1:1'), a1(${inputs.sheet}, 'A' + string(max([number(default(${state.cursor}, 1)), 1]) + 1) + ':ZZZ')]`,
                    majorDimension: 'ROWS'
                }
            }),
            items: ({ response, state }) =>
                expr`map(
                    default(${response.body.valueRanges}[1].values, []),
                    (r, i) => {
                        row: max([number(default(${state.cursor}, 1)), 1]) + 1 + i,
                        values: r,
                        record: recordOf(default(first(default(${response.body.valueRanges}[0].values, [])), []), r)
                    }
                )`,
            cursor: ({ response, state }) => expr`string(max([number(default(${state.cursor}, 1)), 1]) + length(default(${response.body.valueRanges}[1].values, [])))`,
            dedupeKey: ({ item }) => expr`string(${item.row})`,
            event: ({ item }) => item
        })
    ]
});
