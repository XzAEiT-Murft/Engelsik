const fs = require('node:fs');
const path = require('node:path');
const SpotifyWebApi = require('spotify-web-api-node');
const spotifyUrlInfoFactory = require('spotify-url-info');
const YTDlpWrap = require('yt-dlp-wrap').default;

const { getPreview, getTracks, getData } = spotifyUrlInfoFactory(fetch);

const YT_DLP_BINARY_PATH = path.join(
    __dirname,
    '..',
    '..',
    '.cache',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

let ytDlpPromise;
let spotifyApi;
let spotifyTokenPromise;
let spotifyTokenExpiresAt = 0;

function logDebug(guildId, message, details) {
    const prefix = `[play][guild:${guildId}] ${message}`;

    if (details === undefined) {
        console.log(prefix);
        return;
    }

    console.log(prefix, details);
}

function createUserFacingError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function normalizeQuery(query) {
    return query.trim().replace(/^<(.+)>$/, '$1');
}

function safeUrl(query) {
    try {
        return new URL(normalizeQuery(query));
    } catch {
        return null;
    }
}

function detectPlatform(query) {
    const parsedUrl = safeUrl(query);

    if (!parsedUrl) {
        return 'search';
    }

    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();

    if (
        hostname === 'youtube.com' ||
        hostname === 'm.youtube.com' ||
        hostname === 'music.youtube.com' ||
        hostname === 'youtu.be'
    ) {
        return 'youtube';
    }

    if (
        hostname === 'open.spotify.com' ||
        hostname === 'play.spotify.com' ||
        hostname === 'spotify.com'
    ) {
        return 'spotify';
    }

    if (hostname === 'music.apple.com') {
        return 'apple';
    }

    if (
        hostname.includes('music.amazon.') ||
        hostname.includes('amazonmusic.') ||
        (hostname.includes('amazon.') && parsedUrl.pathname.includes('/music'))
    ) {
        return 'amazon';
    }

    return 'search';
}

function isYouTubePlaylistUrl(query) {
    const parsedUrl = safeUrl(query);

    if (!parsedUrl) {
        return false;
    }

    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();

    if (
        hostname !== 'youtube.com' &&
        hostname !== 'm.youtube.com' &&
        hostname !== 'music.youtube.com' &&
        hostname !== 'youtu.be'
    ) {
        return false;
    }

    return (
        parsedUrl.pathname === '/playlist' ||
        parsedUrl.searchParams.has('list')
    );
}

function buildSong({
    title,
    artist = '',
    source,
    youtubeQuery,
    youtubeUrl = null,
    thumbnail = null,
    originalUrl = null,
    durationSeconds = null
}) {
    return {
        title: title || 'Sin titulo',
        artist: artist || '',
        source,
        youtubeQuery: youtubeQuery || `${title || ''} ${artist || ''}`.trim(),
        youtubeUrl,
        thumbnail,
        originalUrl,
        durationSeconds:
            Number.isFinite(durationSeconds) && durationSeconds >= 0
                ? durationSeconds
                : null
    };
}

function attachMetadata(songs, metadata) {
    songs.platform = metadata.platform;
    songs.platformLabel = metadata.platformLabel;
    songs.inputType = metadata.inputType;
    songs.collectionName = metadata.collectionName || null;
    songs.thumbnail = metadata.thumbnail || songs[0]?.thumbnail || null;

    return songs;
}

async function getYtDlp() {
    if (!ytDlpPromise) {
        ytDlpPromise = (async () => {
            try {
                fs.mkdirSync(path.dirname(YT_DLP_BINARY_PATH), {
                    recursive: true
                });

                if (!fs.existsSync(YT_DLP_BINARY_PATH)) {
                    console.log(
                        `[play] Descargando yt-dlp en ${YT_DLP_BINARY_PATH}`
                    );

                    await YTDlpWrap.downloadFromGithub(
                        YT_DLP_BINARY_PATH,
                        undefined,
                        process.platform
                    );

                    if (process.platform !== 'win32') {
                        fs.chmodSync(YT_DLP_BINARY_PATH, 0o755);
                    }
                }

                return new YTDlpWrap(YT_DLP_BINARY_PATH);
            } catch (error) {
                ytDlpPromise = null;
                throw error;
            }
        })();
    }

    return ytDlpPromise;
}

async function getYtDlpJson(args) {
    const ytDlp = await getYtDlp();
    const raw = await ytDlp.execPromise(args);
    return JSON.parse(raw);
}

async function searchYouTubeEntries(query, limit = 1) {
    const result = await getYtDlpJson([
        `ytsearch${limit}:${query}`,
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--skip-download'
    ]);

    return result.entries?.filter(Boolean) || [];
}

async function searchYouTubeEntry(query, limit = 1) {
    const entries = await searchYouTubeEntries(query, limit);
    return entries[0] || null;
}

function buildSongFromYouTubeEntry(entry, fallbackTitle = 'Video de YouTube') {
    return buildSong({
        title: entry.title || fallbackTitle,
        artist: entry.uploader || entry.channel || '',
        source: 'youtube',
        youtubeQuery: `${entry.title || fallbackTitle} ${
            entry.uploader || entry.channel || ''
        }`.trim(),
        youtubeUrl:
            entry.url ||
            (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null),
        thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || null,
        originalUrl:
            entry.url ||
            (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null),
        durationSeconds: entry.duration ?? null
    });
}

async function getYouTubeVideoMetadata(url) {
    return getYtDlpJson([
        url,
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download'
    ]);
}

async function searchYouTubeCandidates(query, limit = 5) {
    const entries = await searchYouTubeEntries(query, limit);
    const songs = entries.map(entry => buildSongFromYouTubeEntry(entry, query));

    if (!songs.length) {
        throw createUserFacingError(
            'No pude encontrar esa busqueda en YouTube.'
        );
    }

    return attachMetadata(songs, {
        platform: 'youtube',
        platformLabel: 'YouTube',
        inputType: 'track',
        collectionName: null,
        thumbnail: songs[0]?.thumbnail || null
    });
}

function parseSpotifyResource(url) {
    const parsedUrl = safeUrl(url);

    if (!parsedUrl) {
        throw createUserFacingError('La URL de Spotify no es valida.');
    }

    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    const resourceIndex =
        ['track', 'album', 'playlist'].includes(pathParts[0]) ? 0 : 1;
    const type = pathParts[resourceIndex];
    const id = pathParts[resourceIndex + 1];

    if (!type || !id) {
        throw createUserFacingError('No pude identificar el recurso de Spotify.');
    }

    return { type, id };
}

async function getSpotifyApi() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return null;
    }

    if (!spotifyApi) {
        spotifyApi = new SpotifyWebApi({
            clientId,
            clientSecret
        });
    }

    if (Date.now() < spotifyTokenExpiresAt && spotifyApi.getAccessToken()) {
        return spotifyApi;
    }

    if (!spotifyTokenPromise) {
        spotifyTokenPromise = spotifyApi
            .clientCredentialsGrant()
            .then(data => {
                spotifyApi.setAccessToken(data.body.access_token);
                spotifyTokenExpiresAt =
                    Date.now() + data.body.expires_in * 1000 - 60_000;
                spotifyTokenPromise = null;
                return spotifyApi;
            })
            .catch(error => {
                spotifyTokenPromise = null;
                throw error;
            });
    }

    return spotifyTokenPromise;
}

