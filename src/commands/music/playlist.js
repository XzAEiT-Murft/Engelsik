const { SlashCommandBuilder } = require('discord.js');
const { handlePlayRequest } = require('./play');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playlist')
        .setDescription('Agrega una playlist o coleccion completa a la cola')
        .addStringOption(option =>
            option
                .setName('query')
                .setDescription('URL o nombre de playlist')
                .setRequired(true)
        ),

    execute: handlePlayRequest
};
