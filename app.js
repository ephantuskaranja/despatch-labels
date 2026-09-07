require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dayjs = require('dayjs');

const { createDb } = require('./db');
const { initSchema } = require('./db-init');
const scale = require('./lib/scale');
const settings = require('./lib/settings');
const labels = require('./lib/labels');
const { renderRequestPdf } = require('./lib/exporters/pdf');
const { buildRequestWorkbook, buildReportWorkbook } = require('./lib/exporters/excel');

const app = express();
const applicationPort = Number(process.env.PORT || 3100);

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static('public'));

let db = null;

function requireDb(req, res, next) {
    if (!db) {
        return res.status(503).json({ success: false, message: 'Database is not connected. Check .env and SQL Server availability.' });
    }
    return next();
}

function handleError(res, error) {
    if (error && error.name === 'ValidationError') {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
    console.error(error);
    return res.status(500).json({ success: false, message: error.message || 'Unexpected server error.' });
}

// --- Scale endpoints -------------------------------------------------------

app.get('/api/get-comport-list', async (req, res) => {
    try {
        const paths = await scale.listComPorts();
        return res.json({ success: true, response: paths });
    } catch (error) {
        return res.status(500).json({ success: false, response: error.message });
    }
});

app.get('/api/scale/stream/:com', (req, res) => scale.handleScaleStream(req, res));

// --- Settings ---------------------------------------------------------------

app.get('/api/settings/crate-weight', requireDb, async (req, res) => {
    try {
        const data = await settings.getCrateSettings(db);
        return res.json({ success: true, data });
    } catch (error) {
        return handleError(res, error);
    }
});

app.put('/api/settings/crate-weight', requireDb, async (req, res) => {
    try {
        const data = await settings.saveCrateSettings(db, req.body, req.body?.updatedBy);
        return res.json({ success: true, data });
    } catch (error) {
        return handleError(res, error);
    }
});

// --- Requests -----------------------------------------------------------

app.post('/api/requests', requireDb, async (req, res) => {
    try {
        const request = await labels.createRequest(db, req.body);
        return res.status(201).json({ success: true, data: request });
    } catch (error) {
        return handleError(res, error);
    }
});

app.get('/api/requests', requireDb, async (req, res) => {
    try {
        const result = await labels.listRequests(db, {
            from: req.query.from,
            to: req.query.to,
            customerName: req.query.customerName,
            requestedBy: req.query.requestedBy,
            airwayBillNo: req.query.airwayBillNo,
            status: req.query.status,
        }, {
            page: req.query.page,
            pageSize: req.query.pageSize,
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return handleError(res, error);
    }
});

app.get('/api/requests/export/excel', requireDb, async (req, res) => {
    try {
        const result = await labels.listRequests(db, {
            from: req.query.from,
            to: req.query.to,
            customerName: req.query.customerName,
            requestedBy: req.query.requestedBy,
            airwayBillNo: req.query.airwayBillNo,
        }, { page: 1, pageSize: 5000 });

        const buffer = buildReportWorkbook(result.data);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="despatch-requests-${dayjs().format('YYYYMMDD-HHmm')}.xlsx"`);
        return res.send(buffer);
    } catch (error) {
        return handleError(res, error);
    }
});

app.get('/api/requests/:id', requireDb, async (req, res) => {
    try {
        const request = await labels.getRequestDetail(db, req.params.id);
        return res.json({ success: true, data: request });
    } catch (error) {
        return handleError(res, error);
    }
});

app.patch('/api/requests/:id', requireDb, async (req, res) => {
    try {
        const request = await labels.updateRequest(db, req.params.id, req.body);
        return res.json({ success: true, data: request });
    } catch (error) {
        return handleError(res, error);
    }
});

app.post('/api/requests/:id/complete', requireDb, async (req, res) => {
    try {
        const request = await labels.completeRequest(db, req.params.id);
        return res.json({ success: true, data: request });
    } catch (error) {
        return handleError(res, error);
    }
});

app.get('/api/requests/:id/pdf', requireDb, async (req, res) => {
    try {
        const request = await labels.getRequestDetail(db, req.params.id);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="despatch-request-${request.id}.pdf"`);
        renderRequestPdf(request, res);
    } catch (error) {
        return handleError(res, error);
    }
});

app.get('/api/requests/:id/excel', requireDb, async (req, res) => {
    try {
        const request = await labels.getRequestDetail(db, req.params.id);
        const buffer = buildRequestWorkbook(request);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="despatch-request-${request.id}.xlsx"`);
        return res.send(buffer);
    } catch (error) {
        return handleError(res, error);
    }
});

// --- Carton lines -----------------------------------------------------------

app.post('/api/requests/:id/lines', requireDb, async (req, res) => {
    try {
        const crateSettings = await settings.getCrateSettings(db);
        const line = await labels.addLine(db, req.params.id, req.body, crateSettings.crateWeightKg);
        return res.status(201).json({ success: true, data: line });
    } catch (error) {
        return handleError(res, error);
    }
});

app.put('/api/requests/:id/lines/:lineId', requireDb, async (req, res) => {
    try {
        const crateSettings = await settings.getCrateSettings(db);
        const line = await labels.updateLine(db, req.params.id, req.params.lineId, req.body, crateSettings.crateWeightKg);
        return res.json({ success: true, data: line });
    } catch (error) {
        return handleError(res, error);
    }
});

app.delete('/api/requests/:id/lines/:lineId', requireDb, async (req, res) => {
    try {
        await labels.deleteLine(db, req.params.id, req.params.lineId);
        return res.json({ success: true });
    } catch (error) {
        return handleError(res, error);
    }
});

app.get('/api/health', (req, res) => {
    res.json({ success: true, dbConnected: Boolean(db), time: new Date().toISOString() });
});

async function initDb() {
    try {
        db = createDb();
        await db.raw('select 1 as connected');
        await initSchema(db);
        console.log('Database connected successfully.');
    } catch (error) {
        db = null;
        console.warn('Database not available. Set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env and restart.');
        console.warn(error.message);
    }
}

async function start() {
    await initDb();
    app.listen(applicationPort, () => {
        console.log(`Despatch Scale Labels app listening on http://localhost:${applicationPort}`);
    });
}

start();

module.exports = app;
