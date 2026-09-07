const knexFactory = require('knex');

const dbClient = (process.env.DB_CLIENT || 'mssql').toLowerCase();

function getDbConfig() {
    if (dbClient === 'mysql2') {
        return {
            client: 'mysql2',
            connection: {
                host: process.env.DB_HOST || '127.0.0.1',
                port: Number(process.env.DB_PORT || 3306),
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'despatch_labels',
            },
            pool: { min: 0, max: 10 },
        };
    }

    return {
        client: 'mssql',
        connection: {
            server: process.env.DB_HOST || '127.0.0.1',
            port: Number(process.env.DB_PORT || 1433),
            user: process.env.DB_USER || 'sa',
            password: process.env.DB_PASSWORD || 'YourStrong!Passw0rd',
            database: process.env.DB_NAME || 'despatch_labels',
            options: {
                encrypt: false,
                trustServerCertificate: true,
            },
        },
        pool: { min: 0, max: 10 },
    };
}

function createDb() {
    return knexFactory(getDbConfig());
}

module.exports = {
    createDb,
    getDbConfig,
};
