# VPN reference plugin

Copy this directory to `$XDG_CONFIG_HOME/pico-argos/plugins/vpn/`. It uses the
original NordVPN public status endpoint at
`https://web-api.nordvpn.com/v1/ips/info` by default; set `VPN_STATUS_URL` to
another HTTPS endpoint returning a `protected` boolean and country field.

A literal skull-and-crossbones glyph with monochrome text presentation (`☠︎`)
appears only while protected. It uses `text` with `appearance: "accent"`
instead of an icon-theme `icon` because GNOME's icon theme does not provide a
pirate symbol. The menu shows the country code and available city/country
details but deliberately omits the public IP address.
