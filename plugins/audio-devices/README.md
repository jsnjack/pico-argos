# Audio devices

An event-driven WirePlumber plugin showing the current default audio output and
microphone. Open its normal panel menu to switch either system default; the
selected device has GNOME's native dot ornament. A read-only Active applications
section shows up to three effective playback and microphone routes. A route that
differs from its system default is marked `not default`.

The plugin talks directly to the installed WirePlumber 0.5 GObject API. It does
not poll, change volume or mute state, or alter individual application routing.
Application names come from PipeWire stream properties, so a browser may be
identified as Firefox or WebRTC rather than as a specific tab or meeting.

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

The plugin reacts to device hotplug, default-node changes, and application-link
changes, emits a heartbeat every five seconds, and treats action IDs as
session-local. Opening its menu also requests a fresh authoritative snapshot.
If a device disappears before activation, the request fails safely and the
plugin emits another fresh snapshot. Routes that PipeWire explicitly marks
unavailable are omitted; routes with unknown availability remain visible.