async function resolveYoutubeSearch(query) {
    const metadata = await searchYouTubeEntry(query);

    if (!metadata?.url) {
        throw createUserFacingError(
            'No pude encontrar esa busqueda en YouTube.'
        );
    }

    const song = buildSongFromYouTubeEntry(
        {
            ...metadata,
            title: metadata.title || query
        },
        query
    );
    song.youtubeQuery = query;

    return attachMetadata([song], {
        platform: 'youtube',
        platformLabel: 'YouTube',
        inputType: 'track',
        collectionName: null,
        thumbnail: song.thumbnail
    });
}

async function resolveYoutubeVideo(url) {
    const metadata = await getYouTubeVideoMetadata(url);

    const song = buildSong({
        title: metadata.title,
        artist: metadata.uploader || '',
        source: 'youtube',
        youtubeQuery: `${metadata.title || ''} ${metadata.uploader || ''}`.trim(),
        youtubeUrl:
            metadata.webpage_url ||
            (metadata.id
                ? `https://www.youtube.com/watch?v=${metadata.id}`
                : null),
        thumbnail: metadata.thumbnail || null,
        originalUrl: metadata.webpage_url || url,
        durationSeconds: metadata.duration ?? null
    });

    return attachMetadata([song], {
        platform: 'youtube',
        platformLabel: 'YouTube',
        inputType: 'track',
        collectionName: null,
        thumbnail: song.thumbnail
    });
}

