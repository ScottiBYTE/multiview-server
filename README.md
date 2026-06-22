# ScottiBYTE MultiView Server

Self-hosted camera gateway for the ScottiBYTE MultiView Android TV / Fire TV client.

ScottiBYTE MultiView Server lets you define RTSP camera sources in a web interface, organize cameras into groups, publish TV-friendly HLS streams through MediaMTX, and securely pair Android TV / Fire TV clients without exposing camera usernames or passwords to the TV device.

![ScottiBYTE MultiView Server Cameras](screenshots/02-cameras.png)

## Why MultiView Server Exists

Modern IP cameras commonly use high resolutions, high bitrates, and RTSP streams that are not always friendly to low-power TV devices. Trying to display many full-motion camera streams directly on a Fire TV or Android TV device can quickly overload the client.

ScottiBYTE MultiView uses a client/server design:

- The server stores camera definitions and RTSP connection details.
- The server publishes camera streams as HLS through MediaMTX.
- The TV client pairs securely with the server.
- The TV client receives a camera catalog and HLS playback URLs.
- Camera credentials stay on the self-hosted server.

## Features

- Web-based camera configuration
- RTSP camera input support
- HLS stream publishing through MediaMTX
- Camera groups
- Server-approved TV client pairing
- Read-only TV client camera catalog API
- Dashboard with server and stream status
- Stream engine status page
- Automatic thumbnail refresh
- Light and dark mode
- Docker-friendly deployment

## Screenshots

### Dashboard

![Dashboard](screenshots/01-dashboard.png)

### Cameras

![Cameras](screenshots/02-cameras.png)

### Groups

![Groups](screenshots/03-groups.png)

### Stream Engine

![Stream Engine](screenshots/04-stream-engine.png)

### TV Clients

![TV Clients](screenshots/05-tv-clients.png)

## Architecture

    IP Cameras / RTSP
            |
            v
    ScottiBYTE MultiView Server
            |
            | HLS streams through MediaMTX
            v
    Android TV / Fire TV MultiView Client

The TV client does not need camera usernames or passwords. It pairs with the server and receives only the approved camera catalog and playback URLs.

## Quick Start

Clone the repository for the Docker Compose file, MediaMTX configuration, and example environment file:

    git clone https://github.com/ScottiBYTE/multiview-server.git
    cd multiview-server

Create your local environment file:

    cp .env.example .env
    nano .env

Start the server stack:

    docker compose up -d

The default Compose file uses the published Docker Hub image:

    scottibyte/multiview-server:latest

Open the web UI:

    http://SERVER-IP:8080

On first launch, create the administrator account, then use the web interface to add cameras, groups, and TV clients.

## Docker Image

Pull the current image:

    docker pull scottibyte/multiview-server:latest

Specific version:

    docker pull scottibyte/multiview-server:1.2.0

## Local Development Build

For local development, edit docker-compose.yml, comment the image line, and uncomment:

    build: .

Then rebuild:

    docker compose build --no-cache multiview-server
    docker compose up -d

## Example .env

    TZ=America/Chicago

    MULTIVIEW_PUBLIC_URL=http://SERVER-IP:8080

    MEDIAMTX_API_BASE=http://127.0.0.1:9997
    MEDIAMTX_HLS_BASE=http://SERVER-IP:8888

## Adding Cameras

Cameras are added from the server web UI.

Open the **Cameras** page and add each camera with:

- Camera name
- Group
- RTSP URL
- Enabled / disabled status
- Optional display and stream settings

The server stores the camera configuration locally under its runtime data directory. Runtime data is intentionally excluded from Git so real camera URLs and credentials are not published.

## Camera Groups

Use the **Groups** page to organize cameras into logical collections such as:

- Exterior
- Interior
- Garage
- Driveway
- Front Door
- Backyard

Groups help organize the camera catalog presented to the Android TV / Fire TV client.

## Thumbnail Refresh

Camera thumbnails are refreshed automatically by the server environment. The server uses the published HLS streams to capture still images for the camera list and TV client catalog.

A helper script is included for environments that want to run or troubleshoot thumbnail refresh manually:

    scripts/refresh-thumbnails.sh

Most users should not need to run this script directly. It is provided as a maintenance and troubleshooting utility.

If needed, it can be run manually:

    ./scripts/refresh-thumbnails.sh

Optional environment overrides:

    MEDIAMTX_HLS_BASE=http://SERVER-IP:8888 ./scripts/refresh-thumbnails.sh
    MULTIVIEW_THUMB_DIR=/custom/thumb/path ./scripts/refresh-thumbnails.sh

## TV Client Pairing

1. Install the ScottiBYTE MultiView TV client on Android TV or Fire TV.
2. Enter the MultiView Server URL.
3. The TV client displays a pairing code.
4. Open the MultiView Server web UI.
5. Go to **TV Clients**.
6. Approve the pending pairing request.
7. The TV client receives its authorization and loads the camera catalog.

TV clients receive read-only access to the camera catalog API. They do not receive admin credentials or raw camera passwords.

## Reverse Proxy

The server can be placed behind a reverse proxy such as Nginx Proxy Manager, Caddy, Traefik, or another HTTPS proxy.

Example public or internal URL:

    https://multiview-server.example.com

Use that URL as `MULTIVIEW_PUBLIC_URL` and as the server URL entered in the TV client.

## Security Model

ScottiBYTE MultiView is designed so camera credentials remain on the self-hosted server.

- RTSP camera usernames and passwords are entered and stored on the server.
- Android TV / Fire TV clients do not receive raw RTSP URLs or camera passwords.
- TV clients must be paired and approved from the server web UI.
- Approved TV clients receive read-only access to the camera catalog and HLS playback URLs.
- Client access can be revoked from the **TV Clients** page.

For best results, keep camera RTSP streams and MediaMTX HLS endpoints on a trusted private network or behind your own reverse proxy.

## Related Project

- ScottiBYTE MultiView Android TV / Fire TV Client: https://github.com/ScottiBYTE/multiview-android-tv

## License

MIT License

## 🌐 Community

### Community Support

Need help with ScottiBYTE MultiView Server, the Android TV / Fire TV client, Docker deployment, MediaMTX, camera configuration, TV client pairing, or other ScottiBYTE utilities?

Join the ScottiBYTE Rocket.Chat community:

[Join ScottiBYTE Rocket.Chat](https://go.rocket.chat/invite?host=chat.scottibyte.com&path=invite%2FaCh2oW)
