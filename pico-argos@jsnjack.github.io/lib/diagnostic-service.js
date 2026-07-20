// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Session bus name owned by the diagnostic control interface. */
export const DIAGNOSTIC_BUS_NAME = 'org.gnome.Shell.Extensions.PicoArgos';

/** Object path exported by the diagnostic control interface. */
export const DIAGNOSTIC_OBJECT_PATH = '/org/gnome/Shell/Extensions/PicoArgos';

/** D-Bus interface name for diagnostic control. */
export const DIAGNOSTIC_INTERFACE = 'org.gnome.Shell.Extensions.PicoArgos.Diagnostics1';

/** Introspection XML for the version 1 diagnostic control interface. */
export const DIAGNOSTIC_INTERFACE_XML = `
<node>
  <interface name="${DIAGNOSTIC_INTERFACE}">
    <method name="GetSummary">
      <arg name="json" type="s" direction="out"/>
    </method>
    <method name="StartTrace">
      <arg name="durationSeconds" type="u" direction="in"/>
      <arg name="traceId" type="u" direction="out"/>
    </method>
    <method name="StopTrace"/>
    <method name="ResetSummary"/>
    <signal name="TraceReady">
      <arg name="traceId" type="u"/>
      <arg name="path" type="s"/>
    </signal>
  </interface>
</node>`;

const INVALID_ARGUMENT_ERROR = `${DIAGNOSTIC_INTERFACE}.Error.InvalidArgument`;
const BUSY_ERROR = `${DIAGNOSTIC_INTERFACE}.Error.Busy`;

/** Owns the lifecycle of the diagnostic session-bus object. */
export class DiagnosticService {
    constructor(actions, connection = Gio.DBus.session) {
        this._actions = actions;
        this._connection = connection;
        this._dbusImpl = null;
        this._ownerId = 0;
    }

    /** Exports the object and owns its well-known session-bus name. */
    enable() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(
            DIAGNOSTIC_INTERFACE_XML,
            this);
        this._dbusImpl.export(this._connection, DIAGNOSTIC_OBJECT_PATH);
        this._ownerId = this._connection.own_name(
            DIAGNOSTIC_BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null);
    }

    /** Returns the current bounded diagnostic summary document. */
    GetSummary() {
        return this._actions.getSummary();
    }

    /** Starts a trace or returns a versioned D-Bus error. */
    StartTraceAsync(durationSeconds, invocation) {
        if (durationSeconds < 1 || durationSeconds > 600) {
            invocation.return_dbus_error(
                INVALID_ARGUMENT_ERROR,
                'Trace duration must be between 1 and 600 seconds');
            return;
        }

        const traceId = this._actions.startTrace(durationSeconds);
        if (traceId === null) {
            invocation.return_dbus_error(
                BUSY_ERROR,
                'A diagnostic trace or export is already active');
            return;
        }

        invocation.return_value(GLib.Variant.new('(u)', [traceId]));
    }

    /** Stops the active trace, if any. */
    StopTrace() {
        this._actions.stopTrace();
    }

    /** Clears bounded summary counters and histograms. */
    ResetSummary() {
        this._actions.resetSummary();
    }

    /** Emits the completion signal after a trace export is ready. */
    emitTraceReady(traceId, path) {
        this._dbusImpl?.emit_signal(
            'TraceReady',
            GLib.Variant.new('(us)', [traceId, path]));
    }

    /** Unowns the bus name and removes the exported object. */
    destroy() {
        if (this._ownerId !== 0) {
            this._connection.unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._dbusImpl?.unexport();
        this._dbusImpl = null;
        this._actions = null;
        this._connection = null;
    }
}
