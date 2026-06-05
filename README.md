# PS4 PKG Sender

A small web-based PS4 PKG sender built with Node.js, Express, Mustache, and Bootstrap.

It scans a folder for `.pkg` files, displays them in a clean web interface with game cover images, and sends install requests to a PS4 package installer API.

## Credits

This project is a fork of:

```text
https://github.com/justanormaldev/ps4-pkg-sender
```

Thanks to the original author for the base PS4 PKG sender project.

This fork adds a refreshed web UI, cover thumbnails, folder cover images, search/filtering, AJAX install requests, Docker-focused setup notes, and additional networking documentation.

## Features

- Browse PKG files grouped by folder
- Modern responsive web interface
- Game cover thumbnails for packages
- Folder headers use the first game cover image from that folder
- Image preview modal for covers
- Search/filter packages
- Package, folder, and total size statistics
- Update the target PS4 IP address from the web UI
- Send install requests without leaving the page
- Docker-ready setup

## Screenshot

![PS4 PKG Sender homepage](screenshots/homepage.png)

## Requirements

- Docker and Docker Compose, or Node.js installed directly
- A PS4 running a compatible package installer/API on port `12800`
- A folder containing your `.pkg` files
- Optional cover images in `src/public/images`

## Folder Structure

```text
.
├── Dockerfile
├── package.json
├── screenshots
│   └── homepage.png
└── src
    ├── app.js
    ├── public
    │   └── images
    │       ├── folder.png
    │       └── Example_Game.jpg
    └── views
        ├── index.html
        └── css
            └── style.css
```

## Cover Images

Cover images are matched by filename.

For example:

```text
Example_Game.pkg
Example_Game.jpg
```

The `.jpg` cover should be placed in:

```text
src/public/images/
```

If no matching image is found, the UI falls back to:

```text
src/public/images/folder.png
```

Folder headers use the first PKG cover image from that folder.

## Environment Variables

| Variable | Example | Description |
|---|---|---|
| `PORT` | `7777` | Web server port |
| `STATIC_FILES` | `/pkg_sender/files` | Folder inside the container where your `.pkg` files are mounted |
| `LOCALIP` | `192.168.x.x` | The IP address of the machine running PKG Sender, as seen from the PS4. Use your own server/PC/NAS IP, for example the LAN IP of your Docker host. |
| `PS4IP` | `192.168.x.x` | The IP address of your PS4 package installer. Use the IP shown on your PS4 or the IP used by your PPPwn/GoldHEN setup. |

### How to choose `LOCALIP` and `PS4IP`

`LOCALIP` and `PS4IP` are different:

```text
LOCALIP = where the PS4 downloads the PKG from
PS4IP   = where PKG Sender sends the install command
```

Example with a normal LAN setup:

```text
Server running PKG Sender: 192.168.1.50
PS4:                       192.168.1.80
```

Then use:

```env
LOCALIP=192.168.1.50
PS4IP=192.168.1.80
```

Example with a PPPwn/Raspberry Pi setup:

```text
Server running PKG Sender: 192.168.1.50
PS4 behind PPPwn:          192.168.2.2
```

Then use:

```env
LOCALIP=192.168.1.50
PS4IP=192.168.2.2
```

The exact IP addresses must be changed to match your own network.

## Docker Compose Example

```yaml
services:
  pkgsender:
    container_name: pkgsender
    build: .
    ports:
      - "7777:7777"
    environment:
      - PORT=7777
      - STATIC_FILES=/pkg_sender/files

      # Change this to the IP address of your server/Docker host.
      # The PS4 must be able to reach this IP and port 7777.
      - LOCALIP=192.168.x.x

      # Change this to your PS4 IP address.
      # For normal LAN this may be 192.168.1.x.
      # For some PPPwn setups this may be 192.168.2.2.
      - PS4IP=192.168.x.x

    volumes:
      - /path/to/your/pkg/files:/pkg_sender/files
      - ./src/public/images:/pkg_sender/src/public/images
    restart: unless-stopped
```

Then start it:

```bash
docker compose up -d --build
```

Open the webpage:

```text
http://SERVER_IP:7777
```

## Run Without Docker

Install dependencies:

```bash
npm install
```

Start the server:

```bash
PORT=7777 \
STATIC_FILES=/path/to/pkg/files \
LOCALIP=192.168.x.x \
PS4IP=192.168.x.x \
npm start
```

Replace both IP addresses with your own values.

## How It Works

1. The server scans `STATIC_FILES` recursively for `.pkg` files.
2. Packages are grouped by their top-level folder.
3. The web UI displays each folder and package.
4. When you click **Install**, the app sends a request to:

```text
http://PS4IP:12800/api/install
```

with a package URL like:

```text
http://LOCALIP:PORT/pkgfiles/Game.pkg
```

5. The PS4 downloads the PKG directly from this server.

## Important Networking Notes

`LOCALIP` must be reachable from the PS4.

For example, if your PS4 is on `192.168.2.2` behind a Raspberry Pi PPPwn setup, make sure routing/NAT allows the PS4 to reach the server IP used in `LOCALIP`.

If the install request is sent but the PS4 cannot download the package, check:

- `LOCALIP`
- firewall rules
- Docker network routing
- PS4 route to the server
- whether port `7777` is reachable from the PS4

## API Endpoints

### Get Current PS4 IP

```http
GET /api/ps4ip
```

Response:

```json
{
  "variable": "192.168.x.x"
}
```

### Update PS4 IP

```http
POST /api/ps4ip
Content-Type: application/json

{
  "newPS4ipadr": "192.168.x.x"
}
```

### Send Install Request

```http
POST /install
Content-Type: application/x-www-form-urlencoded

filepath=/pkg_sender/files/Game.pkg
```

## Troubleshooting

### Cover image does not show

Check that the image filename matches the PKG filename exactly, except for the extension:

```text
Game_Name.pkg
Game_Name.jpg
```

Also check that the image is located in:

```text
src/public/images/
```

### Install request fails

Check that the PS4 package installer is available:

```bash
curl -v http://PS4IP:12800/api/install
```

The endpoint may return an error for a browser-style GET request, but it should connect.

### PS4 cannot download the PKG

Check that this URL works from a device on the same route as the PS4:

```text
http://LOCALIP:7777/pkgfiles/YourGame.pkg
```

### Docker container cannot reach the PS4

Test from inside the container:

```bash
docker exec -it pkgsender sh
ping PS4IP
```

If the host can ping the PS4 but the container cannot, check Docker networking, routes, NAT, and firewall rules.

## Security Notes

This app is intended for trusted local networks.

Do not expose this service publicly to the internet. It can list and serve files from the configured `STATIC_FILES` directory and send install commands to your configured PS4 IP.

