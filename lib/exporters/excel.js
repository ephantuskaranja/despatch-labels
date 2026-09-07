const XLSX = require('xlsx');
const dayjs = require('dayjs');

function formatDate(value) {
    if (!value) {
        return '';
    }
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('DD/MM/YY') : String(value);
}

/** Builds an .xlsx buffer for a single request (header repeated per carton line). */
function buildRequestWorkbook(request) {
    const rows = (request.lines || []).map((line) => ({
        'Labels Requested By': request.labels_requested_by,
        'Labels Applied By': request.labels_applied_by || '',
        'Labels Printed By': request.labels_printed_by,
        'Customer Name': request.customer_name,
        'Customer Reference No.': request.customer_reference_no || '',
        'Airway Bill No.': request.airway_bill_no || '',
        'Request Date': formatDate(request.request_date),
        'Carton No.': line.carton_no,
        'Product Description': line.product_description,
        'Gross Weight (kg)': Number(line.gross_weight_kg),
        'Crate Count': line.crate_count,
        'Crate Weight (kg)': Number(line.crate_weight_kg),
        'Net Weight (kg)': Number(line.net_weight_kg),
        'Production Date': formatDate(line.production_date),
        'Expiry Date': formatDate(line.expiry_date),
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, `Request ${request.id}`);
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/** Builds an .xlsx buffer for a filtered list of request headers (report summary). */
function buildReportWorkbook(requests) {
    const rows = requests.map((request) => ({
        'Request ID': request.id,
        'Status': request.status,
        'Request Date': formatDate(request.request_date),
        'Labels Requested By': request.labels_requested_by,
        'Labels Applied By': request.labels_applied_by || '',
        'Labels Printed By': request.labels_printed_by,
        'Customer Name': request.customer_name,
        'Customer Reference No.': request.customer_reference_no || '',
        'Airway Bill No.': request.airway_bill_no || '',
        'Carton Lines': request.lineCount,
        'Total Net Weight (kg)': Number(request.netWeightTotal || 0),
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Despatch Requests');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildRequestWorkbook, buildReportWorkbook };
