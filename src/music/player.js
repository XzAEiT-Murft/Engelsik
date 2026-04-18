const prism = require('prism-media');
const {
    joinVoiceChannel,
    entersState,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const {
    resolvePlayableSong,
    getYtDlp
} = require('../utils/platformResolver');

const queues = new Map();

function logDebug(guildId, message, details) {
    const prefix = `[play][guild:${guildId}] ${message}`;

    if (details === undefined) {
        console.log(prefix);
        return;
    }

    console.log(prefix, details);
}

function clearDisconnectTimeout(queue) {
    if (!queue?.timeout) {
        return;
    }

    clearTimeout(queue.timeout);
    queue.timeout = null;
}

function killProcess(queue, guildId) {
    if (!queue?.process || queue.process.killed) {
        queue.process = null;
        return;
    }

    try {
        queue.process.kill();
    } catch (error) {
        console.error(
            `[play][guild:${guildId}] Error cerrando el proceso de yt-dlp:`,
            error
        );
    }

    queue.process = null;
}

function destroyQueue(guildId, options = {}) {
    const { destroyConnection = true } = options;
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    clearDisconnectTimeout(queue);
    killProcess(queue, guildId);

    if (queue.player) {
        queue.player.removeAllListeners();

        try {
            queue.player.stop(true);
        } catch (error) {
            console.error(
                `[play][guild:${guildId}] Error deteniendo el reproductor:`,
                error
            );
        }
    }

    if (queue.connection) {
        queue.connection.removeAllListeners();

        if (destroyConnection) {
            try {
                queue.connection.destroy();
            } catch (error) {
                console.error(
                    `[play][guild:${guildId}] Error destruyendo la conexion:`,
                    error
                );
            }
        }
    }

    queues.delete(guildId);
}

function scheduleDisconnect(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    clearDisconnectTimeout(queue);

    logDebug(
        guildId,
        'La cola quedo vacia, esperando 30 segundos antes de desconectar'
    );

    queue.timeout = setTimeout(() => {
        logDebug(guildId, 'Timeout alcanzado, desconectando Engelsik');
        destroyQueue(guildId);
    }, 30_000);
}

async function startCurrentSong(guildId) {
    const queue = queues.get(guildId);

    if (!queue || !queue.songs.length) {
        scheduleDisconnect(guildId);
        return null;
    }

    const currentSong = queue.songs[0];

    clearDisconnectTimeout(queue);
    killProcess(queue, guildId);

    queue.paused = false;
    await resolvePlayableSong(currentSong, guildId);

    const ytDlp = await getYtDlp();
    const ytDlpExecution = ytDlp.exec(
        [
            currentSong.youtubeUrl,
            '-f',
            'bestaudio[ext=webm]/bestaudio',
            '-o',
            '-',
            '--no-playlist'
        ],
        {
            // yt-dlp-wrap rompe internamente si stderr es null.
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    const ytDlpProcess = ytDlpExecution.ytDlpProcess;

    if (!ytDlpProcess?.stdout) {
        throw new Error('No se pudo obtener stdout del proceso de yt-dlp.');
    }

    queue.process = ytDlpProcess;

    ytDlpExecution.on('close', code => {
        logDebug(guildId, 'Proceso de yt-dlp finalizado', {
            code,
            song: currentSong.title
        });
    });

    ytDlpExecution.on('error', error => {
        console.error(
            `[play][guild:${guildId}] yt-dlp emitio un error:`,
            error
        );
    });

    ytDlpProcess.stdout.removeAllListeners('data');

    // La salida es webm, por eso el demuxer correcto es WebmDemuxer.
    const opusStream = ytDlpProcess.stdout.pipe(
        new prism.opus.WebmDemuxer()
    );

    opusStream.on('error', error => {
        console.error(
            `[play][guild:${guildId}] Error en el demuxer de audio:`,
            error
        );
    });

    logDebug(guildId, 'Stream creado', {
        url: currentSong.youtubeUrl,
        pid: ytDlpProcess.pid
    });

    const resource = createAudioResource(opusStream, {
        inputType: StreamType.Opus,
        inlineVolume: true
    });

    queue.connection.subscribe(queue.player);
    queue.player.play(resource);

    return currentSong;
}

async function playNextAvailableSong(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return null;
    }

    while (queue.songs.length > 0) {
        try {
            return await startCurrentSong(guildId);
        } catch (error) {
            const failedSong = queue.songs.shift();

            console.error(
                `[play][guild:${guildId}] Error iniciando la cancion ${
                    failedSong?.title || '(desconocida)'
                }:`,
                error
            );

            killProcess(queue, guildId);
        }
    }

    scheduleDisconnect(guildId);
    return null;
}

async function handleIdle(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    const finishedSong = queue.songs.shift();
    queue.paused = false;

    killProcess(queue, guildId);

    logDebug(guildId, 'Reproductor en idle', {
        finishedSong: finishedSong?.title || null,
        remaining: queue.songs.length
    });

    if (queue.songs.length > 0) {
        await playNextAvailableSong(guildId);
        return;
    }

    scheduleDisconnect(guildId);
}

function attachQueueListeners(guildId, queue) {
    queue.connection.on(VoiceConnectionStatus.Disconnected, () => {
        logDebug(guildId, 'Conexion de voz desconectada');
        destroyQueue(guildId, { destroyConnection: false });
    });

    queue.player.on(AudioPlayerStatus.Playing, () => {
        logDebug(guildId, 'Reproductor en playing', {
            song: queue.songs[0]?.title || null
        });
    });

    queue.player.on(AudioPlayerStatus.Idle, () => {
        void handleIdle(guildId);
    });

    queue.player.on('error', error => {
        console.error(
            `[play][guild:${guildId}] Error del reproductor:`,
            error
        );
    });
}

async function createQueue(guildId, voiceChannel) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    logDebug(guildId, 'Conexion lista');

    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause
        }
    });

    const queue = {
        connection,
        player,
        process: null,
        songs: [],
        timeout: null,
        paused: false
    };

    attachQueueListeners(guildId, queue);
    queues.set(guildId, queue);

    return queue;
}

async function getOrCreateQueue(guildId, voiceChannel) {
    const existingQueue = queues.get(guildId);

    if (!existingQueue) {
        return createQueue(guildId, voiceChannel);
    }

    const currentChannelId = existingQueue.connection?.joinConfig?.channelId;
    const canMoveBot =
        existingQueue.songs.length === 0 &&
        existingQueue.player?.state?.status === AudioPlayerStatus.Idle;

    if (
        existingQueue.connection?.state?.status === VoiceConnectionStatus.Destroyed
    ) {
        destroyQueue(guildId, { destroyConnection: false });
        return createQueue(guildId, voiceChannel);
    }

    if (currentChannelId && currentChannelId !== voiceChannel.id) {
        if (canMoveBot) {
            destroyQueue(guildId);
            return createQueue(guildId, voiceChannel);
        }

        throw new Error(
            'Debes estar en el mismo canal de voz que Engelsik para usar la cola.'
        );
    }

    return existingQueue;
}

module.exports = {
    queues,
    logDebug,
    getOrCreateQueue,
    playNextAvailableSong,
    scheduleDisconnect,
    clearDisconnectTimeout,
    destroyQueue
};
