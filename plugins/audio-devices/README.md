# Audio devices

An event-driven WirePlumber plugin showing the current default audio output and
microphone. Open its normal panel menu to switch either system default; the
selected device has GNOME's native dot ornament.

The plugin talks directly to the installed WirePlumber 0.5 GObject API. It
does not poll, change volume or mute state, or alter individual application
routing.

The panel names only a class that offers a real choice. With exactly one output
or one microphone that name is dropped and the icon carries the plugin, so a
typical desktop shows an icon and at most one name.

A card that exposes several ports for one device is named by its active port
("Line Out", "Headphones"), because the connector is what distinguishes the
alternatives. A card that exposes exactly one keeps its device name, which is
the more specific identity there — an HDMI card reports the connected monitor,
while its only port is always called "HDMI / DisplayPort". Port names come from
`pw-dump`, run once per device change, because GJS cannot read WirePlumber's
route parameters; without that binary every device falls back to its device
name.

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
