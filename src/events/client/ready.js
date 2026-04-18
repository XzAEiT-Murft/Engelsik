module.exports = {
    name: 'clientReady',
    once: true,

    execute(client) {
        console.log(`Engelsik conectado como ${client.user.tag}`);

        client.user.setActivity('música en Discord');
    }
};