# VPN reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/vpn/`. It uses the
original NordVPN public status endpoint at
`https://web-api.nordvpn.com/v1/ips/info` by default. To use another HTTPS
endpoint returning a `protected` boolean and country field, set `statusUrl` in
the `plugins.vpn` object of `$XDG_CONFIG_HOME/pico-argos/config.json`:

```json
{
  "plugins": {
    "vpn": {
      "statusUrl": "https://web-api.nordvpn.com/v1/ips/info"
    }
  }
}
```

`statusUrl` is the only setting. pico-argos passes the object to the plugin as
JSON in the `PICO_ARGOS_CONFIG` environment variable; a URL that does not use
HTTPS or an unknown key fails the refresh with an error that names it.

A literal skull-and-crossbones glyph with monochrome text presentation (`☠︎`)
appears only while protected. It uses `text` with `appearance: "accent"`
instead of an icon-theme `icon` because GNOME's icon theme does not provide a
pirate symbol. The menu shows the country code and available city/country
details but deliberately omits the public IP address.