async function resolveYoutubePlaylist(url) {
    const playlist = await getYtDlpJson([
        url,
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--skip-download'
    ]);

    const songs = (playlist.entries || [])
        .filter(Boolean)
        .map(entry =>
            buildSong({
                title: entry.title || 'Video de YouTube',
                artist: '',
                source: 'youtube',
                youtubeQuery: entry.title || 'Video de YouTube',
                youtubeUrl:
                    entry.url ||
                    (entry.id
                        ? `https://www.youtube.com/watch?v=${entry.id}`
                        : null),
                thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || null,
                originalUrl:
                    entry.url ||
                    (entry.id
                        ? `https://www.youtube.com/watch?v=${entry.id}`
                        : null),
                durationSeconds: entry.duration ?? null
            })
        );

    if (!songs.length) {
        throw createUserFacingError(
            'No pude obtener canciones de esa playlist de YouTube.'
        );
    }

    return attachMetadata(songs, {
        platform: 'youtube',
        platformLabel: 'YouTube',
        inputType: 'playlist',
        collectionName: playlist.title || 'Playlist de YouTube',
        thumbnail: playlist.thumbnail || songs[0]?.thumbnail || null
    });
}

async function resolveSpotifyTrack(url) {
    const resource = parseSpotifyResource(url);
    const spotifyApi = await getSpotifyApi();

    if (spotifyApi) {
        const track = await spotifyApi.getTrack(resource.id);
        const title = track.body.name;
        const artist = track.body.artists.map(item => item.name).join(', ');
        const thumbnail = track.body.album.images?.[0]?.url || null;

        return attachMetadata(
            [
                buildSong({
                    title,
                    artist,
                    source: 'spotify',
                    youtubeQuery: `${title} ${artist}`.trim(),
                    thumbnail,
                    originalUrl: url
                })
            ],
            {
                platform: 'spotify',
                platformLabel: 'Spotify',
                inputType: 'track',
                collectionName: null,
                thumbnail
            }
        );
    }

    const preview = await getPreview(url);
    const title = preview.track || preview.title || 'Cancion de Spotify';
    const artist = preview.artist || '';

    return attachMetadata(
        [
            buildSong({
                title,
                artist,
                source: 'spotify',
                youtubeQuery: `${title} ${artist}`.trim(),
                thumbnail: preview.image || null,
                originalUrl: url
            })
        ],
        {
            platform: 'spotify',
            platformLabel: 'Spotify',
            inputType: 'track',
            collectionName: null,
            thumbnail: preview.image || null
        }
    );
}

