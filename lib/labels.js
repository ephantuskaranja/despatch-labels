// Validation + persistence for despatch label requests and their carton lines.

const dayjs = require('dayjs');

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

function normalizeText(value, { maxLength = 255, required = false, fieldName = 'Field' } = {}) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) {
        if (required) {
            throw new ValidationError(`${fieldName} is required.`);
        }
        return null;
    }
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeDate(value, fieldName) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }
    const parsed = dayjs(value);
    if (!parsed.isValid()) {
        throw new ValidationError(`${fieldName} is not a valid date.`);
    }
    return parsed.format('YYYY-MM-DD');
}

function normalizeHeaderPayload(payload) {
    const source = payload || {};
    return {
        labels_requested_by: normalizeText(source.labelsRequestedBy, { maxLength: 150, required: true, fieldName: 'Labels Requested By' }),
        labels_applied_by: normalizeText(source.labelsAppliedBy, { maxLength: 150 }),
        labels_printed_by: normalizeText(source.labelsPrintedBy, { maxLength: 150, required: true, fieldName: 'Labels Printed By' }),
        customer_name: normalizeText(source.customerName, { maxLength: 200, required: true, fieldName: 'Customer Name' }),
        customer_reference_no: normalizeText(source.customerReferenceNo, { maxLength: 150 }),
        airway_bill_no: normalizeText(source.airwayBillNo, { maxLength: 100 }),
        request_date: normalizeDate(source.requestDate, 'Request Date') || dayjs().format('YYYY-MM-DD'),
    };
}

function normalizeLinePayload(payload, crateWeightKg) {
    const source = payload || {};

    const cartonNo = normalizeText(source.cartonNo, { maxLength: 30, required: true, fieldName: 'Carton No.' });
    const productDescription = normalizeText(source.productDescription, { maxLength: 255, required: true, fieldName: 'Product Description' });

    const grossWeightKg = Number(source.grossWeightKg);
    if (!Number.isFinite(grossWeightKg) || grossWeightKg <= 0) {
        throw new ValidationError('A valid gross weight (captured from the scale, or entered manually) is required.');
    }

    const crateCount = Number.isFinite(Number(source.crateCount)) ? Math.max(0, Math.trunc(Number(source.crateCount))) : 1;
    const crateWeight = Number.isFinite(Number(crateWeightKg)) ? Number(crateWeightKg) : 1.8;
    const netWeightKg = Number((grossWeightKg - (crateCount * crateWeight)).toFixed(2));
    if (netWeightKg <= 0) {
        throw new ValidationError('Net weight must be greater than zero — check the gross weight and crate count.');
    }

    return {
        carton_no: cartonNo,
        product_description: productDescription,
        gross_weight_kg: Number(grossWeightKg.toFixed(2)),
        crate_count: crateCount,
        crate_weight_kg: Number(crateWeight.toFixed(2)),
        net_weight_kg: netWeightKg,
        production_date: normalizeDate(source.productionDate, 'Production Date'),
        expiry_date: normalizeDate(source.expiryDate, 'Expiry Date'),
    };
}

async function createRequest(db, payload) {
    const header = normalizeHeaderPayload(payload);
    const [id] = await db('despatch_requests').insert(header).returning('id');
    const insertedId = (id && typeof id === 'object') ? id.id : id;
    return getRequestDetail(db, insertedId);
}

async function updateRequest(db, id, payload) {
    const request = await db('despatch_requests').where({ id }).first();
    if (!request) {
        throw new ValidationError('Request not found.');
    }
    const header = normalizeHeaderPayload({ ...requestToPayload(request), ...payload });
    await db('despatch_requests').where({ id }).update({ ...header, updated_at: db.fn.now() });
    return getRequestDetail(db, id);
}

function requestToPayload(request) {
    return {
        labelsRequestedBy: request.labels_requested_by,
        labelsAppliedBy: request.labels_applied_by,
        labelsPrintedBy: request.labels_printed_by,
        customerName: request.customer_name,
        customerReferenceNo: request.customer_reference_no,
        airwayBillNo: request.airway_bill_no,
        requestDate: request.request_date,
    };
}

async function assertRequestOpen(db, requestId) {
    const request = await db('despatch_requests').where({ id: requestId }).first();
    if (!request) {
        throw new ValidationError('Request not found.');
    }
    if (request.status !== 'OPEN') {
        throw new ValidationError('This request is already completed and can no longer be edited.');
    }
    return request;
}

