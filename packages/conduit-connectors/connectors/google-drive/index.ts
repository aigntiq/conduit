/**
 * Google Drive — find, read, download, upload, organise, share and trash
 * files.
 *
 * Drive search is a query language (`q`); the connector builds it from plain
 * fields and quotes every value. Google Docs, Sheets and Slides have no bytes
 * of their own: downloading one exports it (PDF by default). Uploading is two
 * calls — create the file's metadata, then send its bytes.
 */
import {
    $,
    action,
    array,
    boolean,
    connector,
    expr,
    file,
    integer,
    object,
    options,
    paging,
    pollTrigger,
    rules,
    search,
    select,
    string,
    text,
    when,
    type ErrorRuleDef,
    type Ref
} from '@aigntiq/conduit/builder';
import { googleOAuth, googleRetry, googleSetup } from '../_shared/google';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

const FOLDER = 'application/vnd.google-apps.folder';

/** Everything `fileOf` reads. */
const FILE_FIELDS = 'id,name,mimeType,parents,size,createdTime,modifiedTime,webViewLink,starred,trashed,description,owners(emailAddress)';

// ── Shared pieces ───────────────────────────────────────────────────────

const folderOptions = { operation: 'list-folders', search: 'query' };

const fileId = (title = 'File') => string({ title });

/** `/files/<id>[suffix]`, encoded. */
function fileUrl(id: Ref, suffix = '') {
    return $`/files/${expr`urlEncode(${id})`}${suffix}`;
}

/** Drive's shared-drive switches: without them, files in shared drives are invisible. */
const allDrives = { supportsAllDrives: true };

const fileOutput = object({
    id: string(),
    name: string(),
    mimeType: string(),
    folder: boolean(),
    googleDoc: boolean(),
    parents: array(string()),
    size: integer().optional(),
    createdTime: string().optional(),
    modifiedTime: string().optional(),
    webViewLink: string().optional(),
    starred: boolean().optional(),
    trashed: boolean().optional(),
    description: string().optional(),
    owner: string().optional()
});

const fileValue = object({ filename: string(), contentType: string(), base64: string(), size: integer() });

function notFound(response: Ref, field: string): ErrorRuleDef {
    return { when: expr`${response.status} == 404`, error: 'notFound', field, message: 'That file or folder does not exist, or is not shared with this account' };
}

// ── Connector ───────────────────────────────────────────────────────────