async function resolveSpotifyPlaylist(url) {
    const resource = parseSpotifyResource(url);
    const spotifyApi = await getSpotifyApi();

    if (spotifyApi) {
        const playlistInfo = await spotifyApi.getPlaylist(resource.id);
        const songs = [];
        let offset = 0;
        const total = playlistInfo.body.tracks.total || 0;

        while (offset < total) {
            const tracks = await spotifyApi.getPlaylistTracks(resource.id, {
                limit: 100,
                offset
            });

            for (const item of tracks.body.items) {
                if (!item.track?.name) {
                    continue;
                }

                const title = item.track.name;
                const artist = item.track.artists
                    .map(artistItem => artistItem.name)
                    .join(', ');

                songs.push(
                    buildSong({
                        title,
                        artist,
                        source: 'spotify',
                        youtubeQuery: `${title} ${artist}`.trim(),
                        thumbnail: item.track.album?.images?.[0]?.url || null,
                        originalUrl: item.track.external_urls?.spotify || url
                    })
                );
            }

            offset += tracks.body.items.length;
        }

        if (!songs.length) {
            throw createUserFacingError(
                'No pude obtener canciones de esa playlist de Spotify.'
            );
        }

        return attachMetadata(songs, {
            platform: 'spotify',
            platformLabel: 'Spotify',
            inputType: 'playlist',
            collectionName: playlistInfo.body.name || 'Playlist de Spotify',
            thumbnail: playlistInfo.body.images?.[0]?.url || songs[0]?.thumbnail
        });
    }

    const preview = await getPreview(url);
    const tracks = await getTracks(url);
    const songs = (tracks || [])
        .filter(Boolean)
        .map(track =>
            buildSong({
                title: track.name || track.title || 'Cancion de Spotify',
                artist: track.artist || track.subtitle || '',
                source: 'spotify',
                youtubeQuery: `${track.name || track.title || ''} ${
                    track.artist || track.subtitle || ''
                }`.trim(),
                originalUrl: url
            })
        );

    if (!songs.length) {
        throw createUserFacingError(
            'No pude obtener canciones de esa playlist de Spotify.'
        );
    }

    return attachMetadata(songs, {
        platform: 'spotify',
        platformLabel: 'Spotify',
        inputType: 'playlist',
        collectionName: preview.title || 'Playlist de Spotify',
        thumbnail: preview.image || null
    });
}

async function resolveSpotifyAlbum(url) {
    const resource = parseSpotifyResource(url);
    const spotifyApi = await getSpotifyApi();

    if (spotifyApi) {
        const albumInfo = await spotifyApi.getAlbum(resource.id);
        const songs = [];
        let offset = 0;
        const total = albumInfo.body.tracks.total || 0;

        while (offset < total) {
            const tracks = await spotifyApi.getAlbumTracks(resource.id, {
                limit: 50,
                offset
            });

            for (const item of tracks.body.items) {
                const title = item.name;
                const artist = item.artists
                    .map(artistItem => artistItem.name)
                    .join(', ');

                songs.push(
                    buildSong({
                        title,
                        artist,
                        source: 'spotify',
                        youtubeQuery: `${title} ${artist}`.trim(),
                        thumbnail: albumInfo.body.images?.[0]?.url || null,
                        originalUrl: url
                    })
                );
            }

            offset += tracks.body.items.length;
        }

        if (!songs.length) {
            throw createUserFacingError(
                'No pude obtener canciones de ese album de Spotify.'
            );
        }

        return attachMetadata(songs, {
            platform: 'spotify',
            platformLabel: 'Spotify',
            inputType: 'album',
            collectionName: albumInfo.body.name || 'Album de Spotify',
            thumbnail: albumInfo.body.images?.[0]?.url || songs[0]?.thumbnail
        });
    }

    const albumData = await getData(url);
    const songs = (albumData.trackList || [])
        .filter(Boolean)
        .map(track =>
            buildSong({
                title: track.title || 'Cancion de Spotify',
                artist: track.subtitle || '',
                source: 'spotify',
                youtubeQuery: `${track.title || ''} ${track.subtitle || ''}`.trim(),
                originalUrl: url
            })
        );

    if (!songs.length) {
        throw createUserFacingError(
            'No pude obtener canciones de ese album de Spotify.'
        );
    }

    return attachMetadata(songs, {
        platform: 'spotify',
        platformLabel: 'Spotify',
        inputType: 'album',
        collectionName: albumData.name || albumData.title || 'Album de Spotify',
        thumbnail: null
    });
}

