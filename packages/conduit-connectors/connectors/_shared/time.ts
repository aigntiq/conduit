/**
 * Time inputs calendar connectors share.
 *
 * Not a connector — `_shared` has no `index.ts`, so the generator and the
 * build skip it.
 */
import { string } from '@aigntiq/conduit/builder';

/**
 * A start or end: a date-time, or a plain date for all-day events. Shown as a
 * date-time picker; validated loosely because `datetime()` refuses a date.
 */
export const moment = (options: { title: string; description?: string; group?: string }) =>
    string({
        ...options,
        widget: 'datetime',
        // A date, or an RFC 3339 date-time with its offset (seconds and fraction optional):
        // without one, the default end would depend on the server's zone.
        pattern: String.raw`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$`,
        messages: { pattern: 'Use a date (2026-05-04) or a date and time with its offset (2026-05-04T09:00:00+02:00)' }
    });
