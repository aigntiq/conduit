/** Specs as hosts see them: summaries and descriptions without request detail. */
import { authInputs } from '../spec/inputs';
import type { ConnectorSpec, OperationSpec } from '../spec/types';
import type { ConnectorDescription, ConnectorSummary, OperationDescription } from './types';

export function summary(spec: ConnectorSpec): ConnectorSummary {
    const s: ConnectorSummary = { id: spec.id, name: spec.name, version: spec.version };
    if (spec.description !== undefined) s.description = spec.description;
    if (spec.icon !== undefined) s.icon = spec.icon;
    if (spec.categories !== undefined) s.categories = spec.categories;
    return s;
}

export function describeOperation(spec: ConnectorSpec, o: OperationSpec): OperationDescription {
    return {
        id: o.id,
        kind: o.kind,
        label: o.label,
        ...(o.description === undefined ? {} : { description: o.description }),
        ...(o.inputs === undefined ? {} : { inputs: o.inputs }),
        ...(o.outputs === undefined ? {} : { outputs: o.outputs }),
        auth: o.auth === false ? false : (o.auth ?? (spec.auth ?? []).map((m) => m.id)),
        hidden: o.hidden ?? o.kind === 'options',
        ...(o.tags === undefined ? {} : { tags: o.tags }),
        ...(o.group === undefined ? {} : { group: o.group }),
        ...(o.destructive === undefined ? {} : { destructive: o.destructive }),
        ...(o.readOnly === undefined ? {} : { readOnly: o.readOnly })
    };
}

export function describe(spec: ConnectorSpec): ConnectorDescription {
    return {
        ...summary(spec),
        auth: (spec.auth ?? []).map((m) => ({
            id: m.id,
            type: m.type,
            label: m.label ?? m.id,
            ...(m.description === undefined ? {} : { description: m.description }),
            inputs: authInputs(m),
            redirect: m.type === 'oauth2' && (m.grant ?? 'authorization_code') === 'authorization_code'
        })),
        operations: spec.operations.map((o) => describeOperation(spec, o))
    };
}