async function resolveSpotifyInput(url) {
    const resource = parseSpotifyResource(url);

    if (resource.type === 'track') {
        return resolveSpotifyTrack(url);
    }

    if (resource.type === 'playlist') {
        return resolveSpotifyPlaylist(url);
    }

    if (resource.type === 'album') {
        return resolveSpotifyAlbum(url);
    }

    throw createUserFacingError(
        'Ese tipo de recurso de Spotify no esta soportado.'
    );
}

async function resolveInput(query) {
    const normalizedQuery = normalizeQuery(query);
    const platform = detectPlatform(normalizedQuery);

    if (platform === 'search') {
        return resolveYoutubeSearch(normalizedQuery);
    }

    if (platform === 'youtube') {
        if (isYouTubePlaylistUrl(normalizedQuery)) {
            return resolveYoutubePlaylist(normalizedQuery);
        }

        return resolveYoutubeVideo(normalizedQuery);
    }

    if (platform === 'spotify') {
        return resolveSpotifyInput(normalizedQuery);
    }

    if (platform === 'apple') {
        throw createUserFacingError(
            'Apple Music todavía no está soportado completamente'
        );
    }

    if (platform === 'amazon') {
        throw createUserFacingError(
            'Amazon Music todavía no está soportado completamente'
        );
    }

    return resolveYoutubeSearch(normalizedQuery);
}

async function resolvePlayableSong(song, guildId) {
    if (song.youtubeUrl) {
        if (
            song.durationSeconds &&
            song.thumbnail &&
            (song.artist || song.source !== 'youtube')
        ) {
            return song;
        }

        const metadata = await getYouTubeVideoMetadata(song.youtubeUrl);

        if (!song.durationSeconds && Number.isFinite(metadata.duration)) {
            song.durationSeconds = metadata.duration;
        }

        if (!song.thumbnail) {
            song.thumbnail =
                metadata.thumbnail || metadata.thumbnails?.[0]?.url || null;
        }

        if (!song.artist) {
            song.artist = metadata.uploader || metadata.channel || '';
        }

        if (!song.originalUrl) {
            song.originalUrl = metadata.webpage_url || song.youtubeUrl;
        }

        return song;
    }

    if (!song.youtubeQuery) {
        throw new Error('La cancion no tiene una consulta valida para YouTube.');
    }

    logDebug(guildId, 'Buscando audio en YouTube', {
        title: song.title,
        artist: song.artist,
        query: song.youtubeQuery
    });

    const metadata = await searchYouTubeEntry(song.youtubeQuery);

    if (!metadata) {
        throw new Error('No pude encontrar una coincidencia en YouTube.');
    }

    song.youtubeUrl =
        metadata.url ||
        (metadata.id
            ? `https://www.youtube.com/watch?v=${metadata.id}`
            : null);

    if (!song.youtubeUrl) {
        throw new Error('No pude encontrar una coincidencia en YouTube.');
    }

    if (!song.thumbnail) {
        song.thumbnail =
            metadata.thumbnails?.[0]?.url || metadata.thumbnail || null;
    }

    if (!song.artist && (metadata.uploader || metadata.channel)) {
        song.artist = metadata.uploader || metadata.channel;
    }

    if (!song.durationSeconds && Number.isFinite(metadata.duration)) {
        song.durationSeconds = metadata.duration;
    }

    return song;
}

module.exports = {
    resolveInput,
    resolvePlayableSong,
    getYtDlp,
    searchYouTubeCandidates
};
