// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {
    DIAGNOSTIC_INTERFACE,
    DIAGNOSTIC_INTERFACE_XML,
} from './diagnostic-service.js';

const node = Gio.DBusNodeInfo.new_for_xml(DIAGNOSTIC_INTERFACE_XML);
const interfaceInfo = node.lookup_interface(DIAGNOSTIC_INTERFACE);

if (interfaceInfo === null)
    throw new Error('Diagnostic interface is missing from introspection XML');

const methodNames = interfaceInfo.methods.map(method => method.name);
const expectedMethods = ['GetSummary', 'StartTrace', 'StopTrace', 'ResetSummary'];
if (JSON.stringify(methodNames) !== JSON.stringify(expectedMethods))
    throw new Error(`Unexpected diagnostic methods: ${JSON.stringify(methodNames)}`);

if (interfaceInfo.signals[0]?.name !== 'TraceReady')
    throw new Error('TraceReady signal is missing from introspection XML');

print('ok - diagnostic D-Bus interface matches the version 1 contract');