export default connector({
    id: 'google-drive',
    name: 'Google Drive',
    version: '1.0.0',
    description: 'Find, download, upload, organise, share and trash files in Google Drive.',
    categories: ['files', 'storage', 'productivity'],
    brandColor: '#1a73e8',
    homepage: 'https://drive.google.com',
    helpUrl: 'https://developers.google.com/drive/api',
    config: { baseUrl: 'https://www.googleapis.com/drive/v3', uploadUrl: 'https://www.googleapis.com/upload/drive/v3' },
    functions: {
        quote: {
            params: ['s'],
            description: 'A Drive query string literal: single-quoted, with quotes and backslashes escaped.',
            body: String.raw`"'" + replace(replace(string(s), "\\", "\\\\"), "'", "\\'") + "'"`
        },
        fileOf: {
            params: ['f'],
            description: 'A Drive file, flattened.',
            body: `{
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                folder: f.mimeType == '${FOLDER}',
                googleDoc: startsWith(default(f.mimeType, ''), 'application/vnd.google-apps.') && f.mimeType != '${FOLDER}',
                parents: default(f.parents, []),
                size: f.size == undefined ? undefined : number(f.size),
                createdTime: f.createdTime,
                modifiedTime: f.modifiedTime,
                webViewLink: f.webViewLink,
                starred: f.starred,
                trashed: f.trashed,
                description: f.description,
                owner: first(default(f.owners, []))?.emailAddress
            } | compactObject`
        },
        textOf: {
            params: ['body'],
            description: 'A response body as text — also when it arrived as bytes (downloads read even errors as bytes).',
            body: "body == undefined ? '' : fromBase64(base64(body))"
        },
        exportMime: {
            params: ['format'],
            description: 'The MIME type Drive exports a Google Doc, Sheet or Slides file to.',
            body: `get({
                pdf: 'application/pdf',
                docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                csv: 'text/csv',
                txt: 'text/plain',
                html: 'text/html'
            }, default(format, 'pdf'))`
        }
    },
    http: ({ config }) => ({
        baseUrl: config.baseUrl,
        headers: { Accept: 'application/json' },
        retry: googleRetry
    }),
    auth: [
        googleOAuth(({ response }) => ({
            scopes: SCOPES,
            identity: {
                request: { url: '/about', query: { fields: 'user' } },
                id: response.body.user.emailAddress,
                name: expr`default(${response.body.user.displayName}, ${response.body.user.emailAddress})`
            },
            test: { url: '/about', query: { fields: 'user' } },
            helpUrl: 'https://developers.google.com/drive/api/guides/api-specific-auth',
            setup: googleSetup('Google Drive API', 'google-drive', SCOPES, [
                '`drive` is a *restricted* scope: apps used beyond your own test users need Google verification (and a security assessment).'
            ])
        }))
    ],
    operations: [
        search('search-files', {
            label: 'Search files',
            description: 'Files and folders by name, folder and type — or with a raw Drive query.',
            group: 'Files',
            readOnly: true,
            inputs: {
                name: string({ title: 'Name contains' }).optional(),
                folderId: string({ title: 'In folder', options: folderOptions }).optional(),
                type: select(
                    { folder: 'Folders', document: 'Google Docs', spreadsheet: 'Google Sheets', presentation: 'Google Slides', pdf: 'PDFs', image: 'Images' },
                    { title: 'Type' }
                ).optional(),
                query: string({ title: 'Drive query', description: 'Added with "and", e.g. modifiedTime > \'2026-01-01T00:00:00\'', advanced: true }).optional(),
                includeTrashed: boolean({ title: 'Include trashed files', default: false, advanced: true }).optional()
            },
            outputs: array(fileOutput),
            request: ({ inputs }) => ({
                url: '/files',
                query: {
                    q: expr`compact([
                        isEmpty(${inputs.name}) ? undefined : 'name contains ' + quote(${inputs.name}),
                        isEmpty(${inputs.folderId}) ? undefined : quote(${inputs.folderId}) + ' in parents',
                        ${inputs.type} == 'image' ? "mimeType contains 'image/'"
                            : isEmpty(${inputs.type}) ? undefined
                            : 'mimeType = ' + quote(get({folder: ${FOLDER}, document: 'application/vnd.google-apps.document', spreadsheet: 'application/vnd.google-apps.spreadsheet', presentation: 'application/vnd.google-apps.presentation', pdf: 'application/pdf'}, ${inputs.type})),
                        ${inputs.includeTrashed} ? undefined : 'trashed = false',
                        isEmpty(${inputs.query}) ? undefined : '(' + ${inputs.query} + ')'
                    ]) | join(' and ')`,
                    fields: `nextPageToken,files(${FILE_FIELDS})`,
                    orderBy: 'folder,modifiedTime desc',
                    pageSize: 100,
                    includeItemsFromAllDrives: true,
                    ...allDrives
                }
            }),
            errors: ({ response }) => [
                {
                    // Drive says only "Invalid Value", locating the problem at `q`.
                    when: expr`${response.status} == 400 && some(default(${response.body.error.errors}, []), e => e.location == 'q')`,
                    error: 'validation',
                    field: 'query',
                    message: 'The Drive query is not valid'
                }
            ],
            paginate: ({ response }) => paging.cursor({ param: 'pageToken', items: response.body.files, next: response.body.nextPageToken, maxPages: 50 }),
            output: ({ items }) => expr`${items} | map(f => fileOf(f))`
        }),

        action('get-file', {
            label: 'Get file details',
            group: 'Files',
            readOnly: true,
            inputs: { fileId: fileId() },
            outputs: fileOutput,
            request: ({ inputs }) => ({ url: fileUrl(inputs.fileId), query: { fields: FILE_FIELDS, ...allDrives } }),
            errors: ({ response }) => [notFound(response, 'fileId')],
            output: ({ response }) => expr`fileOf(${response.body})`
        }),

        action('download-file', {
            label: 'Download file',
            description: 'The file’s contents as a file value. Google Docs, Sheets and Slides are exported — as PDF unless another format is chosen.',
            group: 'Files',
            readOnly: true,
            inputs: {
                fileId: fileId(),
                exportAs: select(
                    { pdf: 'PDF', docx: 'Word (.docx)', xlsx: 'Excel (.xlsx)', pptx: 'PowerPoint (.pptx)', csv: 'CSV (first sheet)', txt: 'Plain text', html: 'HTML' },
                    { title: 'Export Google files as', default: 'pdf', advanced: true }
                ).optional()
            },
            outputs: fileValue,
            steps: ({ inputs, response }) => [
                {
                    name: 'meta',
                    url: fileUrl(inputs.fileId),
                    query: { fields: 'id,name,mimeType', ...allDrives },
                    output: {
                        name: response.body.name,
                        mimeType: response.body.mimeType,
                        google: expr`startsWith(default(${response.body.mimeType}, ''), 'application/vnd.google-apps.')`
                    }
                }
            ],
            request: ({ inputs, steps }) => ({
                url: $`/files/${expr`urlEncode(${inputs.fileId})`}${expr`${steps.meta.google} ? '/export' : ''`}`,
                query: {
                    mimeType: expr`${steps.meta.google} ? exportMime(${inputs.exportAs}) : undefined`,
                    alt: expr`${steps.meta.google} ? undefined : 'media'`,
                    ...allDrives
                },
                responseType: 'binary'
            }),
            errors: ({ response }) => [
                notFound(response, 'fileId'),
                {
                    when: expr`${response.status} == 403 && contains(textOf(${response.body}), 'exportSizeLimitExceeded')`,
                    error: 'validation',
                    field: 'fileId',
                    message: 'The file is too large to export (Google’s limit is 10 MB)'
                },
                {
                    when: expr`${response.status} == 400 || (${response.status} == 403 && contains(textOf(${response.body}), 'fileNotDownloadable'))`,
                    error: 'validation',
                    field: 'exportAs',
                    message: 'This file cannot be downloaded in that format'
                }
            ],
            output: ({ response, steps, inputs }) => ({
                filename: expr`${steps.meta.google} && !endsWith(lower(${steps.meta.name}), '.' + default(${inputs.exportAs}, 'pdf'))
                    ? ${steps.meta.name} + '.' + default(${inputs.exportAs}, 'pdf')
                    : ${steps.meta.name}`,
                contentType: expr`${steps.meta.google} ? exportMime(${inputs.exportAs}) : default(${steps.meta.mimeType}, 'application/octet-stream')`,
                base64: expr`base64(${response.body})`,
                size: expr`length(${response.body})`
            })
        }),

        action('upload-file', {
            label: 'Upload file',
            description: 'Put a file in Drive, in a folder of your choice.',
            group: 'Files',
            inputs: {
                file: file({ title: 'File', maxBytes: 100_000_000 }),
                folderId: string({ title: 'Folder', description: 'Default: My Drive.', options: folderOptions }).optional(),
                name: string({ title: 'Name', description: 'Default: the file’s own name.' }).optional(),
                description: text({ title: 'Description', advanced: true }).optional()
            },
            outputs: fileOutput,
            // 1. Create the file with its metadata; 2. send the bytes to it.
            steps: ({ inputs, response }) => [
                {
                    name: 'created',
                    method: 'POST',
                    url: '/files',
                    query: { fields: 'id', ...allDrives },
                    body: {
                        name: expr`default(${inputs.name}, ${inputs.file.filename})`,
                        parents: expr`isEmpty(${inputs.folderId}) ? undefined : [${inputs.folderId}]`,
                        mimeType: inputs.file.contentType,
                        description: inputs.description
                    },
                    output: { id: response.body.id }
                }
            ],
            request: ({ inputs, steps, config }) => ({
                method: 'PATCH',
                url: $`${config.uploadUrl}/files/${expr`urlEncode(${steps.created.id})`}`,
                query: { uploadType: 'media', fields: FILE_FIELDS, ...allDrives },
                headers: { 'Content-Type': expr`default(${inputs.file.contentType}, 'application/octet-stream')` },
                body: inputs.file.base64,
                encoding: 'binary'
            }),
            errors: ({ response }) => [notFound(response, 'folderId')],
            output: ({ response }) => expr`fileOf(${response.body})`
        }),

        action('create-folder', {
            label: 'Create folder',
            group: 'Folders',
            inputs: {
                name: string({ title: 'Name' }),
                parentId: string({ title: 'Inside folder', description: 'Default: My Drive.', options: folderOptions }).optional()
            },
            outputs: fileOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: '/files',
                query: { fields: FILE_FIELDS, ...allDrives },
                body: { name: inputs.name, mimeType: FOLDER, parents: expr`isEmpty(${inputs.parentId}) ? undefined : [${inputs.parentId}]` }
            }),
            errors: ({ response }) => [notFound(response, 'parentId')],
            output: ({ response }) => expr`fileOf(${response.body})`
        }),

        action('update-file', {
            label: 'Rename, move or star',
            description: 'Change a file’s name, folder, description or star; only the fields given.',
            group: 'Files',
            inputs: {
                fileId: fileId('File or folder'),
                name: string({ title: 'New name' }).optional(),
                moveTo: string({ title: 'Move to folder', options: folderOptions }).optional(),
                description: text({ title: 'Description' }).optional(),
                starred: boolean({ title: 'Starred' }).optional()
            },
            rules: [rules.atLeastOne(['name', 'moveTo', 'description', 'starred'], 'Choose something to change')],
            outputs: fileOutput,
            // Moving needs the current parents, to remove them.
            steps: ({ inputs, response }) => [
                {
                    name: 'current',
                    when: expr`!isEmpty(${inputs.moveTo})`,
                    url: fileUrl(inputs.fileId),
                    query: { fields: 'parents', ...allDrives },
                    output: { parents: expr`default(${response.body.parents}, []) | join(',')` }
                }
            ],
            request: ({ inputs, steps }) => ({
                method: 'PATCH',
                url: fileUrl(inputs.fileId),
                query: {
                    addParents: expr`isEmpty(${inputs.moveTo}) ? undefined : ${inputs.moveTo}`,
                    removeParents: expr`isEmpty(${inputs.moveTo}) || isEmpty(${steps.current.parents}) ? undefined : ${steps.current.parents}`,
                    fields: FILE_FIELDS,
                    ...allDrives
                },
                body: { name: inputs.name, description: inputs.description, starred: inputs.starred }
            }),
            errors: ({ response }) => [notFound(response, 'fileId')],
            output: ({ response }) => expr`fileOf(${response.body})`
        }),

        action('copy-file', {
            label: 'Copy file',
            group: 'Files',
            inputs: {
                fileId: fileId(),
                name: string({ title: 'Name of the copy', description: 'Default: "Copy of …".' }).optional(),
                folderId: string({ title: 'Into folder', description: 'Default: the same folder.', options: folderOptions }).optional()
            },
            outputs: fileOutput,
            request: ({ inputs }) => ({
                method: 'POST',
                url: fileUrl(inputs.fileId, '/copy'),
                query: { fields: FILE_FIELDS, ...allDrives },
                body: { name: inputs.name, parents: expr`isEmpty(${inputs.folderId}) ? undefined : [${inputs.folderId}]` }
            }),
            errors: ({ response }) => [notFound(response, 'fileId')],
            output: ({ response }) => expr`fileOf(${response.body})`
        }),

        action('share-file', {
            label: 'Share file',
            description: 'Give a person, a group, a whole domain or anyone with the link access to a file or folder.',
            group: 'Sharing',
            inputs: {
                fileId: fileId('File or folder'),
                type: select({ user: 'A person', group: 'A group', domain: 'Everyone in a domain', anyone: 'Anyone with the link' }, { title: 'Share with', default: 'user' }).optional(),
                emailAddress: string({
                    title: 'Email address',
                    format: 'email',
                    visibleWhen: when.in('type', ['user', 'group', undefined]),
                    requiredWhen: when.in('type', ['user', 'group', undefined])
                }).optional(),
                domain: string({ title: 'Domain', placeholder: 'example.com', visibleWhen: when.equals('type', 'domain'), requiredWhen: when.equals('type', 'domain') }).optional(),
                role: select({ reader: 'Viewer', commenter: 'Commenter', writer: 'Editor' }, { title: 'Access', default: 'reader' }).optional(),
                notify: boolean({ title: 'Send an email', default: true, visibleWhen: when.in('type', ['user', 'group', undefined]) }).optional(),
                message: text({ title: 'Message', visibleWhen: when.equals('notify', true), advanced: true }).optional()
            },
            outputs: object({ permissionId: string(), type: string(), role: string() }),
            request: ({ inputs }) => ({
                method: 'POST',
                url: fileUrl(inputs.fileId, '/permissions'),
                query: {
                    sendNotificationEmail: expr`contains(['user', 'group'], default(${inputs.type}, 'user')) ? default(${inputs.notify}, true) : undefined`,
                    emailMessage: inputs.message,
                    ...allDrives
                },
                body: {
                    type: expr`default(${inputs.type}, 'user')`,
                    role: expr`default(${inputs.role}, 'reader')`,
                    emailAddress: inputs.emailAddress,
                    domain: inputs.domain
                }
            }),
            errors: ({ response }) => [
                notFound(response, 'fileId'),
                {
                    when: expr`${response.status} == 400 && contains(lower(default(${response.body.error.message}, '')), 'email')`,
                    error: 'validation',
                    field: 'emailAddress',
                    message: 'Drive cannot share with that address'
                }
            ],
            output: ({ response }) => ({ permissionId: response.body.id, type: response.body.type, role: response.body.role })
        }),

        action('trash-file', {
            label: 'Move to trash',
            description: 'Moves the file or folder (with everything in it) to the trash. Drive deletes trashed files after 30 days.',
            group: 'Files',
            destructive: true,
            inputs: { fileId: fileId('File or folder') },
            outputs: fileOutput,
            request: ({ inputs }) => ({ method: 'PATCH', url: fileUrl(inputs.fileId), query: { fields: FILE_FIELDS, ...allDrives }, body: { trashed: true } }),
            errors: ({ response }) => [notFound(response, 'fileId')],
            output: ({ response }) => expr`fileOf(${response.body})`
        }),

        options('list-folders', {
            label: 'Folders',
            readOnly: true,
            inputs: { query: string({ title: 'Search' }).optional() },
            request: ({ inputs }) => ({
                url: '/files',
                query: {
                    q: expr`'mimeType = ' + quote(${FOLDER}) + ' and trashed = false' + (isEmpty(${inputs.query}) ? '' : ' and name contains ' + quote(${inputs.query}))`,
                    fields: 'nextPageToken,files(id,name)',
                    orderBy: 'name',
                    pageSize: 1000,
                    includeItemsFromAllDrives: true,
                    ...allDrives
                }
            }),
            paginate: ({ response }) => paging.cursor({ param: 'pageToken', items: response.body.files, next: response.body.nextPageToken, maxPages: 5 }),
            // My Drive's root has no folder entry of its own; `root` names it.
            output: ({ items, inputs }) => expr`concat(isEmpty(${inputs.query}) ? [{label: 'My Drive', value: 'root'}] : [], map(${items}, f => {label: f.name, value: f.id}))`
        }),

        pollTrigger('new-file', {
            label: 'New file',
            description: 'Fires for each file created (or uploaded) after the trigger is turned on — in one folder, or anywhere.',
            group: 'Triggers',
            readOnly: true,
            intervalSec: 120,
            inputs: { folderId: string({ title: 'In folder', description: 'Default: anywhere.', options: folderOptions }).optional() },
            outputs: fileOutput,
            request: ({ inputs, state }) => ({
                url: '/files',
                query: {
                    q: expr`compact([
                        'createdTime >= ' + quote(default(${state.cursor}, now())),
                        'mimeType != ' + quote(${FOLDER}),
                        'trashed = false',
                        isEmpty(${inputs.folderId}) ? undefined : quote(${inputs.folderId}) + ' in parents'
                    ]) | join(' and ')`,
                    fields: `files(${FILE_FIELDS})`,
                    orderBy: 'createdTime',
                    pageSize: 100,
                    includeItemsFromAllDrives: true,
                    ...allDrives
                }
            }),
            items: ({ response }) => expr`default(${response.body.files}, [])`,
            // Inclusive (>=): files sharing the newest createdTime aren't skipped;
            // the repeat is dropped by dedupeKey.
            cursor: ({ response, state }) => expr`default(last(default(${response.body.files}, []))?.createdTime, ${state.cursor})`,
            dedupeKey: ({ item }) => item.id,
            event: ({ item }) => expr`fileOf(${item})`
        })
    ]
});