async function addLine(db, requestId, payload, crateWeightKg) {
    await assertRequestOpen(db, requestId);
    const line = normalizeLinePayload(payload, crateWeightKg);
    const countRow = await db('despatch_lines').where({ despatch_request_id: requestId }).count({ count: '*' }).first();
    const lineNo = Number(countRow.count || 0) + 1;

    const [id] = await db('despatch_lines').insert({
        despatch_request_id: requestId,
        line_no: lineNo,
        ...line,
    }).returning('id');
    const insertedId = (id && typeof id === 'object') ? id.id : id;

    await db('despatch_requests').where({ id: requestId }).update({ updated_at: db.fn.now() });
    return db('despatch_lines').where({ id: insertedId }).first();
}

async function updateLine(db, requestId, lineId, payload, crateWeightKg) {
    await assertRequestOpen(db, requestId);
    const existing = await db('despatch_lines').where({ id: lineId, despatch_request_id: requestId }).first();
    if (!existing) {
        throw new ValidationError('Carton line not found.');
    }

    const merged = {
        cartonNo: payload.cartonNo ?? existing.carton_no,
        productDescription: payload.productDescription ?? existing.product_description,
        grossWeightKg: payload.grossWeightKg ?? existing.gross_weight_kg,
        crateCount: payload.crateCount ?? existing.crate_count,
        productionDate: payload.productionDate ?? existing.production_date,
        expiryDate: payload.expiryDate ?? existing.expiry_date,
    };
    const line = normalizeLinePayload(merged, crateWeightKg);
    await db('despatch_lines').where({ id: lineId }).update(line);
    await db('despatch_requests').where({ id: requestId }).update({ updated_at: db.fn.now() });
    return db('despatch_lines').where({ id: lineId }).first();
}

async function deleteLine(db, requestId, lineId) {
    await assertRequestOpen(db, requestId);
    await db('despatch_lines').where({ id: lineId, despatch_request_id: requestId }).delete();
    await db('despatch_requests').where({ id: requestId }).update({ updated_at: db.fn.now() });
}

async function completeRequest(db, requestId) {
    const request = await assertRequestOpen(db, requestId);
    const lineCount = await db('despatch_lines').where({ despatch_request_id: requestId }).count({ count: '*' }).first();
    if (Number(lineCount.count || 0) === 0) {
        throw new ValidationError('Add at least one carton line before completing the request.');
    }
    await db('despatch_requests').where({ id: requestId }).update({ status: 'COMPLETED', updated_at: db.fn.now() });
    return getRequestDetail(db, requestId);
}

async function getRequestDetail(db, id) {
    const request = await db('despatch_requests').where({ id }).first();
    if (!request) {
        throw new ValidationError('Request not found.');
    }
    const lines = await db('despatch_lines').where({ despatch_request_id: id }).orderBy('line_no', 'asc');
    return { ...request, lines };
}

async function listRequests(db, filters = {}, pagination = {}) {
    const page = Math.max(1, Number(pagination.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(pagination.pageSize) || 25));

    const query = db('despatch_requests');
    if (filters.from) {
        query.where('request_date', '>=', normalizeDate(filters.from, 'From date'));
    }
    if (filters.to) {
        query.where('request_date', '<=', normalizeDate(filters.to, 'To date'));
    }
    if (filters.customerName) {
        query.where('customer_name', 'like', `%${filters.customerName}%`);
    }
    if (filters.requestedBy) {
        query.where('labels_requested_by', 'like', `%${filters.requestedBy}%`);
    }
    if (filters.airwayBillNo) {
        query.where('airway_bill_no', 'like', `%${filters.airwayBillNo}%`);
    }
    if (filters.status) {
        query.where('status', String(filters.status).toUpperCase());
    }

    const totalRow = await query.clone().count({ count: '*' }).first();
    const rows = await query.clone()
        .orderBy('request_date', 'desc')
        .orderBy('id', 'desc')
        .offset((page - 1) * pageSize)
        .limit(pageSize);

    const requestIds = rows.map((row) => row.id);
    const totals = requestIds.length
        ? await db('despatch_lines')
            .whereIn('despatch_request_id', requestIds)
            .groupBy('despatch_request_id')
            .select('despatch_request_id')
            .count({ lineCount: '*' })
            .sum({ netWeightTotal: 'net_weight_kg' })
        : [];
    const totalsById = new Map(totals.map((row) => [row.despatch_request_id, row]));

    return {
        data: rows.map((row) => ({
            ...row,
            lineCount: Number(totalsById.get(row.id)?.lineCount || 0),
            netWeightTotal: Number(totalsById.get(row.id)?.netWeightTotal || 0),
        })),
        page,
        pageSize,
        total: Number(totalRow.count || 0),
    };
}

module.exports = {
    ValidationError,
    normalizeHeaderPayload,
    normalizeLinePayload,
    createRequest,
    updateRequest,
    addLine,
    updateLine,
    deleteLine,
    completeRequest,
    getRequestDetail,
    listRequests,
};
