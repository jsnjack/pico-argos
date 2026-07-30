# Audio devices

An event-driven WirePlumber plugin showing the current default audio output and
microphone. Open its normal panel menu to switch either system default; the
selected device has GNOME's native dot ornament.

The plugin talks directly to the installed WirePlumber 0.5 GObject API. It
does not poll, invoke `wpctl`, change volume or mute state, or alter individual
application routing.

## Configuration

Configuration is optional. Copy `config.example.json` to:

```text
$XDG_CONFIG_HOME/pico-argos/audio-devices.json
```

`maxPanelNameChars` bounds each current device name to 6–48 characters.
`aliases` maps exact PipeWire `node.name` values to concise panel/menu names.
Use `wpctl status -n` to inspect node names.

The plugin reacts to device hotplug and default-node changes, emits a heartbeat
every five seconds, and treats action IDs as session-local. If a device
disappears before activation, the request fails safely and the plugin emits a
fresh authoritative snapshot.
