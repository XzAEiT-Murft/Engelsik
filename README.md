# Engelsik

This is a music bot created by me at the request of some friends. The bot created it while I was drinking, so maybe when I launch it it will have flaws but I hope you like it.

Engelsik is a Discord music bot built with Node.js and discord.js. It supports YouTube playback, queue management, Spotify track and playlist support, and a full set of music commands for Discord servers.

## Features

* Play songs from YouTube by name or URL
* Play YouTube playlists
* Support for Spotify tracks, albums and playlists
* FIFO queue per server
* Pause, resume, skip and stop playback
* Automatic disconnect after 30 seconds of inactivity
* Multi-server support
* Slash commands

## Supported Platforms

* YouTube
* Spotify

Current status for other platforms:

* Apple Music → detected but not yet supported
* Amazon Music → detected but not yet supported

## Commands

| Command     | Description                               |
| ----------- | ----------------------------------------- |
| `/play`     | Play a song or add it to the queue        |
| `/playlist` | Add a playlist to the queue               |
| `/stop`     | Pause the current song                    |
| `/continue` | Resume the paused song                    |
| `/skip`     | Skip the current song                     |
| `/queue`    | Show the current queue                    |
| `/quit`     | Stop playback, clear queue and disconnect |
| `/help`     | Show all available commands               |

## Installation

Clone the repository:

```bash
git clone https://github.com/XzAEiT-Murft/Engelsik
cd Engelsik
```

Install dependencies:

```bash
npm install
```

Create a `.env` file in the root of the project:

```env
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_discord_server_id

SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

## Discord Bot Setup

1. Create an application in the Discord Developer Portal
2. Create a bot inside the application
3. Enable the following bot permissions:

   * Send Messages
   * Connect
   * Speak
   * Use Application Commands
4. Invite the bot to your server

## Spotify Setup

1. Create an app in Spotify for Developers
2. Get your Client ID and Client Secret
3. Add them to your `.env`

Recommended redirect URI:

```text
http://127.0.0.1:3000/callback
```

## Running the Bot

Register slash commands:

```bash
npm run deploy
```

Start the bot:

```bash
npm run dev
```

## Example Usage

```text
/play query: never gonna give you up
/play query: https://www.youtube.com/watch?v=dQw4w9WgXcQ
/playlist query: https://www.youtube.com/playlist?list=...
/play query: https://open.spotify.com/track/...
/playlist query: https://open.spotify.com/playlist/...
```

## Project Structure

```text
src/
├── commands/
│   ├── general/
│   └── music/
├── events/
│   └── client/
├── music/
├── utils/
└── index.js
```

## Technologies Used

* Node.js
* discord.js
* @discordjs/voice
* yt-dlp-wrap
* prism-media
* spotify-url-info
* spotify-web-api-node

## Notes

* Audio playback is performed through YouTube, even when using Spotify links.
* The bot disconnects automatically after 30 seconds if nothing is playing.
* Each Discord server has its own independent queue.

## Future Plans

* Apple Music support
* Amazon Music support
* Volume control
* Shuffle and repeat
* Persistent queues
* Web dashboard
