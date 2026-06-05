# PS4 PKG Sender

A Docker-ready web-based PS4 PKG sender built with Node.js, Express, Mustache, and Bootstrap.

It scans a folder for `.pkg` files, displays them in a clean web interface with game cover images, and sends install requests to a PS4 package installer API.

## Credits

This project is a fork of:

```text
https://github.com/justanormaldev/ps4-pkg-sender
```

Thanks to the original author for the base PS4 PKG sender project.

This fork adds a refreshed web UI, cover thumbnails, folder cover images, search/filtering, AJAX install requests, a missing-cover downloader, Docker-focused setup notes, and additional networking documentation.

## Features

- Browse PKG files grouped by folder
- Modern responsive web interface
- Game cover thumbnails for packages
- Folder headers use the first available game cover image from that folder
- Image preview modal for covers
- Search/filter packages
- Package, folder, and total size statistics
- Update the target PS4 IP address from the web UI
- Send install requests without leaving the page
- Download missing covers automatically when the filename/folder contains a `CUSAxxxxx` title ID
- Docker-ready setup
- Supports normal LAN setups and PPPwn/Raspberry Pi routed setups

## Screenshot

![PS4 PKG Sender homepage](screenshots/homepage.png)


## Requirements

- Docker and Docker Compose, or Node.js installed directly
- A PS4 running a compatible package installer/API on port `12800`
- A folder containing your `.pkg` files
- Optional cover images in `src/public/images`
- Internet access from the container/server if you want to use **Download missing covers**

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
    │       └── Example_Game_CUSA00000.jpg
    └── views
        ├── index.html
        └── css
            └── style.css
```

## Cover Images

Cover images are matched by filename.

For example:

```text
Alan_Wake_Remastered_CUSA24653.pkg
Alan_Wake_Remastered_CUSA24653.jpg
```

The `.jpg` cover should be placed in:

```text
src/public/images/
```

If no matching image is found, the UI falls back to:

```text
src/public/images/folder.png
```

Folder headers use the first available game cover image from that folder.

Example folder layout:

```text
/pkg_sender/files/
└── Alan_Wake_Remastered_CUSA24653
    └── Alan_Wake_Remastered_CUSA24653.pkg
```

Matching cover:

```text
src/public/images/Alan_Wake_Remastered_CUSA24653.jpg
```

## Download Missing Covers

The web UI includes a **Download missing covers** button.

It scans packages that do not have a matching `.jpg` image and tries to find a cover using the `CUSAxxxxx` title ID from the folder name or PKG filename.

Good filename examples:

```text
Alan_Wake_Remastered_CUSA24653.pkg
CUSA24653_Alan_Wake_Remastered.pkg
/files/Alan_Wake_Remastered_CUSA24653/Alan_Wake_Remastered_CUSA24653.pkg
```

The downloader checks:

1. The configured `COVER_MAP_URL`
2. A PlayStation Store fallback lookup using configured regions

If a cover is found, it is saved automatically into:

```text
src/public/images/
```

The webpage shows a result panel with downloaded, skipped, and failed covers.

## Environment Variables

| Variable | Example | Description |
|---|---|---|
| `PORT` | `7777` | Web server port |
| `STATIC_FILES` | `/pkg_sender/files` | Folder inside the container where your `.pkg` files are mounted |
| `LOCALIP` | `192.168.x.x` | The IP address of the machine running PKG Sender, as seen from the PS4. Use your own server/PC/NAS/Docker host IP. |
| `PS4IP` | `192.168.x.x` | The IP address of your PS4 package installer. Use the IP shown on your PS4 or the IP used by your PPPwn/GoldHEN setup. |
| `COVER_MAP_URL` | `https://raw.githubusercontent.com/hmn/ps4-imagemap/master/games.json` | Optional cover map URL used by the missing-cover downloader |
| `COVER_STORE_REGIONS` | `DK/da,GB/en,US/en,DE/de,SE/sv,NO/no` | Optional PlayStation Store fallback regions checked by the cover downloader |

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
      # Normal LAN example: 192.168.1.x
      # Some PPPwn setups: 192.168.2.2
      - PS4IP=192.168.x.x

      # Optional. Used by the "Download missing covers" button.
      - COVER_MAP_URL=https://raw.githubusercontent.com/hmn/ps4-imagemap/master/games.json
      - COVER_STORE_REGIONS=DK/da,GB/en,US/en,DE/de,SE/sv,NO/no

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

## Dockerfile

This project uses a multi-stage Dockerfile. Make sure the first stage is named `deps`:

```dockerfile
FROM node:20-alpine AS deps

WORKDIR /pkg_sender

COPY package.json ./

RUN npm install --omit=dev


FROM node:20-alpine

WORKDIR /pkg_sender

RUN apk --no-cache add curl

ENV NODE_ENV=production

COPY --from=deps /pkg_sender/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src

EXPOSE 7777

CMD ["npm", "start"]
```

The `AS deps` part is important. Without it, Docker may try to pull an image called `deps:latest`.

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
4. Folder headers use the first available cover image from that folder.
5. When you click **Install**, the app sends a request to:

```text
http://PS4IP:12800/api/install
```

with a package URL like:

```text
http://LOCALIP:PORT/pkgfiles/Game.pkg
```

6. The PS4 downloads the PKG directly from this server.

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

### Get Missing Covers

```http
GET /api/covers/missing
```

### Download Missing Covers

```http
POST /api/covers/download-missing
```

The response includes a summary and per-package result list.

## Troubleshooting

### Cover image does not show

Check that the image filename matches the PKG filename exactly, except for the extension:

```text
Game_Name_CUSA00000.pkg
Game_Name_CUSA00000.jpg
```

Also check that the image is located in:

```text
src/public/images/
```

### Folder image still shows the fallback

The folder image uses the first available cover image from that folder. If none of the packages in that folder have a matching `.jpg`, it will show `folder.png`.

Press **Download missing covers**, then reload the page.

### Download missing covers returns HTTP 200 but no images appear

HTTP `200` means the request succeeded. It does not always mean covers were downloaded.

Check the result panel on the webpage. Common reasons for skipped covers:

- No `CUSAxxxxx` ID found in the folder or filename
- The title ID was not found in the cover map
- The PlayStation Store fallback did not return an image for the configured regions
- The container has no internet access
- The images volume is not writable

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

### Docker build error: `deps:latest`

If you see an error like:

```text
failed to resolve source metadata for docker.io/library/deps:latest
```

make sure your Dockerfile starts with:

```dockerfile
FROM node:20-alpine AS deps
```

## Security Notes

This app is intended for trusted local networks.

Do not expose this service publicly to the internet. It can list and serve files from the configured `STATIC_FILES` directory and send install commands to your configured PS4 IP.
