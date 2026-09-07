const PDFDocument = require('pdfkit');
const dayjs = require('dayjs');

function formatDate(value) {
    if (!value) {
        return '-';
    }
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed.format('DD/MM/YY') : String(value);
}

function formatWeight(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(1) : '-';
}

/**
 * Streams a single request (header + carton lines) as a PDF, mirroring the
 * paper "Packing Labels Request Form" layout, to the given writable stream.
 */
function renderRequestPdf(request, res) {
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(16).font('Helvetica-Bold').text('Packing Labels Request Form', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(`Request #${request.id} — ${request.status}`, { align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(1);

    const headerRows = [
        ['Labels Requested By', request.labels_requested_by || '-', 'Request Date', formatDate(request.request_date)],
        ['Labels Applied By', request.labels_applied_by || '-', 'Airway Bill No.', request.airway_bill_no || '-'],
        ['Labels Printed By', request.labels_printed_by || '-', 'Customer Reference No.', request.customer_reference_no || '-'],
        ['Customer Name', request.customer_name || '-', '', ''],
    ];

    doc.fontSize(10).font('Helvetica');
    const labelWidth = 130;
    const colWidth = 145;
    const startX = doc.x;
    for (const [label1, value1, label2, value2] of headerRows) {
        const y = doc.y;
        doc.font('Helvetica-Bold').text(`${label1}:`, startX, y, { width: labelWidth, continued: false });
        doc.font('Helvetica').text(value1, startX + labelWidth, y, { width: colWidth });
        if (label2) {
            doc.font('Helvetica-Bold').text(`${label2}:`, startX + labelWidth + colWidth + 10, y, { width: labelWidth });
            doc.font('Helvetica').text(value2, startX + labelWidth + colWidth + 10 + labelWidth, y, { width: colWidth });
        }
        doc.moveDown(0.6);
    }

    doc.moveDown(0.5);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.5);

    const columns = [
        { key: 'line_no', label: '#', width: 24 },
        { key: 'carton_no', label: 'Carton No.', width: 60 },
        { key: 'product_description', label: 'Product Description', width: 150 },
        { key: 'gross_weight_kg', label: 'Gross (kg)', width: 55 },
        { key: 'crate_count', label: 'Crates', width: 40 },
        { key: 'net_weight_kg', label: 'Net (kg)', width: 55 },
        { key: 'production_date', label: 'Prod. Date', width: 55 },
        { key: 'expiry_date', label: 'Expiry Date', width: 55 },
    ];

    function drawRow(y, values, { bold = false } = {}) {
        let x = doc.page.margins.left;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
        columns.forEach((col, index) => {
            doc.text(String(values[index]), x, y, { width: col.width, align: index === 2 ? 'left' : 'center' });
            x += col.width;
        });
    }

    let y = doc.y;
    drawRow(y, columns.map((col) => col.label), { bold: true });
    y += 16;
    doc.moveTo(doc.page.margins.left, y - 3).lineTo(doc.page.width - doc.page.margins.right, y - 3).strokeColor('#000').stroke();

    let netTotal = 0;
    let grossTotal = 0;
    for (const line of request.lines || []) {
        if (y > doc.page.height - doc.page.margins.bottom - 40) {
            doc.addPage();
            y = doc.page.margins.top;
        }
        drawRow(y, [
            line.line_no,
            line.carton_no,
            line.product_description,
            formatWeight(line.gross_weight_kg),
            line.crate_count,
            formatWeight(line.net_weight_kg),
            formatDate(line.production_date),
            formatDate(line.expiry_date),
        ]);
        netTotal += Number(line.net_weight_kg || 0);
        grossTotal += Number(line.gross_weight_kg || 0);
        y += 15;
    }

    y += 6;
    doc.moveTo(doc.page.margins.left, y - 4).lineTo(doc.page.width - doc.page.margins.right, y - 4).strokeColor('#000').stroke();
    drawRow(y, ['', '', 'TOTAL', formatWeight(grossTotal), '', formatWeight(netTotal), '', ''], { bold: true });

    doc.y = y + 30;
    doc.fontSize(8).font('Helvetica').fillColor('#777')
        .text(`Generated ${dayjs().format('DD/MM/YYYY HH:mm')}`, doc.page.margins.left, doc.y);

    doc.end();
}

module.exports = { renderRequestPdf };
